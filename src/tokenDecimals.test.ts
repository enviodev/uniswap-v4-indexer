/**
 * Unit tests for token `decimals` resolution.
 *
 * `decimals` is the one piece of token metadata that is not cosmetic: it is a
 * divisor. Substituting 18 for a real 6 mis-scales every amount derived from
 * that token by 10^12 — a plausible wrong number, not an error, which is
 * exactly what a snapshot test cannot catch (see positionGuards.test.ts).
 *
 * Two things are pinned here:
 *  - the CACHE gate: a `decimals()` failure must never be persisted, whatever
 *    `name()` and `symbol()` did. Envio's effect cache is keyed on the input and
 *    survives restarts and a full resync, so one cached substitution is
 *    permanent;
 *  - the FLAG: `decimalsResolved` tells a consumer whether an 18 was read or
 *    guessed, and it has to reach the Token entity to be worth anything.
 *
 * Deliberately NOT tested, because the mechanisms no longer exist: an
 * eth_getCode probe that classified a failure as permanent (a lagging replica
 * answers "0x" for a live contract with no error, and code can still land at a
 * codeless address later), and an in-place upgrade of an unresolved row (it
 * cannot repair the amounts already derived from the guess, and it makes the
 * same block range replay to different values).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const ADDRESS = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;
const CHAIN = 42161;

/** Every ERC-20 read the multicall makes, each independently controllable. */
interface Reads {
  name: () => Promise<unknown>;
  NAME: () => Promise<unknown>;
  symbol: () => Promise<unknown>;
  SYMBOL: () => Promise<unknown>;
  decimals: () => Promise<unknown>;
}

const ok = <T,>(v: T) => () => Promise.resolve(v);
const reverts = () => () => Promise.reject(new Error("execution reverted"));

const HEALTHY: Reads = {
  name: ok("USD Coin"),
  NAME: reverts(),
  symbol: ok("USDC"),
  SYMBOL: reverts(),
  decimals: ok(6),
};

describe("decimals resolution — the flag and the cache gate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function load(reads: Reads) {
    vi.doMock("viem", () => ({
      createPublicClient: () => ({}),
      http: () => ({}),
      getContract: () => ({ read: reads }),
    }));
    return await import("./utils/tokenMetadata");
  }

  /** Stand-in for the effect context: only `cache` and `log.warn` are used. */
  function ctx() {
    return { cache: true, log: { warn: vi.fn() } };
  }

  it("reports a clean read as resolved, and caches it", async () => {
    const { fetchTokenMetadataMulticall } = await load(HEALTHY);

    const context = ctx();
    const meta = await fetchTokenMetadataMulticall(ADDRESS, CHAIN, context);

    expect(meta.decimals).toBe(6);
    expect(meta.decimalsResolved).toBe(true);
    expect(context.cache).toBe(true);
  });

  it("REFUSES to cache a decimals() failure, and flags the 18 as a guess", async () => {
    const { fetchTokenMetadataMulticall } = await load({
      ...HEALTHY,
      decimals: reverts(),
    });

    const context = ctx();
    const meta = await fetchTokenMetadataMulticall(ADDRESS, CHAIN, context);

    // The defect this gate closed: the gate was a three-way AND, so a transient
    // decimals() failure with name()/symbol() succeeding — as here — WAS cached.
    // The effect cache is persisted and keyed on the input, so the substituted
    // 18 survived restarts and a full resync, mis-scaling every derived amount
    // by 10^(18 - real) from then on.
    expect(context.cache).toBe(false);
    expect(meta.decimals).toBe(18);
    expect(meta.decimalsResolved).toBe(false);
    // Nothing about the address is treated as a permanent verdict: there is no
    // branch that caches an unresolved decimals, so nothing to assert around.
    expect(context.log.warn).toHaveBeenCalled();
  });

  it("still resolves when only name and symbol failed", async () => {
    const { fetchTokenMetadataMulticall } = await load({
      name: reverts(),
      NAME: reverts(),
      symbol: reverts(),
      SYMBOL: reverts(),
      decimals: ok(6),
    });

    const context = ctx();
    const meta = await fetchTokenMetadataMulticall(ADDRESS, CHAIN, context);

    // decimals() answered, so the number is real and the flag says so — even
    // though the all-reads-failed rule still keeps the cosmetic fallbacks out of
    // the cache.
    expect(meta.decimals).toBe(6);
    expect(meta.decimalsResolved).toBe(true);
    expect(meta.name).toBe("unknown");
    expect(meta.symbol).toBe("UNKNOWN");
    expect(context.cache).toBe(false);
  });

  it("substitutes 18 for an absurd decimals, and calls it resolved", async () => {
    const { fetchTokenMetadataMulticall } = await load({
      ...HEALTHY,
      decimals: ok(200),
    });

    const context = ctx();
    const meta = await fetchTokenMetadataMulticall(ADDRESS, CHAIN, context);

    // The contract answered; 18 is the canonical treatment of a value that would
    // crash the indexer, not a guess about an unknown. Deterministic, so
    // cacheable — re-reading it would return the same 200 forever.
    expect(meta.decimals).toBe(18);
    expect(meta.decimalsResolved).toBe(true);
    expect(context.cache).toBe(true);
  });
});

