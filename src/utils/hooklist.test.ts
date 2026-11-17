import { describe, expect, it } from "vitest";
import {
  HOOK_FLAG_NAMES,
  hookFlags,
  hookMetadata,
  hookPermissions,
  lookupHook,
} from "./hooklist";

// Three real Base hooks with very different permission sets. The expected
// flags are what github.com/Uniswap/hooklist publishes for them, so this
// pins the address-bit decoding to an independent source of truth.
const BUNNI = "0x000052423c1db6b7ff8641b85a7eefc7b2791888"; // low bits 0x1888
const DELI = "0x00c9da9abc5303219ead3cf0307b5a8a7644bac8"; //  low bits 0xbac8
const ADV_FEE = "0x03d2434d5a9ab7fb46bd3c7956a7c62e0cd46044"; // low bits 0x6044
const ZERO = "0x0000000000000000000000000000000000000000";

const on = (...names: string[]) =>
  Object.fromEntries(HOOK_FLAG_NAMES.map((n) => [n, names.includes(n)]));

describe("hookPermissions", () => {
  it("reads the low 14 bits of the address", () => {
    expect(hookPermissions(BUNNI)).toBe(0x1888);
    expect(hookPermissions(DELI)).toBe(0xbac8 & 0x3fff);
    expect(hookPermissions(ZERO)).toBe(0);
  });

  it("ignores address case", () => {
    expect(hookPermissions(BUNNI.toUpperCase().replace("0X", "0x"))).toBe(
      hookPermissions(BUNNI)
    );
  });
});

describe("hookFlags", () => {
  it("decodes BunniHook exactly as the hooklist publishes it", () => {
    expect(hookFlags(BUNNI)).toEqual(
      on(
        "afterInitialize",
        "beforeAddLiquidity",
        "beforeSwap",
        "beforeSwapReturnsDelta"
      )
    );
  });

  it("decodes a hook with a broad permission set", () => {
    // 0xbac8 & 0x3fff = 0x3ac8 = 11 1010 1100 1000
    expect(hookFlags(DELI)).toEqual(
      on(
        "beforeInitialize",
        "afterInitialize",
        "beforeAddLiquidity",
        "beforeRemoveLiquidity",
        "beforeSwap",
        "afterSwap",
        "beforeSwapReturnsDelta"
      )
    );
  });

  it("decodes AdvancedFeeHook", () => {
    // 0x6044 & 0x3fff = 0x2044 -> bits 13, 6, 2
    expect(hookFlags(ADV_FEE)).toEqual(
      on("beforeInitialize", "afterSwap", "afterSwapReturnsDelta")
    );
  });

  it("gives the zero address no permissions", () => {
    expect(Object.values(hookFlags(ZERO)).every((v) => v === false)).toBe(true);
  });
});

describe("lookupHook", () => {
  it("finds a listed hook by chain and address", () => {
    expect(lookupHook(8453, BUNNI)?.hook.name).toBe("BunniHook");
  });

  it("is case-insensitive on the address", () => {
    const upper = "0x" + BUNNI.slice(2).toUpperCase();
    expect(lookupHook(8453, upper)?.hook.name).toBe("BunniHook");
  });

  it("keys entries per chain, not just per address", () => {
    // Bunni deploys deterministically, so the same address is listed on
    // several chains — each lookup must return that chain's own entry.
    expect(lookupHook(8453, BUNNI)?.hook.chainId).toBe(8453);
    expect(lookupHook(1, BUNNI)?.hook.chainId).toBe(1);
    expect(lookupHook(99999, BUNNI)).toBeUndefined();
  });

  it("returns undefined for an unlisted hook", () => {
    expect(lookupHook(8453, ZERO)).toBeUndefined();
  });
});

describe("hookMetadata", () => {
  it("merges decoded flags with curated fields for a listed hook", () => {
    const m = hookMetadata(8453, BUNNI);
    expect(m.isListed).toBe(true);
    expect(m.name).toBe("BunniHook");
    expect(m.permissions).toBe(0x1888);
    expect(m.beforeSwap).toBe(true);
    expect(m.afterSwap).toBe(false);
    expect(m.swapAccess).toBe("none");
  });

  it("still decodes flags for an unlisted hook, with curated fields null", () => {
    // A syntactically valid hook address with afterSwap set that is not listed.
    const unlisted = "0x1111111111111111111111111111111111110040";
    const m = hookMetadata(8453, unlisted);
    expect(m.isListed).toBe(false);
    expect(m.name).toBeUndefined();
    expect(m.afterSwap).toBe(true);
    expect(m.beforeSwap).toBe(false);
  });

  it("turns the list's empty strings into null", () => {
    // BunniHook has "" for deployer and auditUrl in the list.
    const m = hookMetadata(8453, BUNNI);
    expect(m.deployer).toBeUndefined();
    expect(m.auditUrl).toBeUndefined();
  });
});
