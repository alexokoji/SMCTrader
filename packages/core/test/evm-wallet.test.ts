import { describe, expect, it } from "vitest";
import {
  addressFromPrivateKey,
  buildSwapPath,
  checkGasCap,
  checkTradeCap,
  generateWallet,
  isNative,
  isValidAddress,
  minAmountOut,
} from "../src/defi/evm-wallet.js";
import { CHAINS } from "../src/defi/chains.js";

const eth = CHAINS.ethereum;
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const RANDOM_TOKEN = "0x1111111111111111111111111111111111111e";

describe("wallet generation", () => {
  it("generates a wallet whose address is derived from its own private key", () => {
    const wallet = generateWallet();
    expect(isValidAddress(wallet.address)).toBe(true);
    expect(addressFromPrivateKey(wallet.privateKey)).toBe(wallet.address);
  });

  it("never generates the same private key twice", () => {
    const a = generateWallet();
    const b = generateWallet();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.address).not.toBe(b.address);
  });
});

describe("swap path construction", () => {
  it("routes token-for-token through the wrapped native token", () => {
    const path = buildSwapPath(eth, PEPE, RANDOM_TOKEN);
    expect(path).toEqual([PEPE, eth.wrappedNativeAddress, RANDOM_TOKEN]);
  });

  it("does not add an extra hop when one side is already the wrapped native token", () => {
    const path = buildSwapPath(eth, PEPE, eth.wrappedNativeAddress);
    expect(path).toEqual([PEPE, eth.wrappedNativeAddress]);
  });

  it("substitutes the wrapped native address for the native sentinel", () => {
    const path = buildSwapPath(eth, "native", PEPE);
    expect(path[0]!.toLowerCase()).toBe(eth.wrappedNativeAddress.toLowerCase());
  });

  it("recognises the native sentinel case-insensitively", () => {
    expect(isNative("NATIVE")).toBe(true);
    expect(isNative(PEPE)).toBe(false);
  });
});

describe("slippage", () => {
  it("reduces the quoted output by the configured basis points", () => {
    expect(minAmountOut(10_000n, 100)).toBe(9_900n); // 1%
    expect(minAmountOut(10_000n, 500)).toBe(9_500n); // 5%
  });

  it("returns the full amount at zero slippage tolerance", () => {
    expect(minAmountOut(10_000n, 0)).toBe(10_000n);
  });

  it("refuses a slippage tolerance outside a sane range", () => {
    expect(() => minAmountOut(10_000n, 6_000)).toThrow(/sane/);
    expect(() => minAmountOut(10_000n, -1)).toThrow(/sane/);
  });
});

describe("trade cap", () => {
  it("allows a trade within the cap", () => {
    expect(checkTradeCap(500, 1_000).ok).toBe(true);
  });

  it("blocks a trade over the cap, with the amounts in the reason", () => {
    const result = checkTradeCap(1_500, 1_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/1500\.00/);
    expect(result.reason).toMatch(/1000\.00/);
  });
});

describe("gas cap", () => {
  it("allows gas at or below the cap", () => {
    // 20 gwei in wei
    expect(checkGasCap(20_000_000_000n, 20).ok).toBe(true);
  });

  it("blocks a gas price above the cap", () => {
    const result = checkGasCap(50_000_000_000n, 20);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/50 gwei/);
  });
});
