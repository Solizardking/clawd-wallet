// Wallet Standard adapter for Clawd Wallet.
// Original Clawd code (no Backpack/GPL code). Uses the Apache-2.0 packages
// @wallet-standard/* and @solana/wallet-standard-features; see THIRD_PARTY_NOTICES.
//
// Every feature routes through the legacy provider bridge, so the background
// service worker enforces the same per-origin authorization and popup approval
// for each connect/sign/send as window.solana does.
import type { Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardConnectMethod,
  StandardDisconnectFeature,
  StandardDisconnectMethod,
  StandardEventsFeature,
  StandardEventsListeners,
  StandardEventsNames,
  StandardEventsOnMethod,
} from "@wallet-standard/features";
import type {
  SolanaSignAndSendTransactionFeature,
  SolanaSignAndSendTransactionMethod,
  SolanaSignAndSendTransactionOutput,
  SolanaSignInFeature,
  SolanaSignInInput,
  SolanaSignInMethod,
  SolanaSignInOutput,
  SolanaSignMessageFeature,
  SolanaSignMessageMethod,
  SolanaSignMessageOutput,
  SolanaSignTransactionFeature,
  SolanaSignTransactionMethod,
  SolanaSignTransactionOutput,
} from "@solana/wallet-standard-features";
import { CLAWD_ICON } from "./wallet-standard-icon.js";

export const SOLANA_MAINNET = "solana:mainnet";
export const SOLANA_DEVNET = "solana:devnet";
export const SOLANA_TESTNET = "solana:testnet";
// Clawd Chain ("clawd") and custom RPCs have no registered Wallet Standard
// chain id, so they are intentionally NOT advertised.
export const SUPPORTED_CHAINS = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

const CLUSTER_TO_CHAIN: Record<string, SupportedChain> = {
  "mainnet-beta": SOLANA_MAINNET,
  devnet: SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
};
export function chainForCluster(cluster: string | undefined): SupportedChain | null {
  return (cluster && CLUSTER_TO_CHAIN[cluster]) || null;
}

/** Minimal surface of the in-page legacy provider that this adapter needs. */
export interface ClawdBridge {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, cb: (data: unknown) => void): void;
}

// ---- tiny codecs (kept local so injected.js shares no chunk) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = []; // little-endian
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let lead = 0;
  while (lead < s.length && s[lead] === "1") lead++;
  return new Uint8Array([...new Array<number>(lead).fill(0), ...bytes.reverse()]);
}
function toBase64(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out;
}
function copyBytes(v: Uint8Array): Uint8Array {
  // realm-safe copy (iframe Uint8Arrays fail instanceof)
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
}

const FEATURES_ON_ACCOUNT = [
  "solana:signAndSendTransaction",
  "solana:signTransaction",
  "solana:signMessage",
  "solana:signIn",
] as const;

function makeAccount(address: string): WalletAccount {
  return Object.freeze({
    address,
    publicKey: base58Decode(address),
    chains: SUPPORTED_CHAINS,
    features: FEATURES_ON_ACCOUNT,
  }) as WalletAccount;
}

export class ClawdStandardWallet implements Wallet {
  readonly version = "1.0.0" as const;
  readonly name = "Clawd Wallet";
  readonly icon = CLAWD_ICON as WalletIcon;
  readonly chains = SUPPORTED_CHAINS;
  #accounts: WalletAccount[] = [];
  #listeners: { [E in StandardEventsNames]?: StandardEventsListeners[E][] } = {};
  #bridge: ClawdBridge;

