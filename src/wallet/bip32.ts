import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";

// Minimal BIP32 (SLIP-0032-style secp256k1) private derivation, matching the
// reference extension which uses `bip32.fromSeed(seed).derivePath("m/44'/501'/i'/0'")`
// and feeds the resulting 32-byte private key into ed25519 (nacl / Keypair.fromSeed).
// The referenced Solana wallet derives ed25519 keys from BIP32 (secp256k1) private
// keys, NOT SLIP-0010. Reproducing that exactly keeps account addresses identical.

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED_OFFSET = 0x80000000;

type Node = { key: Uint8Array; chainCode: Uint8Array };

function bytesToBigInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

function bigIntTo32Bytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (index >>> 24) & 0xff;
  out[1] = (index >>> 16) & 0xff;
  out[2] = (index >>> 8) & 0xff;
  out[3] = index & 0xff;
  return out;
}

function masterFromSeed(seed: Uint8Array): Node {
  const I = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ckdPrivHardened(parent: Node, index: number): Node {
  // Hardened child: data = 0x00 || ser256(kpar) || ser32(index)
  const data = new Uint8Array(1 + 32 + 4);
  data.set(parent.key, 1);
  data.set(ser32(index), 33);
  const I = hmac(sha512, parent.chainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  const parsedIL = bytesToBigInt(IL);
  const kpar = bytesToBigInt(parent.key);
  const ki = (parsedIL + kpar) % SECP256K1_N;
  return { key: bigIntTo32Bytes(ki), chainCode: IR };
}

/**
 * Derive the 32-byte private key for the given BIP32 path from a BIP39 seed.
 * Only hardened segments (ending in ') are required for the Solana path
 * `m/44'/501'/i'/0'`, matching the referenced extension's derivation.
 */
export function derivePathPrivateKey(seed: Uint8Array, path: string): Uint8Array {
  let node = masterFromSeed(seed);
  const segments = path
    .split("/")
    .slice(1)
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    const hardened = segment.endsWith("'") || segment.endsWith("h");
    const raw = parseInt(hardened ? segment.slice(0, -1) : segment, 10);
    if (Number.isNaN(raw)) throw new Error(`Invalid path segment: ${segment}`);
    if (!hardened) {
      throw new Error(
        `Non-hardened derivation is not supported (segment: ${segment})`,
      );
    }
    node = ckdPrivHardened(node, raw + HARDENED_OFFSET);
  }
  return node.key;
}

export const solanaDerivationPath = (accountIndex: number): string =>
  `m/44'/501'/${accountIndex}'/0'`;
