import type { ProviderEvent, WalletMethod } from "./protocol.js";

// Channel names are inlined (kept in sync with src/protocol.ts) so this injected
// module stays self-contained with no shared Rollup chunk.
const HELMSMAN_CHANNEL = "helmsman";
const HELMSMAN_REPLY_CHANNEL = "helmsman-reply";
const SOLANA_REQUEST_CHANNEL = "helmsman-solana";
const SOLANA_REPLY_CHANNEL = "helmsman-solana-reply";
const SOLANA_EVENT_CHANNEL = "helmsman-solana-event";

// ---------------------------------------------------------------------------
// Generic request/response bridge over window.postMessage.
// ---------------------------------------------------------------------------

type Reply = { channel: string; id: string; result?: unknown; error?: { message: string } };

function request(channel: string, replyChannel: string, payload: object): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const onMsg = (event: MessageEvent<Reply>) => {
      if (event.source !== window) return;
      if (event.data?.channel !== replyChannel || event.data.id !== id) return;
      window.removeEventListener("message", onMsg);
      if (event.data.error) reject(new Error(event.data.error.message));
      else resolve(event.data.result);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ channel, id, ...payload }, "*");
  });
}

// ---------------------------------------------------------------------------
// window.solana — Solana wallet provider (compatible with the referenced
// Solana extension's request/event API).
// ---------------------------------------------------------------------------

type Listener = (data: unknown) => void;

class SolanaProvider {
  readonly isClawd = true;
  readonly isHelmsman = true; // alias for older Helmsman sites
  readonly isSolana = true;
  publicKey: string | null = null;
  private listeners = new Map<ProviderEvent, Set<Listener>>();

  constructor() {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== SOLANA_EVENT_CHANNEL) return;
      const event_ = data.event as ProviderEvent;
      if (event_ === "accountsChanged") {
        const accounts = (data.data as string[]) ?? [];
        this.publicKey = accounts[0] ?? null;
      }
      this.emit(event_, data.data);
    });
  }

  request = (args: { method: WalletMethod; params?: unknown }): Promise<unknown> => {
    return request(SOLANA_REQUEST_CHANNEL, SOLANA_REPLY_CHANNEL, {
      method: args.method,
      params: args.params,
    });
  };

  // Phantom-style convenience.
  async connect(): Promise<{ publicKey: string | null }> {
    const resp = (await this.request({
      method: "wallet_requestAccounts",
      params: { promptAuthorization: true },
    })) as { accounts: string[] };
    this.publicKey = resp.accounts?.[0] ?? null;
    this.emit("stateChanged", { state: "unlocked" });
    return { publicKey: this.publicKey };
  }

  async getState(): Promise<{ state: string }> {
    return (await this.request({ method: "wallet_getState" })) as { state: string };
  }

  async getCluster(): Promise<unknown> {
    return this.request({ method: "wallet_getCluster" });
  }

  async signMessage(message: string): Promise<{ publicKey: string; signature: string }> {
    return (await this.request({
      method: "wallet_signMessage",
      params: { message },
    })) as { publicKey: string; signature: string };
  }

  // Computer-use: hand a client-built transaction (base64, legacy or versioned)
  // to the wallet to sign and broadcast. Returns the transaction signature.
  async signAndSendTransaction(transactionBase64: string): Promise<{ signature: string }> {
    return (await this.request({
      method: "wallet_signAndSendTransaction",
      params: { transaction: transactionBase64 },
    })) as { signature: string };
  }

  // Sign a base64 transaction WITHOUT broadcasting; returns signed base64.
  // Used for the Jupiter Ultra order -> sign -> /execute flow.
  async signTransaction(transactionBase64: string): Promise<{ signedTransaction: string }> {
    return (await this.request({
      method: "wallet_signTransactionB64",
      params: { transaction: transactionBase64 },
    })) as { signedTransaction: string };
  }

  async sendSol(to: string, sol: number): Promise<{ signature: string }> {
    return (await this.request({
      method: "wallet_sendSol",
      params: { to, sol },
    })) as { signature: string };
  }

  async getBalance(address?: string): Promise<{ address: string; lamports: number; sol: number }> {
    return (await this.request({
      method: "wallet_getBalance",
      params: { address },
    })) as { address: string; lamports: number; sol: number };
  }

  on(event: ProviderEvent, cb: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  off(event: ProviderEvent, cb: Listener): void {
    this.listeners.get(event)?.delete(cb);
  }

  private emit(event: ProviderEvent, data: unknown): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(data);
      } catch {
        /* ignore listener errors */
      }
    });
  }
}

const solana = new SolanaProvider();
Object.defineProperty(window, "solana", { value: solana, writable: false, configurable: true });
window.dispatchEvent(new Event("solana#initialized"));

// ---------------------------------------------------------------------------
// window.helmsman — agent control surface (preserved) + x402 auto-pay hook.
// ---------------------------------------------------------------------------

function helmsmanCall(msg: unknown): Promise<unknown> {
  return request(HELMSMAN_CHANNEL, HELMSMAN_REPLY_CHANNEL, { msg });
}

// window.helmsman — agent/computer-use control surface. Wallet actions are
// backed by the real Solana provider so an autonomous agent (e.g. in a
// computer-use session) can read accounts, sign, and transact programmatically.
// Pair with the extension's "Computer-use / Agent mode" to auto-approve.
const clawd = {
  name: "Clawd",
  version: "0.3.0",
  native: "solana",
  isClawd: true,
  isHelmsman: true, // backward compatible
  get publicKey() {
    return solana.publicKey;
  },
  solana,
  // --- Agent control surface ---
  async connect() {
    return solana.connect();
  },
  async getState() {
    return solana.getState();
  },
  async getAccounts(): Promise<string[]> {
    const resp = (await solana.request({
      method: "wallet_requestAccounts",
      params: { promptAuthorization: true },
    })) as { accounts: string[] };
    return resp.accounts ?? [];
  },
  async getBalance(address?: string) {
    return solana.getBalance(address);
  },
  async signAndSendTransaction(transactionBase64: string) {
    return solana.signAndSendTransaction(transactionBase64);
  },
  async sendSol(to: string, sol: number) {
    return solana.sendSol(to, sol);
  },
  // --- Clawd / Helmsman API relays ---
  async snapshot() {
    return helmsmanCall({ type: "computer" });
  },
  // Agent eyes: capture the current tab and get a vision-based trade suggestion.
  async see(note?: string) {
    return helmsmanCall({ type: "vision", payload: { note } });
  },
  async signMessage(message: string, chain = "solana") {
    if (chain === "solana") return solana.signMessage(message);
    return helmsmanCall({ type: "sign", payload: { chain, message } });
  },
  async pay(url: string, method = "GET", body?: string) {
    return helmsmanCall({ type: "pay", payload: { url, method, body } });
  },
};

Object.defineProperty(window, "clawd", { value: clawd, writable: false, configurable: true });
Object.defineProperty(window, "helmsman", { value: clawd, writable: false, configurable: true });
window.dispatchEvent(new Event("clawd#initialized"));
window.dispatchEvent(new Event("helmsman#initialized"));

// x402: transparently pay-and-retry on HTTP 402 responses.
const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await originalFetch(input, init);
  if (res.status !== 402) return res;
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const paid = (await clawd.pay(
    url,
    (init?.method as string) ?? "GET",
    typeof init?.body === "string" ? init.body : undefined,
  )) as { error?: string };
  if (paid?.error) return res;
  return originalFetch(input, init);
};