  constructor(bridge: ClawdBridge) {
    this.#bridge = bridge;
    bridge.on("accountsChanged", (data) => {
      // Only set accounts we already exposed (after an approved connect). The
      // background only sends this event to authorized origins anyway.
      if (!this.#accounts.length) return;
      this.#setAccounts(Array.isArray(data) ? (data as string[]) : []);
    });
    bridge.on("disconnected", () => this.#setAccounts([]));
  }

  get accounts(): readonly WalletAccount[] { return this.#accounts.slice(); }

  get features(): StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature &
    SolanaSignAndSendTransactionFeature & SolanaSignTransactionFeature & SolanaSignMessageFeature & SolanaSignInFeature {
    return {
      "standard:connect": { version: "1.0.0", connect: this.#connect },
      "standard:disconnect": { version: "1.0.0", disconnect: this.#disconnect },
      "standard:events": { version: "1.0.0", on: this.#on },
      "solana:signAndSendTransaction": {
        version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: this.#signAndSend,
      },
      "solana:signTransaction": {
        version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: this.#signTransaction,
      },
      "solana:signMessage": { version: "1.0.0", signMessage: this.#signMessage },
      "solana:signIn": { version: "1.0.0", signIn: this.#signIn },
    };
  }

  #setAccounts(addresses: string[]) {
    const prev = this.#accounts.map((a) => a.address).join();
    this.#accounts = addresses.map(makeAccount);
    if (prev !== addresses.join()) this.#emit("change", { accounts: this.accounts });
  }

  #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>) {
    this.#listeners[event]?.forEach((l) => { try { (l as (...a: unknown[]) => void)(...args); } catch { /* ignore */ } });
  }

  #on: StandardEventsOnMethod = (event, listener) => {
    const list = (this.#listeners[event] ||= []) as unknown[];
    list.push(listener);
    return () => {
      (this.#listeners as Record<string, unknown[]>)[event] = list.filter((l) => l !== listener);
    };
  };

  #connect: StandardConnectMethod = async (input) => {
    // silent => only succeeds for origins the user already approved (no popup).
    const resp = (await this.#bridge.request({
      method: "wallet_requestAccounts",
      params: { promptAuthorization: !input?.silent },
    })) as { accounts?: string[] };
    this.#setAccounts(resp.accounts ?? []);
    return { accounts: this.accounts };
  };

  #disconnect: StandardDisconnectMethod = async () => {
    try { await this.#bridge.request({ method: "wallet_disconnect" }); }
    finally { this.#setAccounts([]); }
  };

  #requireAccount(account: WalletAccount): void {
    if (!this.#accounts.some((a) => a.address === account?.address)) throw new Error("Account not connected");
  }
  #requireChain(chain: string | undefined): void {
    if (chain !== undefined && !(SUPPORTED_CHAINS as readonly string[]).includes(chain)) {
      throw new Error(`Unsupported chain: ${chain}`);
    }
  }

  #signTransaction: SolanaSignTransactionMethod = async (...inputs) => {
    for (const input of inputs) {
      this.#requireAccount(input.account);
      this.#requireChain(input.chain);
    }
    const encoded = inputs.map((i) => toBase64(copyBytes(i.transaction)));
    if (encoded.length === 1) {
      const r = (await this.#bridge.request({ method: "wallet_signTransactionB64", params: { transaction: encoded[0] } })) as { signedTransaction: string };
      return [{ signedTransaction: fromBase64(r.signedTransaction) }];
    }
    // Several inputs = one batched approval (signAllTransactions).
    const r = (await this.#bridge.request({ method: "wallet_signAllTransactionsB64", params: { transactions: encoded } })) as { signedTransactions: string[] };
    return r.signedTransactions.map((t): SolanaSignTransactionOutput => ({ signedTransaction: fromBase64(t) }));
  };

  #signAndSend: SolanaSignAndSendTransactionMethod = async (...inputs) => {
    const out: SolanaSignAndSendTransactionOutput[] = [];
    for (const input of inputs) {
      this.#requireAccount(input.account);
      this.#requireChain(input.chain);
      // The wallet broadcasts on its selected network; refuse a mismatch so a
      // dApp never sends to a chain it did not ask for (e.g. Clawd Chain).
      const net = (await this.#bridge.request({ method: "wallet_getCluster" })) as { cluster?: string };
      const active = chainForCluster(net?.cluster);
      if (active !== input.chain) {
        throw new Error(`Wallet network is ${active ?? net?.cluster ?? "unknown"}, transaction is for ${input.chain}. Switch network in Clawd Wallet.`);
      }
      const o = input.options ?? {};
      const options = {
        skipPreflight: o.skipPreflight,
        preflightCommitment: o.preflightCommitment,
        maxRetries: o.maxRetries,
        minContextSlot: o.minContextSlot,
        commitment: o.commitment,
      };
      const r = (await this.#bridge.request({
        method: "wallet_signAndSendTransaction",
        params: { transaction: toBase64(copyBytes(input.transaction)), options },
      })) as { signature: string };
      out.push({ signature: base58Decode(r.signature) });
    }
    return out;
  };

  #signMessage: SolanaSignMessageMethod = async (...inputs) => {
    const out: SolanaSignMessageOutput[] = [];
    for (const input of inputs) {
      this.#requireAccount(input.account);
      const message = copyBytes(input.message);
      // Arbitrary bytes; the wallet shows UTF-8 when valid, else hex.
      const r = (await this.#bridge.request({
        method: "wallet_signMessage",
        params: { messageB64: toBase64(message), signer: input.account.address },
      })) as { signature: string };
      out.push({ signedMessage: message, signature: base58Decode(r.signature), signatureType: "ed25519" });
    }
    return out;
  };

  #signIn: SolanaSignInMethod = async (...inputs) => {
    const out: SolanaSignInOutput[] = [];
    for (const input of inputs) {
      // The wallet builds the SIWS text and rejects a domain that does not
      // match the requesting page.
      const r = (await this.#bridge.request({ method: "wallet_signIn", params: { input: { ...input } } })) as {
        address: string; signedMessageB64: string; signature: string;
      };
      if (!this.#accounts.some((a) => a.address === r.address)) {
        const resp = (await this.#bridge.request({ method: "wallet_requestAccounts", params: { promptAuthorization: false } })) as { accounts?: string[] };
        this.#setAccounts(resp.accounts ?? [r.address]);
      }
      const account = this.#accounts.find((a) => a.address === r.address) ?? makeAccount(r.address);
      out.push({ account, signedMessage: fromBase64(r.signedMessageB64), signature: base58Decode(r.signature), signatureType: "ed25519" });
    }
    return out;
  };
}
