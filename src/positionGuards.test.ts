/**
 * Unit tests for the guards that keep the position surface honest.
 *
 * These are pure (or RPC-mocked) rather than E2E, because each one exists to
 * prevent a specific class of PLAUSIBLE WRONG NUMBER — a value that is not an
 * error and looks like data. A snapshot test cannot fail on those; it just
 * records the wrong number.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { isDegenerate } from "./utils/positions";
import { TickMath } from "./utils/liquidityMath/tickMath";

describe("isDegenerate — the astronomical-amount guard", () => {
  const MID_SQRT = 79228162514264337593543950336n; // price 1.0

  it("passes an ordinary pool", () => {
    expect(isDegenerate(0n, MID_SQRT)).toBe(false);
    expect(isDegenerate(-100n, MID_SQRT)).toBe(false);
    expect(isDegenerate(200000n, MID_SQRT)).toBe(false);
  });

  it("flags a pool at either tick boundary", () => {
    // At the domain edge the amount formulas lose all precision and return
    // values that are numerically enormous and physically meaningless. Ponder
    // zeroes amounts here rather than publishing the artifact.
    expect(isDegenerate(TickMath.MAX_TICK, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MIN_TICK, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MAX_TICK + 1n, MID_SQRT)).toBe(true);
    expect(isDegenerate(TickMath.MIN_TICK - 1n, MID_SQRT)).toBe(true);
  });

  it("flags a pool at either sqrt-price boundary", () => {
    expect(isDegenerate(0n, TickMath.MAX_SQRT_RATIO)).toBe(true);
    expect(isDegenerate(0n, TickMath.MIN_SQRT_RATIO)).toBe(true);
  });

  it("flags an uninitialized pool, whose sqrtPrice reads as zero", () => {
    // `pool.sqrtPrice ?? 0n` is what the handler passes when a pool has not been
    // initialized. Zero is below MIN_SQRT_RATIO, so it must be caught — treating
    // it as a real price is how a position gets a fabricated valuation.
    expect(isDegenerate(0n, 0n)).toBe(true);
  });
});

describe("isAtChainHead — Ponder's `startBlock: \"latest\"` stand-in", () => {
  const getBlockNumber = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    getBlockNumber.mockReset();
  });

  async function load() {
    vi.doMock("viem", () => ({
      createPublicClient: () => ({ getBlockNumber }),
      http: () => ({}),
    }));
    const mod = await import("./utils/chainHead");
    mod.__resetChainHeadCache();
    return mod;
  }

  it("is false while replaying history, which is the whole point", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    // The reported run: chain 1 sweeping at 21,735,126 while the head was ~4.2M
    // blocks away. Every one of those ~14,100 firings was work that the next
    // firing overwrote.
    expect(await isAtChainHead(1, 21_735_126n, 300n)).toBe(false);
  });

  it("is true at the tip, and within one interval of it", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(true);
    // Between firings the indexer is legitimately up to one interval behind,
    // which is why the tolerance is the caller's own cadence.
    expect(await isAtChainHead(1, 25_932_822n, 300n)).toBe(true);
  });

  it("is false just past the tolerance BEFORE the chain has ever caught up", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    // A DIFFERENT chain id, deliberately: the assertion is about the un-latched
    // state, and any earlier call at the tip on chain 1 would have latched it.
    // That is the whole point of the latch, so testing it on a latched chain
    // would assert the opposite of the intended behaviour.
    expect(await isAtChainHead(43114, 25_932_821n, 300n)).toBe(false);
  });

  it("is true for a block ahead of the cached head", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    // The cache is up to 30s stale and the indexer may have advanced past it.
    expect(await isAtChainHead(1, 25_933_200n, 300n)).toBe(true);
  });

  it("FAILS CLOSED when the head cannot be determined", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockRejectedValue(new Error("rpc down"));
    // Answering `true` here would start a full-history sweep on every firing.
    // One skipped refresh cycle is the cheaper mistake by a wide margin.
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(false);
  });

  it("keeps serving the last known head through a transient failure", async () => {
    const { isAtChainHead, __resetChainHeadCache } = await load();
    getBlockNumber.mockResolvedValueOnce(25_933_122n);
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(true);

    // A blip must not suspend the sweep on a chain already known to be live.
    __resetChainHeadCache();
    getBlockNumber.mockResolvedValueOnce(25_933_122n);
    await isAtChainHead(1, 25_933_122n, 300n);
    getBlockNumber.mockRejectedValue(new Error("blip"));
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(true);
  });

  it("LATCHES: stays on through ordinary lag once the head is reached", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    // Reach the head once.
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(true);
    // Now drift past the plain tolerance but inside the relatch window.
    // Un-latched this would be false, and the sweep would flap off and on
    // during normal live operation.
    expect(await isAtChainHead(1, 25_933_122n - 600n, 300n)).toBe(true);
  });

  it("un-latches on a backfill-sized regression", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    expect(await isAtChainHead(1, 25_933_122n, 300n)).toBe(true);
    // 3 intervals is the documented slack; beyond it the work is being
    // overwritten before anyone can read it, exactly as during a backfill.
    expect(await isAtChainHead(1, 25_933_122n - 300n * 3n, 300n)).toBe(true);
    expect(await isAtChainHead(1, 25_933_122n - 300n * 4n, 300n)).toBe(false);
  });

  it("does not latch from a position that never reached the head", async () => {
    const { isAtChainHead, hasCaughtUp } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    expect(await isAtChainHead(1, 21_735_126n, 300n)).toBe(false);
    expect(hasCaughtUp(1)).toBe(false);
  });

  it("headAtStartup returns a floor per chain and tolerates a dead RPC", async () => {
    const { headAtStartup } = await load();
    getBlockNumber.mockResolvedValueOnce(25_933_122n).mockRejectedValueOnce(new Error("down"));
    const heads = await headAtStartup([1, 43114], 1000);
    // The chain that answered gets a floor; the one that did not is ABSENT, so
    // the caller omits `_gte` and falls back to the runtime gate.
    expect(heads.get(1)).toBe(25_933_122);
    expect(heads.has(43114)).toBe(false);
  });

  it("caches, so a backfill's firings do not each cost a call", async () => {
    const { isAtChainHead } = await load();
    getBlockNumber.mockResolvedValue(25_933_122n);
    for (let i = 0; i < 50; i++) await isAtChainHead(1, 21_735_126n + BigInt(i), 300n);
    // Without the TTL cache this gate would add one RPC per firing — tens of
    // thousands over a backfill, which is what it exists to avoid.
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });
});

describe("POSITION_MANAGERS must equal config.yaml", () => {
  /*
   * The sender filter compares `event.params.sender` against this table, so a
   * wrong or missing address means every ModifyLiquidity on that chain fails the
   * comparison and NO positions are indexed for it — silently, with correct-
   * looking pool and token data alongside. The table's own docstring states that
   * keeping it equal to config.yaml is a maintenance rule; this makes it a
   * failing test instead of a hope.
   */
  const readFileSync = require("node:fs").readFileSync;

  function tableFromSource(): Map<number, string> {
    const src = readFileSync("src/utils/v4Addresses.ts", "utf8") as string;
    const start = src.indexOf("const POSITION_MANAGERS");
    const blk = src.slice(start, src.indexOf("};", start));
    const out = new Map<number, string>();
    for (const m of blk.matchAll(/^\s*(\d+):\s*"(0x[0-9a-fA-F]{40})"/gm)) {
      out.set(Number(m[1]), m[2]!.toLowerCase());
    }
    return out;
  }

  function configPositionManagers(): Map<number, string> {
    const cfg = readFileSync("config.yaml", "utf8") as string;
    const out = new Map<number, string>();
    let chainId: number | null = null;
    let contract: string | null = null;
    // Commented-out chains count: their addresses are still the source of truth
    // for the day someone uncomments them.
    for (const raw of cfg.split("\n")) {
      const t = raw.trim().replace(/^#/, "").trim();
      const id = /^-?\s*id:\s*(\d+)/.exec(t);
      if (id) {
        chainId = Number(id[1]);
        contract = null;
        continue;
      }
      const name = /^-?\s*name:\s*(\w+)/.exec(t);
      if (name) {
        contract = name[1]!;
        continue;
      }
      const addr = /^-\s*(0x[0-9a-fA-F]{40})/.exec(t);
      if (addr && chainId !== null && contract === "PositionManager" && !out.has(chainId)) {
        out.set(chainId, addr[1]!.toLowerCase());
      }
    }
    return out;
  }

  it("covers every chain config.yaml declares a PositionManager for", () => {
    const table = tableFromSource();
    const cfg = configPositionManagers();
    expect(cfg.size).toBeGreaterThan(0);
    const missing = [...cfg.keys()].filter((c) => !table.has(c));
    expect(missing, `chains in config.yaml with no POSITION_MANAGERS entry: ${missing}`).toEqual([]);
  });

  it("agrees with config.yaml on every address", () => {
    const table = tableFromSource();
    const cfg = configPositionManagers();
    const wrong: string[] = [];
    for (const [chainId, addr] of table) {
      const expected = cfg.get(chainId);
      if (expected && expected !== addr) wrong.push(`${chainId}: table=${addr} config=${expected}`);
    }
    expect(wrong, `PositionManager mismatches: ${wrong.join("; ")}`).toEqual([]);
  });
});

describe("activeChainIds — which chains config.yaml actually indexes", () => {
  it("returns exactly the uncommented chains", async () => {
    const { activeChainIds } = await import("./utils/chains");
    const ids = [...activeChainIds()].sort((a, b) => a - b);
    // Envio exposes the active set only as a TYPE, so startup work that needs it
    // has to read the config. Getting this wrong means firing RPC at chains this
    // process does not index — three of five with the file as it ships.
    expect(ids).toEqual([1, 43114]);
  });

  it("excludes chains that are present but commented out", async () => {
    const { activeChainIds } = await import("./utils/chains");
    const active = activeChainIds();
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync("config.yaml", "utf8");
    // Commented blocks still carry their ids, which is the whole trap.
    const commented = [...cfg.matchAll(/^\s*#\s*-\s*id:\s*(\d+)/gm)].map((m) => Number(m[1]));
    expect(commented.length).toBeGreaterThan(0);
    for (const id of commented) expect(active.has(id)).toBe(false);
  });
});
