import { Keypair } from "@solana/web3.js";
import * as bip39 from "bip39";
import { Buffer } from "buffer";
import { derivePathPrivateKey, solanaDerivationPath } from "./bip32.js";

export type DerivedAccount = {
  index: number;
  address: string;
  keypair: Keypair;
};

/** Generate a fresh 12-word BIP39 mnemonic using the platform CSPRNG. */
export function generateMnemonic(): string {
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);
  return bip39.entropyToMnemonic(Buffer.from(entropy));
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic.trim());
}

/** BIP39 mnemonic -> 64-byte seed (hex), matching the reference wallet. */
export function mnemonicToSeedHex(mnemonic: string): string {
  return bip39.mnemonicToSeedSync(mnemonic.trim()).toString("hex");
}

/**
 * Derive a Solana keypair for `accountIndex` from a hex seed, using the same
 * BIP32 path (`m/44'/501'/i'/0'`) and ed25519-from-BIP32-private-key scheme as
 * the referenced Solana extension.
 */
export function deriveAccount(seedHex: string, accountIndex: number): DerivedAccount {
  const seed = Uint8Array.from(Buffer.from(seedHex, "hex"));
  const privateKey = derivePathPrivateKey(seed, solanaDerivationPath(accountIndex));
  const keypair = Keypair.fromSeed(privateKey);
  return { index: accountIndex, address: keypair.publicKey.toBase58(), keypair };
}

export function deriveAccounts(seedHex: string, count: number): DerivedAccount[] {
  const accounts: DerivedAccount[] = [];
  for (let i = 0; i < count; i++) accounts.push(deriveAccount(seedHex, i));
  return accounts;
}
