/*
 * The two ModifyLiquidity fee gates, in ONE place each.
 *
 * WHY THIS MODULE EXISTS
 *
 * `getFeeGrowthInside` is issued from TWO call sites in
 * `handlers/modifyLiquidity-handler.ts` — the preload block and the real path —
 * so that the whole batch's reads go out in parallel instead of one at a time
 * (see `PRELOAD` below). Two call sites with a copy of the predicate in each is
 * the failure mode that matters: the moment they disagree, the preload pass
 * warms an input the real pass never asks for (pure waste) or, far worse, the
 * real pass asks for one the preload pass skipped and pays full RPC latency
 * inside the strictly serial handler loop. So the predicate lives here, once,
 * and both sites call it.
 *
 * `shouldTraceFees` is here for the same reason in reverse: it has one call
 * site, but it is the gate that decides whether a `debug_traceTransaction`
 * runs, i.e. whether a collected fee is measured or silently recorded as zero.
 * Exact collected fees are this indexer's hard requirement, so that predicate is
 * a named, unit-tested function rather than a condition buried in a 700-line
 * handler.
 *
 * PRELOAD, AS ENVIO 3.7.0 ACTUALLY IMPLEMENTS IT
 *
 * A batch is processed in two passes. `preloadBatchOrThrow`
 * (`EventProcessing.res.mjs:225`) invokes EVERY handler in the batch
 * concurrently with `isPreload: true`; `runBatchHandlersOrThrow` (:229) then
 * runs them again in a STRICTLY SERIAL for-loop.
 *
 * `UserContext.res.mjs:69` passes `isPreload` straight through as
 * `shouldGroup`, so in the preload pass effect calls are GROUPED — collected and
 * handed to `LoadLayer.executeWithRateLimit` together — while in the real pass
 * `shouldGroup` is false and `LoadManager.call` (`LoadManager.res.mjs:80`)
 * returns the in-memory value without touching the network. The dict it reads is
 * only cleared BEFORE the preload pass, never between the two.
 *
 * The consequence, which is the whole point of hoisting: a read issued in the
 * preload pass is issued ONCE, and the real pass's identical call is free. It is
 * not "issued twice" — that claim was measured false on 3.7.0 with both
 * `cache: true` and `cache: false`. What the real pass costs is exactly what the
 * preload pass did not warm.
 *
 * The inputs must therefore be IDENTICAL between the passes, because the memo is
 * keyed on the input. That is the other reason for one shared constructor:
 * `effectInput` below is built in one place, so the two passes cannot drift into
 * two different cache keys and pay for the read twice.
 */

import { type EvmOnEventContext } from "envio";

import { getFeeGrowthInside } from "../effects/positionState";
import { isDegenerate, tokenIdFromSalt } from "./positions";
import { positionManagerFor, v4AddressesFor } from "./v4Addresses";

type handlerContext = EvmOnEventContext;

/**
 * Everything the gate needs, and nothing that is unavailable before the
 * handler's own guard.
 *
 * `poolTick` / `poolSqrtPrice` are the POOL AS READ FROM THE STORE, not the
 * handler's mutated copy. The two are interchangeable here and that is a
 * property worth stating rather than assuming: the handler's `pool` is built by
 * spreading `existingPool` and overriding `txCount`,
 * `totalValueLockedToken0/1`, `liquidity`, `totalValueLockedETH` and
 * `totalValueLockedUSD` (modifyLiquidity-handler.ts:169-213). `tick` and
 * `sqrtPrice` are never among them, so `pool.tick === existingPool.tick` and
 * `pool.sqrtPrice === existingPool.sqrtPrice` by construction, and
 * `isDegenerate` — which reads only those two — returns the same answer from
 * either. That is what lets the preload block, which runs before `pool` exists,
 * evaluate the identical predicate.
 */
export interface FeeGateEvent {
  readonly chainId: number;
  /** `event.params.sender`, EIP-55 checksummed as Envio delivers it. */
  readonly sender: string;
  readonly salt: string;
  /** `event.params.id`, the v4 PoolId (bytes32), NOT the chain-namespaced row id. */
  readonly poolId: string;
  readonly tickLower: bigint;
  readonly tickUpper: bigint;
  readonly blockNumber: number;
  readonly poolTick: bigint | undefined;
  readonly poolSqrtPrice: bigint | undefined;
}

