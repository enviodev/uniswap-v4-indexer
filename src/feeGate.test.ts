/**
 * Unit tests for the two ModifyLiquidity fee gates (`src/utils/feeGate.ts`).
 *
 * Same rationale as positionGuards.test.ts: each of these exists to prevent a
 * specific PLAUSIBLE WRONG NUMBER — a zero that looks like data. A snapshot
 * test cannot fail on a fee that was never measured; it records the zero.
 *
 * `shouldTraceFees` is the gate on `debug_traceTransaction`, which is the only
 * source of the exact collected fee. `feeGate` is the gate on
 * `getFeeGrowthInside`, and its job here is to be the SINGLE source both the
 * preload pass and the real pass consult.
 */

import { describe, it, expect, vi } from "vitest";

import {
  feeGate,
  readFeeGrowthInside,
  shouldTraceFees,
  type FeeGateEvent,
} from "./utils/feeGate";
import { getFeeGrowthInside, getPositionFeeGrowthBatch } from "./effects/positionState";
import { TickMath } from "./utils/liquidityMath/tickMath";

/** Avalanche, whose PositionManager is the one the tokenId-137 case ran through. */
const AVALANCHE = 43114;
const AVAX_POSITION_MANAGER = "0xB74b1F14d2754AcfcbBe1a221023a5cf50Ab8ACD";
const MID_SQRT = 79228162514264337593543950336n; // price 1.0
const POOL_ID = "0x" + "ab".repeat(32);

function evt(over: Partial<FeeGateEvent> = {}): FeeGateEvent {
  return {
    chainId: AVALANCHE,
    // Checksummed, as Envio delivers it — `address_format` defaults to
    // `checksum` and config.yaml does not override it, so a gate that compared
    // without lowercasing would reject every real event.
    sender: AVAX_POSITION_MANAGER,
    salt: "0x" + (137).toString(16).padStart(64, "0"),
    poolId: POOL_ID,
    tickLower: -887220n,
    tickUpper: 887220n,
    blockNumber: 57816979,
    poolTick: 0n,
    poolSqrtPrice: MID_SQRT,
    ...over,
  };
}

describe("shouldTraceFees — the gate on the only exact fee source", () => {
  /*
   * PART B, THE REGRESSION THIS FILE EXISTS FOR.
   *
   * `getFeeGrowthInside` returns exactly (0, 0) when both of a position's ticks
   * have been CLEARED — v4 clears them when the position was the last liquidity
   * there — and the price sits outside the range. That is the state a full
   * close leaves, so on a close the stored baseline is 0, the fresh read is 0,
   * `feeGrowthChanged` is false, and the fee was silently recorded as ZERO.
   *
   * Ground truth: Avalanche tokenId 137, WITHDRAW tx 0x283901…f8b13 at block
   * 57816979 — the trace decodes feesAccrued = (262354965774593714, 6708203)
   * while both indexers stored 0.
   */
  it("TRACES a decrease even when feeGrowthChanged is false", () => {
    expect(
      shouldTraceFees({
        gateCanPass: true,
        feeGrowthChanged: false,
        liquidityDelta: -1_000n,
      }),
    ).toBe(true);
  });

  it("still traces a decrease when feeGrowthChanged is true", () => {
    expect(
      shouldTraceFees({
        gateCanPass: true,
        feeGrowthChanged: true,
        liquidityDelta: -1_000n,
      }),
    ).toBe(true);
  });

  it("does NOT trace a decrease on a position with no prior liquidity", () => {
    // `gateCanPass` is unchanged by Part B, and it is the conjunct that keeps
    // the divergence bounded: a position that does not exist yet, or held no
    // liquidity, provably accrued nothing, so the extra disjunct must not
    // resurrect a trace there. This is what stops "trace every decrease".
    expect(
      shouldTraceFees({
        gateCanPass: false,
        feeGrowthChanged: false,
        liquidityDelta: -1_000n,
      }),
    ).toBe(false);
    expect(
      shouldTraceFees({
        gateCanPass: false,
        feeGrowthChanged: true,
        liquidityDelta: -1_000n,
      }),
    ).toBe(false);
  });

  it("does NOT trace an increase whose fee growth did not change", () => {
    // Increases are the bulk of events and Ponder's heuristic is kept in full
    // for them. Losing this is the difference between ~226 traces per 1000 rows
    // and tracing everything.
    expect(
      shouldTraceFees({
        gateCanPass: true,
        feeGrowthChanged: false,
        liquidityDelta: 5_000n,
      }),
    ).toBe(false);
  });

  it("does NOT trace a zero-delta collect whose fee growth did not change", () => {
    // A pure collect is `liquidityDelta === 0`, which is NOT `< 0n`. Nothing
    // accrued and nothing to discover, so the heuristic still applies.
    expect(
      shouldTraceFees({
        gateCanPass: true,
        feeGrowthChanged: false,
        liquidityDelta: 0n,
      }),
    ).toBe(false);
  });

  it("traces an increase or a collect once fee growth HAS changed", () => {
    for (const liquidityDelta of [0n, 5_000n]) {
      expect(
        shouldTraceFees({ gateCanPass: true, feeGrowthChanged: true, liquidityDelta }),
      ).toBe(true);
    }
  });
});

