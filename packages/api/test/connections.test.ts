import { describe, expect, it } from "vitest";
import { ConnectionVault } from "../src/connections.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const validator = (exchange: string) => exchange === "binance" ? ({ validate: async () => ({ valid: true, permissions: { tradingEnabled: true, withdrawalEnabled: false } }) }) : undefined;

describe("ConnectionVault", () => {
  it("returns only masked credentials and keeps secrets decryptable internally", async () => {
    const vault = new ConnectionVault({ encryptionKey, validator });
    const connection = await vault.add({ exchange: "binance", label: "Paper account", apiKey: "abcdefghi1234567", apiSecret: "secret-value" });
    expect(connection.apiKeyMasked).not.toContain("abcdefghi1234567");
    expect(JSON.stringify(vault.list())).not.toContain("secret-value");
    expect(vault.credentials(connection.id)).toEqual({ apiKey: "abcdefghi1234567", apiSecret: "secret-value" });
  });

  it("rejects unsupported exchanges before persisting credentials", async () => {
    const vault = new ConnectionVault({ encryptionKey, validator });
    await expect(vault.add({ exchange: "unsupported", label: "Test", apiKey: "key", apiSecret: "secret" })).rejects.toThrow("not supported");
    expect(vault.list()).toEqual([]);
  });
});
