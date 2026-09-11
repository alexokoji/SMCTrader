/**
 * At-rest encryption for a wallet's private key, using WebCrypto so the same
 * code runs in the Cloudflare Worker and in tests without a Node-only API.
 *
 * A private key is the entire security model of a custodial hot wallet: if
 * this key were ever readable from storage, whoever read it owns the wallet.
 * AES-256-GCM with a fresh random IV per encryption is the standard shape for
 * this; what actually matters is that the encryption key itself never sits
 * beside the ciphertext — it is a dedicated Worker secret
 * (`DEFI_WALLET_ENCRYPTION_KEY`), never the same secret used for request
 * signing (`WORKER_AUTH_SECRET`) or anything else, so a leak of one secret
 * cannot be combined with anything else to reach the plaintext key.
 */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// No DOM lib is loaded for this package (it runs in Node and Workers, never
// a browser), so the WebCrypto types are not ambient here; `crypto` itself is
// still the real global in both runtimes, only its return type is inferred.
async function importKey(base64Key: string) {
  const raw = b64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(`DEFI_WALLET_ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}.`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedSecret {
  iv: string;
  data: string;
}

export async function encryptSecret(plaintext: string, base64Key: string): Promise<EncryptedSecret> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ciphertext)) };
}

export async function decryptSecret(encrypted: EncryptedSecret, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(encrypted.iv) },
    key,
    b64ToBytes(encrypted.data),
  );
  return new TextDecoder().decode(plaintext);
}

/** Generates a fresh, random 32-byte key for `DEFI_WALLET_ENCRYPTION_KEY`, base64-encoded. */
export function generateEncryptionKey(): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}