describe("feeGate — one predicate for the preload pass and the real path", () => {
  it("passes for a PositionManager event on an ordinary pool", () => {
    const d = feeGate(evt());
    expect(d.attributable).toBe(true);
    expect(d.tokenId).toBe(137n);
    expect(d.read).toBe(true);
    expect(d.effectInput).toMatchObject({
      chainId: AVALANCHE,
      poolId: POOL_ID,
      tickLower: -887220,
      tickUpper: 887220,
      blockNumber: 57816979n,
    });
    // The StateView must actually resolve, or every read degrades to ok:false
    // and every event traces.
    expect(d.effectInput?.stateView).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("refuses to attribute a non-PositionManager caller", () => {
    // `salt` is a caller-supplied bytes32; only the PositionManager makes it a
    // tokenId. Reading fee growth for one would be an RPC spent on a row that
    // is never written.
    const d = feeGate(evt({ sender: "0x000000000000000000000000000000000000dEaD" }));
    expect(d).toEqual({
      attributable: false,
      tokenId: undefined,
      read: false,
      effectInput: undefined,
    });
  });

  it("refuses on a chain with no PositionManager entry", () => {
    const d = feeGate(evt({ chainId: 31337 }));
    expect(d.attributable).toBe(false);
    expect(d.read).toBe(false);
  });

  it("treats a zero salt as no tokenId, but still attributable", () => {
    // Zero is the default salt for direct liquidity provision, not a minted id.
    const d = feeGate(evt({ salt: "0x" + "0".repeat(64) }));
    expect(d.attributable).toBe(true);
    expect(d.tokenId).toBeUndefined();
    expect(d.read).toBe(false);
  });

  it("skips the read on a degenerate pool but still reports the tokenId", () => {
    // The tokenId is still needed: the real path writes the Position row for a
    // degenerate pool too, with zeroed amounts and isPriceable false. Only the
    // fee READ is pointless there.
    for (const over of [
      { poolTick: TickMath.MIN_TICK },
      { poolTick: TickMath.MAX_TICK },
      { poolSqrtPrice: 0n },
      { poolSqrtPrice: TickMath.MAX_SQRT_RATIO },
    ]) {
      const d = feeGate(evt(over));
      expect(d.attributable).toBe(true);
      expect(d.tokenId).toBe(137n);
      expect(d.read).toBe(false);
      expect(d.effectInput).toBeUndefined();
    }
  });

  it("reads on an absent tick alone, but a pool missing BOTH fields is degenerate and is not read", () => {
    /*
     * `pool.tick` is nullable in the schema and `?? 0n` is what the handler
     * passed before the extraction; 0 is an ordinary in-domain tick, so an
     * absent tick on its own does not suppress the read.
     *
     * Both absent is the opposite case, and the earlier title of this test had
     * it backwards. `isDegenerate` compares sqrtPrice against
     * TickMath.MIN_SQRT_RATIO (4295128739n), and `?? 0n` makes an absent
     * sqrtPrice 0, which is <= that bound — so the pool IS degenerate and the
     * read IS skipped. That is deliberate, not an oversight: with no price
     * there is nothing to read against.
     */
    expect(feeGate(evt({ poolTick: undefined })).read).toBe(true);
    expect(feeGate(evt({ poolTick: undefined, poolSqrtPrice: undefined })).read).toBe(false);
  });

  /*
   * THE POINT OF THE EXTRACTION — stated accurately.
   *
   * An earlier version of this comment claimed the two passes "call the SAME
   * function with the SAME object, so they cannot disagree". THAT IS FALSE, and
   * the test below it was a tautology that could never have caught it.
   *
   * `feeGateEvent` is built per pass from `existingPool`, i.e. from
   * `context.Pool.get(poolId)`. In the PRELOAD pass that reads the DB row,
   * because preload writes are discarded (`set` is `noopSet`,
   * UserContext.res.mjs:102). In the REAL pass it reads
   * `latestEntityChangeById`, which earlier handlers in the same batch have
   * already updated — `swap-handler.ts` assigns `tick` and `sqrtPrice` from the
   * swap event. So a swap earlier in the batch CAN move a pool across the
   * `isDegenerate` boundary between the two passes.
   *
   * What that costs, precisely: `poolTick` / `poolSqrtPrice` gate WHETHER the
   * read is issued; they are NOT part of the effect input, so they cannot
   * produce a different memo key and cannot produce a wrong answer. Drift
   * degrades to today's behaviour — the real pass misses the warm and pays one
   * RPC inside the serial loop. Measured: preload=0, real=1 for a pool
   * degenerate at preload and healthy at real.
   *
   * The two tests below pin exactly that: the memo key must be independent of
   * pool price state, and the gate is allowed to differ across passes.
   */
  it("is deterministic: the same input always yields the same decision", () => {
    for (const over of [
      {},
      { sender: "0x000000000000000000000000000000000000dEaD" },
      { poolTick: TickMath.MIN_TICK },
      { salt: "0x" + "0".repeat(64) },
      { chainId: 1 },
    ] as Partial<FeeGateEvent>[]) {
      expect(feeGate(evt(over))).toEqual(feeGate(evt(over)));
    }
  });

  it("keys the effect input independently of pool price state, so the two passes cannot miss each other's memo", () => {
    /*
     * THE TEST THAT ACTUALLY BITES. Two events identical except for the pool
     * price state the two passes can legitimately disagree about. If either
     * `poolTick` or `poolSqrtPrice` ever leaks into the effect input, the real
     * pass computes a DIFFERENT memo key from the preload pass, misses the
     * warm on every event, and the hoist silently buys nothing.
     */
    const healthy = evt({ poolTick: 100n, poolSqrtPrice: 79228162514264337593543950336n });
    const alsoHealthy = evt({ poolTick: -8000n, poolSqrtPrice: 52959464864425783n });

    const a = feeGate(healthy);
    const b = feeGate(alsoHealthy);

    expect(a.read).toBe(true);
    expect(b.read).toBe(true);
    expect(a.effectInput).toEqual(b.effectInput);
  });

  it("lets the gate differ across passes without changing the answer — drift costs a warm miss, never a wrong fee", async () => {
    /*
     * A swap earlier in the same batch can move a pool across the isDegenerate
     * boundary between the preload read (DB row) and the real read (in-batch
     * writes). Pin the consequence: the degenerate pass issues nothing, the
     * healthy pass issues exactly the input it would have issued anyway.
     */
    const effect = vi.fn(async (_effect: unknown, _input: unknown) => ({
      ok: true,
      feeGrowthInside0X128: 1n,
      feeGrowthInside1X128: 2n,
    }));
    const context = { effect } as unknown as Parameters<typeof readFeeGrowthInside>[0];

    const degenerateAtPreload = evt({ poolSqrtPrice: 0n });
    const healthyAtReal = evt();

    expect(await readFeeGrowthInside(context, degenerateAtPreload)).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(0);

    await readFeeGrowthInside(context, healthyAtReal);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect.mock.calls[0]![0]).toBe(getFeeGrowthInside);
    expect(effect.mock.calls[0]![1]).toEqual(feeGate(healthyAtReal).effectInput);
  });

  it("issues NOTHING when the gate says no, in either pass", async () => {
    const effect = vi.fn();
    const context = { effect } as unknown as Parameters<typeof readFeeGrowthInside>[0];
    const closed = evt({ poolTick: TickMath.MIN_TICK });

    expect(await readFeeGrowthInside(context, closed)).toBeUndefined();
    expect(await readFeeGrowthInside(context, closed)).toBeUndefined();
    expect(effect).not.toHaveBeenCalled();
  });
});

describe("effect options that are load-bearing rather than cosmetic", () => {
  /*
   * Asserted against the RUNTIME shape `createEffect` produces
   * (`Envio.res.mjs:22-51`), not the literal passed in — that is what the
   * indexer actually reads.
   */
  type EffectInternals = {
    readonly name: string;
    readonly defaultShouldCache: boolean;
    readonly crossChain?: boolean;
    readonly rateLimit?: { callsPerDuration: number; durationMs: number };
  };
  const inside = getFeeGrowthInside as unknown as EffectInternals;
  const batch = getPositionFeeGrowthBatch as unknown as EffectInternals;

  it("getFeeGrowthInside rate-limits above the five-chain shared floor, but not so wide the request is rejected", () => {
    /*
     * Two-sided, because this number is bounded from BOTH directions and a
     * previous version of this change got the upper bound wrong.
     *
     * FLOOR. Once the read is hoisted into the preload pass the limiter, not
     * RPC latency, is the ceiling on throughput. config.yaml sets no
     * `disable_default_cross_chain`, so `crossChain` defaults to true and ONE
     * window is shared by every chain — the old 100/s was ~20/s each across the
     * five uncommented chains. At or below 100 is a regression of Part C.
     *
     * CEILING. `LoadLayer.executeWithRateLimit` releases `availableCalls`
     * simultaneously, so this number maps ONE-FOR-ONE onto the width of the
     * JSON-RPC body viem sends. Measured: n=600 at calls=100 gave 6 POSTs of
     * width 100; at calls=500, 2 POSTs of width 500. A 500-wide `eth_call` body
     * invites a provider rejection, and a 429 here returns `ok: false`, which
     * FORCES a trace — and if that trace also fails the fee is recorded as a
     * silent ZERO. So an over-wide limit is a correctness risk, not just a
     * throughput knob, on an indexer whose hard requirement is exact fees.
     */
    expect(inside.rateLimit).toEqual({ callsPerDuration: 200, durationMs: 1000 });
    expect(inside.rateLimit!.callsPerDuration).toBeGreaterThan(100);
    expect(inside.rateLimit!.callsPerDuration).toBeLessThanOrEqual(250);
  });

  it("getFeeGrowthInside keeps its cache and its crossChain scope", () => {
    // NOT because crossChain: true is better — because the cache table name
    // encodes the scope (`Internal.res.mjs:222-228`), so flipping it silently
    // ORPHANS every cached row. `rateLimit` is the runtime-only knob; this
    // makes the scope an explicit decision rather than an accident.
    expect(inside.defaultShouldCache).toBe(true);
    expect(inside.crossChain).toBeUndefined();
  });

  it("getPositionFeeGrowthBatch must stay uncached", () => {
    /*
     * Not a preference. `UserContext.res.mjs:61` builds the cache key with
     * `Utils.Hash.makeOrThrow`, which is a canonical serialiser rather than a
     * digest (`Utils.res.mjs:559-620`), and that string IS the row id of a
     * table whose only columns are `id` (String PRIMARY KEY) and `output`
     * (`Internal.res.mjs:315-320`). The input here is a 400-position array, so
     * the key runs to tens of kilobytes against Postgres's 2704-byte btree
     * limit: `cache: true` is a StorageError on first write, not a wasted row.
     */
    expect(batch.defaultShouldCache).toBe(false);
  });
});
