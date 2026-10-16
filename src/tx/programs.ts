// Known Solana programs and mints, plus small instruction decoders used by the
// transaction preview. Original Clawd code.

export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
export const STAKE = "Stake11111111111111111111111111111111111111";

export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM]: "System Program",
  [TOKEN]: "Token Program",
  [TOKEN_2022]: "Token-2022",
  [ATA]: "Associated Token Account",
  [COMPUTE_BUDGET]: "Compute Budget",
  [BPF_UPGRADEABLE]: "BPF Upgradeable Loader",
  [STAKE]: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: "Jupiter Aggregator v4",
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: "Jupiter Limit Order",
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: "Jupiter DCA",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
};

export const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: "wSOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", decimals: 5 },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC (devnet)", decimals: 6 },
};

export const U64_MAX = 18446744073709551615n;

export function u32(d: Uint8Array, o: number): number {
  return d.length >= o + 4 ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000 : -1;
}
export function u64(d: Uint8Array, o: number): bigint | null {
  if (d.length < o + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}

export type IxKind =
  | "transfer" | "create_account" | "assign" | "advance_nonce" | "nonce_authority" | "allocate"
  | "token_transfer" | "token_approve" | "token_revoke" | "set_authority" | "close_account"
  | "mint_to" | "burn" | "init_account" | "cu_limit" | "cu_price" | "heap" | "loader_upgrade"
  | "loader_set_authority" | "loader_close" | "stake_authorize" | "ata_create" | "memo" | "other";

export type Decoded = {
  kind: IxKind;
  summary: string;
  lamports?: bigint;
  amount?: bigint;
  from?: string;
  to?: string;
  owner?: string;
  newOwner?: string;
  value?: bigint;
};

const sol = (l: bigint) => `${Number(l) / 1e9} SOL`;

/** Decode the instructions the preview cares about. `keys` are the ix's account addresses. */
export function decodeInstruction(programId: string, keys: string[], data: Uint8Array): Decoded {
  if (programId === SYSTEM) {
    const d = u32(data, 0);
    switch (d) {
      case 0: {
        const lamports = u64(data, 4) ?? 0n;
        return { kind: "create_account", lamports, from: keys[0], to: keys[1], summary: `Create account ${keys[1] ?? "?"} funded with ${sol(lamports)}` };
      }
      case 1: return { kind: "assign", owner: keys[0], summary: `Assign account ${keys[0]} to a new owner program` };
      case 2: case 11: {
        const lamports = u64(data, 4) ?? 0n;
        const [from, to] = d === 2 ? [keys[0], keys[1]] : [keys[0], keys[2]];
        return { kind: "transfer", lamports, from, to, summary: `Transfer ${sol(lamports)} to ${to ?? "?"}` };
      }
      case 3: return { kind: "create_account", from: keys[0], to: keys[1], summary: "Create account with seed" };
      case 4: return { kind: "advance_nonce", summary: `Advance durable nonce ${keys[0] ?? ""}` };
      case 5: return { kind: "transfer", lamports: u64(data, 4) ?? 0n, from: keys[0], to: keys[1], summary: "Withdraw from nonce account" };
      case 7: return { kind: "nonce_authority", summary: "Change nonce account authority" };
      case 8: case 9: return { kind: "allocate", summary: "Allocate account space" };
      case 10: return { kind: "assign", owner: keys[0], summary: `Assign account ${keys[0]} (with seed) to a new owner program` };
    }
  }
  if (programId === TOKEN || programId === TOKEN_2022) {
    const d = data[0];
    switch (d) {
      case 1: case 16: case 18: return { kind: "init_account", summary: "Initialize token account" };
      case 3: return { kind: "token_transfer", amount: u64(data, 1) ?? 0n, from: keys[0], to: keys[1], owner: keys[2], summary: `Token transfer to ${keys[1] ?? "?"}` };
      case 12: return { kind: "token_transfer", amount: u64(data, 1) ?? 0n, from: keys[0], to: keys[2], owner: keys[3], summary: `Token transfer to ${keys[2] ?? "?"}` };
      case 4: case 13: {
        const amount = u64(data, 1) ?? 0n;
        const delegate = d === 4 ? keys[1] : keys[2];
        const owner = d === 4 ? keys[2] : keys[3];
        return { kind: "token_approve", amount, to: delegate, owner, from: keys[0], summary: `Approve delegate ${delegate ?? "?"} to spend ${amount === U64_MAX ? "UNLIMITED" : amount.toString()} raw units` };
      }
      case 5: return { kind: "token_revoke", summary: "Revoke token delegate" };
      case 6: return { kind: "set_authority", owner: keys[1], summary: `Change authority of ${keys[0] ?? "?"}` };
      case 7: case 14: return { kind: "mint_to", summary: "Mint tokens" };
      case 8: case 15: return { kind: "burn", amount: u64(data, 1) ?? 0n, summary: "Burn tokens" };
      case 9: return { kind: "close_account", from: keys[0], to: keys[1], owner: keys[2], summary: `Close token account ${keys[0] ?? "?"}; rent goes to ${keys[1] ?? "?"}` };
    }
  }
  if (programId === COMPUTE_BUDGET) {
    if (data[0] === 2) { const v = BigInt(u32(data, 1)); return { kind: "cu_limit", value: v, summary: `Compute unit limit ${v}` }; }
    if (data[0] === 3) { const v = u64(data, 1) ?? 0n; return { kind: "cu_price", value: v, summary: `Priority fee ${v} micro-lamports/CU` }; }
    if (data[0] === 1) return { kind: "heap", summary: "Request heap frame" };
  }
  if (programId === ATA) return { kind: "ata_create", summary: `Create associated token account ${keys[1] ?? ""}` };
  if (programId === BPF_UPGRADEABLE) {
    const d = u32(data, 0);
    if (d === 3) return { kind: "loader_upgrade", summary: "Upgrade program" };
    if (d === 4 || d === 7) return { kind: "loader_set_authority", summary: "Change program upgrade authority" };
    if (d === 5) return { kind: "loader_close", from: keys[0], to: keys[1], summary: "Close program/buffer account" };
  }
  if (programId === STAKE && u32(data, 0) === 1) return { kind: "stake_authorize", summary: "Change stake account authority" };
  if (programId.startsWith("Memo")) {
    try { return { kind: "memo", summary: `Memo: ${new TextDecoder("utf-8", { fatal: true }).decode(data).slice(0, 120)}` }; } catch { /* fallthrough */ }
  }
  return { kind: "other", summary: "" };
}

/** Parse an SPL token account (Token or Token-2022) from raw data. */
export function parseTokenAccount(programOwner: string, data: Uint8Array):
  | { mint: string; owner: string; amount: bigint; delegate: string | null; delegatedAmount: bigint }
  | null {
  if ((programOwner !== TOKEN && programOwner !== TOKEN_2022) || data.length < 165) return null;
  if (programOwner === TOKEN_2022 && data.length > 165 && data[165] !== 2) return null; // not an Account
  if (programOwner === TOKEN && data.length !== 165) return null;
  const hasDelegate = u32(data, 72) === 1;
  return {
    mint: b58(data.subarray(0, 32)),
    owner: b58(data.subarray(32, 64)),
    amount: u64(data, 64) ?? 0n,
    delegate: hasDelegate ? b58(data.subarray(76, 108)) : null,
    delegatedAmount: u64(data, 121) ?? 0n,
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const byte of bytes) { if (byte !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
