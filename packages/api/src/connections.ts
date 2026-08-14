import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { AccountPermissions } from "@smc/core";
import { BinanceExecutionAdapter } from "@smc/core";
import { hashString } from "@smc/core";
import type { Collection } from "mongodb";

export type ExchangeKind = "binance" | "bybit" | "okx" | "unknown";

export interface ConnectionInput {
  exchange: ExchangeKind | string;
  label: string;
  apiKey: string;
  apiSecret: string;
}

export interface ExchangeConnection {
  id: string;
  exchange: string;
  label: string;
  apiKeyMasked: string;
  status: "connected" | "error";
  permissions: AccountPermissions;
  withdrawalWarning: boolean;
  createdAt: number;
  lastError?: string;
}

export interface CredentialValidatorResult {
  valid: boolean;
  permissions: AccountPermissions;
  message?: string;
}

export interface CredentialValidator {
  validate(input: { apiKey: string; apiSecret: string }): Promise<CredentialValidatorResult>;
}

export interface StoredExchangeConnection {
  id: string;
  exchange: string;
  label: string;
  apiKeyMasked: string;
  apiKeyEnc: string;
  apiKeyIv: string;
  apiSecretEnc: string;
  apiSecretIv: string;
  permissions: AccountPermissions;
  createdAt: number;
}

/**
 * Stores exchange API credentials encrypted at rest with AES-256-GCM.
 * Secrets are never persisted, logged, or returned to the frontend after the
 * initial secure submission (sections 7 and 63). A plaintext key (base64, 32
 * bytes) must be provided via `SMC_ENCRYPTION_KEY` or the constructor.
 */
export class ConnectionVault {
  private store: Map<string, StoredExchangeConnection> = new Map();
  private readonly key: Buffer;
  private readonly validator: (exchange: string) => CredentialValidator | undefined;
  private readonly onAudit?: (event: {
    action: string;
    exchange: string;
    label: string;
    detail: string;
  }) => void;

  constructor(opts: {
    validator?: (exchange: string) => CredentialValidator | undefined;
    encryptionKey?: string;
    collection?: Collection<StoredExchangeConnection>;
    onAudit?: ConnectionVault["onAudit"];
  }) {
    const raw =
      opts.encryptionKey ??
      process.env.SMC_ENCRYPTION_KEY ??
      process.env.CREDENTIAL_ENCRYPTION_KEY;
    this.requireKey(raw);
    this.key = Buffer.from(raw!, "base64");
    this.validator =
      opts.validator ??
      ((exchange) => {
        if (exchange === "binance") {
          return {
            validate: async ({ apiKey, apiSecret }) => {
              const adapter = new BinanceExecutionAdapter({ apiKey, apiSecret });
              const res = await adapter.validateCredentials();
              return res;
            },
          };
        }
        return undefined;
      });
    this.onAudit = opts.onAudit;
    this.collection = opts.collection;
  }

  private readonly collection?: Collection<StoredExchangeConnection>;

  /** Restores encrypted credentials into the in-process lookup cache at startup. */
  async hydrate(): Promise<void> {
    if (!this.collection) return;
    const records = await this.collection.find({}).toArray();
    this.store = new Map(records.map((record) => [record.id, record]));
  }

  private requireKey(raw: string | undefined): void {
    if (!raw) {
      throw new Error(
        "A base64 32-byte encryption key is required to store exchange credentials (SMC_ENCRYPTION_KEY).",
      );
    }
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error("SMC_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    }
  }

  /** Validate + encrypt + persist a new exchange connection. */
  async add(input: ConnectionInput): Promise<ExchangeConnection> {
    const exchange = input.exchange.toLowerCase();
    const validator = this.validator(exchange);
    if (!validator) {
      throw new Error(`Exchange "${exchange}" is not supported yet. Kept unconnected.`);
    }
    if (!input.apiKey || !input.apiSecret) {
      throw new Error("API key and secret are required.");
    }
    if (!input.label) throw new Error("A label is required.");

    // Danger check before touching the network: only the first few and last
    // few characters of the key are ever kept in memory-derived form.
    const masked = maskKey(input.apiKey);
    let result: CredentialValidatorResult;
    try {
      result = await validator.validate({ apiKey: input.apiKey, apiSecret: input.apiSecret });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onAudit?.({
        action: "CONNECTION_VALIDATION_FAILED",
        exchange,
        label: input.label,
        detail: message,
      });
      throw new Error(`Credential validation failed: ${message}`);
    }

    if (!result.valid) {
      const detail = result.message ?? "Credentials rejected by the exchange.";
      this.onAudit?.({
        action: "CONNECTION_VALIDATION_FAILED",
        exchange,
        label: input.label,
        detail,
      });
      throw new Error(`Invalid credentials: ${detail}`);
    }

    const id = `conn-${hashString(`${exchange}:${input.apiKey}:${Date.now()}`)}`;
    const keyEnc = this.encrypt(input.apiKey);
    const secretEnc = this.encrypt(input.apiSecret);
    const rec: StoredExchangeConnection = {
      id,
      exchange,
      label: input.label,
      apiKeyMasked: masked,
      apiKeyEnc: keyEnc.data,
      apiKeyIv: keyEnc.iv,
      apiSecretEnc: secretEnc.data,
      apiSecretIv: secretEnc.iv,
      permissions: result.permissions,
      createdAt: Date.now(),
    };
    this.store.set(id, rec);
    if (this.collection) await this.collection.insertOne(rec);

    this.onAudit?.({
      action: "CONNECTION_ADDED",
      exchange,
      label: input.label,
      detail: `Connected (trading=${result.permissions.tradingEnabled}, withdrawal=${result.permissions.withdrawalEnabled}).`,
    });

    return this.toPublic(rec);
  }

  list(): ExchangeConnection[] {
    return [...this.store.values()].map((r) => this.toPublic(r));
  }

  async remove(id: string): Promise<boolean> {
    const rec = this.store.get(id);
    if (!rec) return false;
    this.store.delete(id);
    if (this.collection) await this.collection.deleteOne({ id });
    this.onAudit?.({
      action: "CONNECTION_REMOVED",
      exchange: rec.exchange,
      label: rec.label,
      detail: "Disconnected and credentials purged.",
    });
    return true;
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  /** Secret material is only available through the decrypt path - never returned by list/add. */
  credentials(id: string): { apiKey: string; apiSecret: string } | undefined {
    const rec = this.store.get(id);
    if (!rec) return undefined;
    return {
      apiKey: this.decrypt(rec.apiKeyIv, rec.apiKeyEnc),
      apiSecret: this.decrypt(rec.apiSecretIv, rec.apiSecretEnc),
    };
  }

  private toPublic(rec: StoredExchangeConnection): ExchangeConnection {
    return {
      id: rec.id,
      exchange: rec.exchange,
      label: rec.label,
      apiKeyMasked: rec.apiKeyMasked,
      status: "connected",
      permissions: rec.permissions,
      withdrawalWarning: rec.permissions.withdrawalEnabled === true,
      createdAt: rec.createdAt,
    };
  }

  private encrypt(plaintext: string): { iv: string; data: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("hex"), data: Buffer.concat([data, tag]).toString("hex") };
  }

  private decrypt(ivHex: string, dataHex: string): string {
    const iv = Buffer.from(ivHex, "hex");
    const raw = Buffer.from(dataHex, "hex");
    const data = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) return `${"*".repeat(key.length)}`;
  return `${key.slice(0, 4)}…${"*".repeat(6)}${key.slice(-4)}`;
}

export { hashString };