describe("decimalsResolved reaches the Token entity", () => {
  /*
   * The flag is worthless if it stops at the effect. There is no way to invoke
   * the Initialize handler from a unit test — `indexer.onEvent` registers with
   * Envio's runtime and the handler is never returned — and the E2E harness in
   * indexer.test.ts snapshots entity CHANGES, where a `false` and a `true` look
   * equally plausible. So this reads the source, the way the POSITION_MANAGERS
   * table is checked in positionGuards.test.ts: crude, but it fails when
   * someone drops one of the two writes, which is the regression that matters.
   */
  const readFileSync = require("node:fs").readFileSync;

  const HANDLER = "src/handlers/initialize-handler.ts";

  it("is written at BOTH Token creation sites, and only there", () => {
    const src = readFileSync(HANDLER, "utf8") as string;

    // Two creation sites (token0, token1), and every line that names the field
    // is one of them: each writes the effect's own answer, not a literal, and
    // nothing rewrites a row that already exists — the in-place upgrade that was
    // removed for producing a non-reproducible index.
    const lines = src
      .split("\n")
      .filter((l) => l.includes("decimalsResolved"))
      .map((l) => l.trim());

    expect(lines).toEqual([
      "decimalsResolved: metadata.decimalsResolved,",
      "decimalsResolved: metadata.decimalsResolved,",
    ]);
  });

  it("sits alongside the decimals it qualifies", () => {
    const src = readFileSync(HANDLER, "utf8") as string;

    // If the two ever drift apart, a row can carry a decimals from one read and
    // a flag from another.
    const paired = src.match(
      /decimals:\s*BigInt\(metadata\.decimals\),\s*\n\s*decimalsResolved:\s*metadata\.decimalsResolved,/g
    );
    expect(paired).toHaveLength(2);
  });

  it("is a required column on Token, so no row can omit it", () => {
    const schema = readFileSync("schema.graphql", "utf8") as string;
    const token = schema.slice(
      schema.indexOf("type Token "),
      schema.indexOf("\n}", schema.indexOf("type Token "))
    );

    // Non-null: a nullable column would let a consumer read `null` and treat it
    // as "not guessed", which is the failure the flag exists to prevent.
    expect(token).toMatch(/^\s*decimalsResolved:\s*Boolean!\s*$/m);
  });
});

describe("the removed mechanisms stay removed", () => {
  /*
   * Both were rejected on reproduced defects, not on taste:
   *  - `hasNoCodeAt` read eth_getCode at "latest" and treated "0x" as permanent.
   *    A replica behind head returns "0x" for a live contract WITHOUT throwing,
   *    so the catch-to-transient safety net never fires, and the wrong verdict
   *    is correlated with the RPC trouble that triggered the probe. "No code" is
   *    not permanent either: the motivating address is Circle's EURC (decimals
   *    6) on Base and, on Arbitrum, the nonce-1 CREATE address of an EOA whose
   *    nonce is still 0.
   *  - `refreshUnresolvedDecimals` could not repair amounts already derived from
   *    the guess (totalFeesCollected0 among them) and made the same block range
   *    replay to different values depending on RPC health.
   */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const readFileSync = fs.readFileSync;

  /** Every non-test source file under src/, so this file's own prose is exempt. */
  function sourceFiles(dir = "src"): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(p);
      return e.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  }

  it("has no reference in any source file under src/", () => {
    const offenders = sourceFiles().filter((p) =>
      /hasNoCodeAt|refreshUnresolvedDecimals/.test(fs.readFileSync(p, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("issues no eth_getCode from the metadata path", () => {
    const src = readFileSync("src/utils/tokenMetadata.ts", "utf8") as string;
    expect(src).not.toMatch(/getCode/);
  });
});
