import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "../src/defi/wallet-crypto.js";

describe("wallet key encryption", () => {
  it("round-trips a private key through encryption", async () => {
    const key = generateEncryptionKey();
    const plaintext = "0x" + "ab".repeat(32);
    const encrypted = await encryptSecret(plaintext, key);
    expect(await decryptSecret(encrypted, key)).toBe(plaintext);
  });

  it("never stores the plaintext inside the encrypted payload", async () => {
    const key = generateEncryptionKey();
    const plaintext = "0x" + "cd".repeat(32);
    const encrypted = await encryptSecret(plaintext, key);
    expect(encrypted.data).not.toContain(plaintext);
    expect(JSON.stringify(encrypted)).not.toContain("cdcdcd");
  });

  it("uses a fresh IV on every call, so the same key never produces the same ciphertext twice", async () => {
    const key = generateEncryptionKey();
    const a = await encryptSecret("same-secret", key);
    const b = await encryptSecret("same-secret", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("fails to decrypt with the wrong key rather than returning garbage silently", async () => {
    const encrypted = await encryptSecret("secret", generateEncryptionKey());
    await expect(decryptSecret(encrypted, generateEncryptionKey())).rejects.toThrow();
  });

  it("rejects a key that does not decode to 32 bytes", async () => {
    await expect(encryptSecret("secret", btoa("too-short"))).rejects.toThrow(/32 bytes/);
  });

  it("generates a key that decodes to exactly 32 bytes", () => {
    const key = generateEncryptionKey();
    const decoded = atob(key);
    expect(decoded.length).toBe(32);
  });
});
