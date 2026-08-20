import { describe, expect, it } from "vitest";
import {
  TRADING_ACCOUNT_DEFAULTS,
  accountFieldsMissing,
  withAccountDefaults,
} from "../src/auth.js";

/**
 * `$setOnInsert` only populates a field when a document is first created, so
 * accounts made by an earlier build lack fields added later. Handing those
 * straight to the dashboard sent `assets: undefined` to the Worker, which
 * rejected every page load with "assets must be a string array".
 */
describe("trading account defaults", () => {
  it("fills in assets for an account created before the field existed", () => {
    const account = withAccountDefaults({ userId: "u-1" });
    expect(account.assets).toEqual([...TRADING_ACCOUNT_DEFAULTS.assets]);
    expect(Array.isArray(account.assets)).toBe(true);
    expect(account.assets.length).toBeGreaterThan(0);
  });

  it("treats an empty asset list as missing, since the Worker rejects it", () => {
    expect(accountFieldsMissing({ userId: "u-1", assets: [] })).toContain("assets");
    expect(withAccountDefaults({ userId: "u-1", assets: [] }).assets).toEqual([
      ...TRADING_ACCOUNT_DEFAULTS.assets,
    ]);
  });

  it("preserves a configured asset list", () => {
    const account = withAccountDefaults({ userId: "u-1", assets: ["LINKUSDT", "BTCUSDT"] });
    expect(account.assets).toEqual(["LINKUSDT", "BTCUSDT"]);
    expect(accountFieldsMissing({ userId: "u-1", assets: ["LINKUSDT"] })).not.toContain("assets");
  });

  it("fills every other field a legacy document may lack", () => {
    const account = withAccountDefaults({ userId: "u-1" });
    expect(account.startingEquity).toBe(TRADING_ACCOUNT_DEFAULTS.startingEquity);
    expect(account.paperEquity).toBe(TRADING_ACCOUNT_DEFAULTS.paperEquity);
    expect(account.mode).toBe(TRADING_ACCOUNT_DEFAULTS.mode);
    expect(account.risk).toEqual({ ...TRADING_ACCOUNT_DEFAULTS.risk });
  });

  it("reports exactly which fields need repairing", () => {
    expect(accountFieldsMissing({ userId: "u-1" }).sort()).toEqual(
      ["assets", "mode", "paperEquity", "risk", "startingEquity"].sort(),
    );
    expect(
      accountFieldsMissing({
        userId: "u-1",
        startingEquity: 10_000,
        paperEquity: 9_500,
        mode: "PAPER",
        assets: ["BTCUSDT"],
        risk: { riskPerTrade: 1 },
      }),
    ).toEqual([]);
  });

  it("keeps a zero paper equity, which is a real balance not a missing one", () => {
    expect(accountFieldsMissing({ userId: "u-1", paperEquity: 0 })).not.toContain("paperEquity");
    expect(withAccountDefaults({ userId: "u-1", paperEquity: 0 }).paperEquity).toBe(0);
  });
});
