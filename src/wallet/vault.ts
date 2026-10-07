// Password-encrypted vault for the wallet mnemonic, using WebCrypto
// (PBKDF2-SHA256 -> AES-GCM). Serves the same purpose as the reference
// extension's tweetnacl secretbox vault, using the platform crypto available
// in an MV3 service worker.

export type EncryptedVault = {
  v: 1;
  kdf: "PBKDF2";
  digest: "SHA-256";
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
};

const ITERATIONS = 200_000;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault(
  plaintext: string,
  password: string,
): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return {
    v: 1,
    kdf: "PBKDF2",
    digest: "SHA-256",
    iterations: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ct),
  };
}

export async function decryptVault(
  vault: EncryptedVault,
  password: string,
): Promise<string> {
  const key = await deriveKey(password, fromB64(vault.salt), vault.iterations);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(vault.iv) as BufferSource },
      key,
      fromB64(vault.ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Incorrect password");
  }
}
