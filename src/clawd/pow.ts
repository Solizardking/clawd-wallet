// Proof-of-work solver for the Clawd Chain faucet (port of clawd-chain extension/pow.js).
// The faucet issues {challenge, bits}; we find a nonce so that
// sha256(`${challenge}:${nonce}`) has at least `bits` leading zero bits.
import { sha256 } from "@noble/hashes/sha256";

const encoder = new TextEncoder();

export function powHash(message: string | Uint8Array): Uint8Array {
  return sha256(typeof message === "string" ? encoder.encode(message) : message);
}

export function leadingZeros(bytes: Uint8Array): number {
  let n = 0;
  for (const x of bytes) {
    if (x === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(x) - 24;
    break;
  }
  return n;
}

export type PowStep = { nonce: number; best: number };
export type PowResult = { nonce: number; hash: Uint8Array; best: number };

export async function solvePow(
  challenge: string,
  bits: number,
  hooks: { every?: number; onStep?: (s: PowStep) => void; maxNonce?: number } = {},
): Promise<PowResult> {
  const every = hooks.every && hooks.every > 0 ? hooks.every | 0 : 4096;
  const target = bits | 0;
  if (target < 0 || target > 40) throw new Error("Faucet difficulty out of range");
  const max = hooks.maxNonce ?? Number.MAX_SAFE_INTEGER;
  const prefix = `${challenge}:`;
  let nonce = 0;
  let best = 0;
  while (nonce < max) {
    const end = Math.min(nonce + every, max);
    for (; nonce < end; nonce++) {
      const hash = powHash(prefix + nonce);
      const zeros = leadingZeros(hash);
      if (zeros > best) best = zeros;
      if (zeros >= target) return { nonce, hash, best };
    }
    hooks.onStep?.({ nonce, best });
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("Proof of work not found");
}
