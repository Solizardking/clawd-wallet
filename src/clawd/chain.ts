// Clawd Chain support (port of clawd-chain extension/wallet.js + background.js).
// Clawd Chain is its own SVM test chain (genesis 4ZVXGevaJv4La9KmXVSoXMDi53s3M2CCadzSwXudVa5y),
// not Solana mainnet. Native coin CLAWD has no monetary value.
// Keys are the wallet's existing vault-derived accounts; nothing secret leaves the device.
import nacl from "tweetnacl";
import type { Keypair } from "@solana/web3.js";
import { accountRows, parseMintAccount, resolveHoldings, type Holding } from "./names.js";
import { solvePow } from "./pow.js";

export const CLAWD_CLUSTER = "clawd";
export const CLAWD_RPC = "https://rpc.clawdchain.trade";
export const CLAWD_FAUCET = "https://faucet.clawdchain.trade";
export const CLAWD_API = "https://api.clawdchain.trade";
export const CLAWD_EXPLORER = "https://explorer.clawdchain.trade";
export const CLAWD_GENESIS_HASH = "4ZVXGevaJv4La9KmXVSoXMDi53s3M2CCadzSwXudVa5y";
export const CLAWD_NOTICE =
  "CLAWD has no monetary value. Clawd Chain is a public SVM test playground, not Solana mainnet.";
export const CLAWD_SHIELD_RESET =
  "The shield pool was reset. The 1.99 test CLAWD in the old pool stays stuck.";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const LAMPORTS = 1_000_000_000n;

export function explorerAddressUrl(address: string): string {
  return `${CLAWD_EXPLORER}/address/${encodeURIComponent(address)}`;
}

export function formatClawd(lamports: number | bigint | string): string {
  const n = BigInt(lamports || 0);
  const whole = n / LAMPORTS;
  const frac = (n % LAMPORTS).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(CLAWD_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "Clawd RPC error");
  return json.result as T;
}

export async function listHoldings(address: string): Promise<Holding[]> {
  const rows = [];
  for (const programId of TOKEN_PROGRAMS) {
    try {
      rows.push(...accountRows(await rpc("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }])));
    } catch {
      /* program may be unsupported */
    }
  }
  const byMint: Record<string, string | null> = {};
  for (const r of rows) {
    if (r.mint in byMint) continue;
    try {
      byMint[r.mint] = parseMintAccount(await rpc("getAccountInfo", [r.mint, { encoding: "jsonParsed" }]));
    } catch {
      byMint[r.mint] = null;
    }
  }
  return resolveHoldings(rows, byMint);
}

export type ClawdOverview = {
  address: string;
  lamports: number;
  clawd: string;
  holdings: Holding[];
  explorerUrl: string;
  shieldReset: string;
};

export async function clawdOverview(address: string): Promise<ClawdOverview> {
  const bal = await rpc<{ value?: number }>("getBalance", [address]);
  const lamports = bal?.value ?? 0;
  let holdings: Holding[] = [];
  try {
    holdings = await listHoldings(address);
  } catch {
    holdings = [];
  }
  return { address, lamports, clawd: formatClawd(lamports), holdings, explorerUrl: explorerAddressUrl(address), shieldReset: CLAWD_SHIELD_RESET };
}

/** Faucet: fetch challenge, solve PoW locally, post nonce. 5 CLAWD/wallet/day. */
export async function requestFaucet(address: string): Promise<{ signature: string; amount?: unknown }> {
  const issued = (await (await fetch(`${CLAWD_FAUCET}/challenge`)).json()) as { challenge?: unknown; bits?: unknown };
  if (typeof issued?.challenge !== "string" || typeof issued.bits !== "number") throw new Error("Faucet error");
  const { nonce } = await solvePow(issued.challenge, issued.bits);
  const res = await fetch(`${CLAWD_FAUCET}/airdrop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, challenge: issued.challenge, nonce }),
  });
  const body = (await res.json()) as { signature?: string; amount?: unknown; error?: string };
  if (!body?.signature) throw new Error(body?.error ?? "Faucet error");
  return { signature: body.signature, amount: body.amount };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ClawdSignedTransfer = {
  sender: string;
  recipient: string;
  amount: string;
  network: "clawd";
  payload: string;
  signature: string; // hex Ed25519 over payload
  publicKey: string; // base58
};

/** Signs {sender, recipient, amount, network:"clawd"} locally. Does NOT broadcast. */
export function buildSignedTransfer(keypair: Keypair, recipient: string, amount: string | number): ClawdSignedTransfer {
  const to = String(recipient ?? "").trim();
  if (!to) throw new Error("Recipient required");
  const amt = String(amount);
  if (!amt || !Number.isFinite(Number(amt)) || Number(amt) <= 0) throw new Error("Amount must be positive");
  const sender = keypair.publicKey.toBase58();
  const payload = JSON.stringify({ sender, recipient: to, amount: amt, network: "clawd" });
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), keypair.secretKey);
  return { sender, recipient: to, amount: amt, network: "clawd", payload, signature: toHex(sig), publicKey: sender };
}
