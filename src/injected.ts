import type { ProviderEvent, WalletMethod } from "./protocol.js";
import { registerWallet } from "@wallet-standard/wallet";
import { ClawdStandardWallet } from "./wallet-standard.js";

// Channel names are inlined (kept in sync with src/protocol.ts) so this injected
// module stays self-contained with no shared Rollup chunk.
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
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.channel !== replyChannel || event.data.id !== id) return;
      window.removeEventListener("message", onMsg);
      if (event.data.error) reject(new Error(event.data.error.message));
      else resolve(event.data.result);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ channel, id, ...payload }, window.location.origin);
  });
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
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
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.channel !== SOLANA_EVENT_CHANNEL) return;
      const event_ = data.event as ProviderEvent;
      if (event_ === "disconnected") this.publicKey = null;
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

  async signMessage(message: string | Uint8Array): Promise<{ publicKey: string; signature: string }> {
    // Strings are signed as UTF-8. Bytes (any content, including binary) are
    // signed exactly as given; the wallet shows UTF-8 text when valid, else hex.
    if (typeof message === "string") {
      return (await this.request({ method: "wallet_signMessage", params: { message } })) as { publicKey: string; signature: string };
    }
    if (!ArrayBuffer.isView(message)) throw { code: -32602, message: "signMessage expects a string or Uint8Array" };
    // Realm-safe copy: iframe-created Uint8Arrays fail `instanceof` here.
    const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    return (await this.request({
      method: "wallet_signMessage",
      params: { messageB64: bytesToB64(bytes) },
    })) as { publicKey: string; signature: string };
  }

  // Sign-In With Solana. The wallet builds the message and checks the domain.
  async signIn(input: Record<string, unknown> = {}): Promise<{ address: string; signedMessageB64: string; signature: string }> {
    return (await this.request({ method: "wallet_signIn", params: { input } })) as { address: string; signedMessageB64: string; signature: string };
  }

  // Computer-use: hand a client-built transaction (base64, legacy or versioned)
  // to the wallet to sign and broadcast. Returns the transaction signature.
  async signAndSendTransaction(transactionBase64: string, options?: Record<string, unknown>): Promise<{ signature: string }> {
    return (await this.request({
      method: "wallet_signAndSendTransaction",
      params: { transaction: transactionBase64, options },
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

  // Sign several base64 transactions in one approval (batched preview).
  async signAllTransactions(transactionsBase64: string[]): Promise<{ signedTransactions: string[] }> {
    return (await this.request({
      method: "wallet_signAllTransactionsB64",
      params: { transactions: transactionsBase64 },
    })) as { signedTransactions: string[] };
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
// window.clawd / window.helmsman — aliases for consent-gated Solana requests.
// ---------------------------------------------------------------------------

function legacyDisabled(): never {
  throw Object.assign(new Error("Legacy backend commands are disabled until a secure per-request consent flow is implemented. Use the Solana provider for wallet requests."), { code: 4200 });
}

// window.helmsman — agent/computer-use control surface. Wallet actions are
// backed by the Solana provider. Connection, signing and transfers require
// wallet approval. Legacy backend relays remain disabled.
const clawd = {
  name: "Clawd",
  // No version/settings/network fields: they would make the wallet fingerprintable.
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
    return legacyDisabled();
  },
  // Reserved until a secure consent flow exists; no screenshot is captured.
  async see(note?: string) {
    return legacyDisabled();
  },
  async signMessage(message: string, chain = "solana") {
    if (chain === "solana") return solana.signMessage(message);
    return legacyDisabled();
  },
  async pay(url: string, method = "GET", body?: string) {
    return legacyDisabled();
  },
};

Object.defineProperty(window, "clawd", { value: clawd, writable: false, configurable: true });
Object.defineProperty(window, "helmsman", { value: clawd, writable: false, configurable: true });
window.dispatchEvent(new Event("clawd#initialized"));
window.dispatchEvent(new Event("helmsman#initialized"));

// HTTP 402 responses remain untouched. Payments need an explicit consent flow.

// ---------------------------------------------------------------------------
// Wallet Standard registration. Runs synchronously at document_start (MAIN
// world content script). registerWallet() both dispatches
// "wallet-standard:register-wallet" and listens for "wallet-standard:app-ready",
// so dApps that load before or after the wallet both discover it.
// ---------------------------------------------------------------------------
registerWallet(new ClawdStandardWallet(solana));