/** The exact `getFeeGrowthInside` input, built in one place so both passes agree. */
export interface FeeGrowthEffectInput {
  readonly chainId: number;
  readonly stateView: string;
  readonly poolId: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly blockNumber: bigint;
}

export interface FeeGateDecision {
  /**
   * Is this event attributable to an NFT position at all — i.e. was the caller
   * the canonical PositionManager, so that `salt` really is a tokenId?
   *
   * The preload block uses this to decide whether warming the position-side
   * reads is worth a query, and the real path re-derives the same answer from
   * its own `positionManagerFor` / sender check.
   */
  readonly attributable: boolean;
  /** The NFT tokenId, when `attributable` and the salt carries one. */
  readonly tokenId: bigint | undefined;
  /** Must `getFeeGrowthInside` be issued for this event? */
  readonly read: boolean;
  /** Present iff `read`. */
  readonly effectInput: FeeGrowthEffectInput | undefined;
}

const NO_READ = { read: false as const, effectInput: undefined };

/**
 * THE single source of truth for "does this ModifyLiquidity need a
 * getFeeGrowthInside read, and for which position".
 *
 * The read is gated on `!degenerate` ALONE among the fee conditions — the same
 * place Ponder has it (apps/v4/src/index.ts:211-212) — and deliberately NOT on
 * the trace gate's `hadPosition && liquidity > 0` conjuncts. Gating it on those
 * silently lost fees: a mint has no prior position, so the read was skipped and
 * the position's `feeGrowthInside*LastX128` baseline stayed at `newPosition()`'s
 * 0, which is indistinguishable from the genuine (0, 0) a cleared tick pair
 * reports on a later close. See the `shouldTraceFees` note below.
 */
export function feeGate(e: FeeGateEvent): FeeGateDecision {
  // A chain with no PositionManager entry cannot attribute anything: `salt` is
  // an arbitrary caller-supplied bytes32 unless the PositionManager put a
  // tokenId there. Same guard, same order, as the handler's own.
  const positionManager = positionManagerFor(e.chainId);
  if (!positionManager || e.sender.toLowerCase() !== positionManager) {
    return { attributable: false, tokenId: undefined, ...NO_READ };
  }

  const tokenId = tokenIdFromSalt(e.salt);
  if (tokenId === undefined) {
    return { attributable: true, tokenId: undefined, ...NO_READ };
  }

  // Tick math is meaningless at the edges of the representable domain, so a
  // degenerate pool's amounts are zeroed and no fee read is worth an RPC.
  if (isDegenerate(e.poolTick ?? 0n, e.poolSqrtPrice ?? 0n)) {
    return { attributable: true, tokenId, ...NO_READ };
  }

  return {
    attributable: true,
    tokenId,
    read: true,
    effectInput: {
      chainId: e.chainId,
      // `?? ""` rather than a skip, matching the call site this replaced: a
      // chain with no StateView produces a failing read, which returns
      // `ok: false` and therefore FORCES the trace. Skipping would instead
      // produce `undefined`, which reads as "unchanged" and would silently
      // record no collected fee.
      stateView: v4AddressesFor(e.chainId)?.stateView ?? "",
      poolId: e.poolId,
      tickLower: Number(e.tickLower),
      tickUpper: Number(e.tickUpper),
      blockNumber: BigInt(e.blockNumber),
    },
  };
}

/** What `getFeeGrowthInside` resolves to, or `undefined` when the gate said no. */
export type FeeGrowthReading =
  | { readonly ok: boolean; readonly feeGrowthInside0X128: bigint; readonly feeGrowthInside1X128: bigint }
  | undefined;

/**
 * Evaluate the gate and, when it passes, issue `getFeeGrowthInside`.
 *
 * Called from BOTH passes with the same arguments. In the preload pass the
 * result is discarded — the point is the side effect of populating the effect's
 * in-memory output dict, exactly as `preloadIntervalData` populates the load
 * layer's (utils/intervalUpdates.ts:159-171). In the real pass the same call
 * short-circuits to that dict and costs nothing.
 */
export async function readFeeGrowthInside(
  context: handlerContext,
  e: FeeGateEvent,
): Promise<FeeGrowthReading> {
  const gate = feeGate(e);
  if (!gate.read || !gate.effectInput) return undefined;
  return await context.effect(getFeeGrowthInside, gate.effectInput);
}

/**
 * Does this event need a `debug_traceTransaction` to learn its collected fee?
 *
 *     gateCanPass && (feeGrowthChanged || liquidityDelta < 0n)
 *
 * `gateCanPass` is Ponder's provably-zero skip and is unchanged: a position that
 * does not exist yet, or held no liquidity, cannot have accrued anything, and a
 * degenerate pool's numbers are meaningless.
 *
 * THE `liquidityDelta < 0n` DISJUNCT IS A DELIBERATE DIVERGENCE FROM PONDER,
 * TAKEN ON AN EXPLICIT USER DECISION, AND IT IS THE FIX RATHER THAN A
 * REGRESSION.
 *
 * `feeGrowthChanged` compares the pool's current `feeGrowthInside` against the
 * baseline stored on the position at its last settle, and skips the trace when
 * they are equal on the argument that nothing can have accrued. That argument
 * has one hole, and a full close falls straight into it:
 *
 *   `getFeeGrowthInside` returns EXACTLY (0, 0) when both of the position's
 *   ticks have been CLEARED — which v4 does when the position was the last
 *   liquidity at those ticks — and the price sits outside the range. That is
 *   precisely the state a full close leaves behind. So on a close the stored
 *   baseline is 0, the fresh read is 0, `feeGrowthChanged` is false, no trace
 *   runs, and the collected fee is silently recorded as ZERO.
 *
 * GROUND TRUTH. Avalanche tokenId 137, WITHDRAW tx
 * 0x283901105bd7a3cfe6227b0283ff38786c1002fbb1fb1c135b63fefa966f8b13 at block
 * 57816979: the trace decodes `feesAccrued = (262354965774593714, 6708203)`
 * while BOTH indexers stored 0, and `callerDelta0 - feesAccrued0` reproduces
 * `withdrawnToken0` to the wei.
 *
 * Ponder has the identical defect, so Envio-vs-Ponder parity is structurally
 * blind to it — the two agree on the wrong number. Which is why this diverges
 * on purpose: a parity failure on a decrease is now the expected result.
 *
 * WHY A DECREASE IS THE RIGHT PLACE TO DROP THE HEURISTIC. In v4 a liquidity
 * DECREASE always returns `feesAccrued`, so `feeGrowthChanged` has nothing
 * useful to add on that path — it can only ever remove a trace that was
 * warranted.
 *
 * THE COST, with the denominator stated. On a 1000-row chain-1 sample the type
 * mix was DEPOSIT 680 / WITHDRAW 226 / COLLECT_FEES 94. Today ~94 of those 1000
 * rows are traced; tracing every decrease takes that to ~226. So it is ~2.4x
 * TOTAL traces per 1000 rows — NOT 2.4x on the decrease path, where the
 * multiplier is much larger because decreases previously traced only when the
 * heuristic fired. Still ~100x below tracing every ModifyLiquidity.
 *
 * That sample is from the handoff and predates the current 5-chain deployment;
 * treat 2.4x as an order-of-magnitude figure and re-measure the type mix per
 * chain before relying on it for capacity planning. Watch it against
 * getFeesAccrued's own rateLimit of {calls: 20, per: "second"}: if the new
 * volume saturates that window, the sweep queues rather than errors, but the
 * added latency lands inside the serial pass.
 *
 * An INCREASE keeps the heuristic in full: there the (0, 0)-from-cleared-ticks
 * ambiguity does not arise the same way, and increases are the bulk of events.
 */
export function shouldTraceFees(args: {
  readonly gateCanPass: boolean;
  readonly feeGrowthChanged: boolean;
  readonly liquidityDelta: bigint;
}): boolean {
  return args.gateCanPass && (args.feeGrowthChanged || args.liquidityDelta < 0n);
}
