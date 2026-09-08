/*
 * On-chain position state for the uncollected-fee sweep.
 *
 * Ported from Ponder's FeeSync block handler, which multicalls StateView views
 * for a whole CHUNK of positions at once (`refreshChunk`, 400) rather than one
 * position at a time. That batching is the part that matters operationally and
 * it is reproduced here: the effect takes an ARRAY of positions and issues one
 * Multicall3 request for all of them.
 *
 * ONE CALL FEWER PER POOL THAN PONDER, BY CONSTRUCTION
 *
 * Ponder also multicalls `getSlot0` once per pool in the chunk, to learn the
 * current tick — which it needs both to compute amounts and to decide which
 * positions are in range. Envio tracks `pool.tick` and `pool.sqrtPrice` from
 * `Initialize` and `Swap`, and in v4 only a swap can move the tick, so the
 * event-tracked value equals on-chain slot0 and that call is unnecessary here.
 *
 * WHAT STILL NEEDS A NODE
 *
 * `feeGrowthInside` is composed from `feeGrowthGlobal` and per-tick
 * `feeGrowthOutside`, and `feeGrowthGlobal` accumulates per swap STEP at that
 * step's liquidity while the `Swap` event reports only net amounts and final
 * liquidity. For a swap crossing k initialized ticks that is one equation in
 * k+1 unknowns, so it cannot be reconstructed from events — hence the read.
 *
 * NO RESULT CACHE, DELIBERATELY
 *
 * Envio's effect cache keys on the input, and every input here carries the
 * block number it was read at, so a cache entry could never be hit twice: the
 * sweep reads a different block every firing. Declaring `cache: true` would
 * persist one row per (batch, block) forever and hit none of them. Worse, a
 * FAILED read returns a zero sentinel, and caching that would make a transient
 * RPC failure permanent.
 */

import { createEffect, S } from "envio";
import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";

import { getRpcUrl } from "../utils/rpc";

/**
 * v4 StateView, the read-only companion to PoolManager.
 *
 * Only the two views the sweep needs. `getPositionInfo` returns the position's
 * stored fee-growth baseline, which is the value the delta is measured against.
 */
const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getFeeGrowthInside",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
    outputs: [
      { name: "feeGrowthInside0X128", type: "uint256" },
      { name: "feeGrowthInside1X128", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
] as const;

const clients: Record<number, PublicClient> = {};
function stateClient(chainId: number): PublicClient {
  if (!clients[chainId]) {
    // No `batch: { multicall: true }`. That option only aggregates INDIVIDUAL
    // `readContract` calls, and viem short-circuits it for an explicit
    // aggregate3 payload, so on this path it is inert config. `http(batch)` is
    // the layer that actually coalesces JSON-RPC requests.
    clients[chainId] = createPublicClient({
      transport: http(getRpcUrl(chainId), { batch: true }),
    });
  }
  return clients[chainId];
}

/** One position's fee-growth state, or `ok: false` when its read failed. */
const PositionFeeGrowth = S.schema({
  tokenId: S.bigint,
  ok: S.boolean,
  feeGrowthInside0X128: S.bigint,
  feeGrowthInside1X128: S.bigint,
  feeGrowthInside0LastX128: S.bigint,
  feeGrowthInside1LastX128: S.bigint,
  liquidity: S.bigint,
});

const PositionInput = S.schema({
  tokenId: S.bigint,
  poolId: S.string,
  tickLower: S.number,
  tickUpper: S.number,
});

/**
 * Fee-growth state for a BATCH of positions at ONE block, in one Multicall3.
 *
 * `ok` is what makes a failed read distinguishable from a measured zero. The
 * previous shape returned an all-zero object on failure, which the caller could
 * only tell apart by guessing at the values — and a position whose fee growth is
 * genuinely zero is a completely normal state, so that guess was wrong for real
 * positions. The caller must keep its previous uncollected value when `ok` is
 * false, exactly as Ponder keeps `p.liquidity` when its per-call status is not
 * "success".
 *
 * A whole-batch transport failure comes back as every entry `ok: false` rather
 * than throwing, so one bad chunk degrades that chunk instead of the sweep —
 * which is Ponder's `catch { continue }` around its chunk multicall.
 */
export const getPositionFeeGrowthBatch = createEffect(
  {
    name: "getPositionFeeGrowthBatch",
    input: S.schema({
      chainId: S.number,
      stateView: S.string,
      positionManager: S.string,
      multicall3: S.string,
      blockNumber: S.bigint,
      positions: S.array(PositionInput),
    }),
    output: S.array(PositionFeeGrowth),
    // See the header: a block-pinned input can never produce a cache hit, and
    // caching a failure sentinel would make a transient failure permanent.
    cache: false,
    // One call per CHUNK now, not per position, so this bounds chunks.
    rateLimit: { calls: 20, per: "second" },
  },
  async ({ context, input }) => {
    const { chainId, stateView, positionManager, multicall3, blockNumber, positions } = input;
    const failed = positions.map((p) => ({
      tokenId: p.tokenId,
      ok: false,
      feeGrowthInside0X128: 0n,
      feeGrowthInside1X128: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      liquidity: 0n,
    }));
    if (positions.length === 0) return [];

    const sv = { address: stateView as `0x${string}`, abi: STATE_VIEW_ABI } as const;
    const contracts = [
      ...positions.map((p) => ({
        ...sv,
        functionName: "getFeeGrowthInside" as const,
        args: [p.poolId as `0x${string}`, p.tickLower, p.tickUpper],
      })),
      ...positions.map((p) => ({
        ...sv,
        functionName: "getPositionInfo" as const,
        args: [
          p.poolId as `0x${string}`,
          positionManager as `0x${string}`,
          p.tickLower,
          p.tickUpper,
          // `salt` IS the tokenId, left-padded to bytes32 — the same identity
          // relation the ModifyLiquidity handler relies on.
          `0x${p.tokenId.toString(16).padStart(64, "0")}` as `0x${string}`,
        ],
      })),
    ];

    let results: Array<{ status: string; result?: unknown }>;
    try {
      results = (await stateClient(chainId).multicall({
        allowFailure: true,
        blockNumber,
        // REQUIRED, and not optional. viem resolves multicall3 from
        // `client.chain` when this is omitted, and a chainless client then
        // throws "client chain not configured. multicallAddress is required."
        // at the top of the action — before any RPC — which degraded every
        // single fee read to a fabricated zero.
        multicallAddress: multicall3 as `0x${string}`,
        contracts,
      })) as Array<{ status: string; result?: unknown }>;
    } catch (e) {
      context.log.warn(
        `Fee-growth batch of ${positions.length} failed on chain ${chainId} at block ` +
          `${blockNumber}: ${e instanceof Error ? e.message : String(e)} — keeping previous values`,
      );
      return failed;
    }

    const n = positions.length;
    return positions.map((p, i) => {
      const inside = results[i];
      const info = results[n + i];
      // `allowFailure: true` turns a rejected call into a per-call status rather
      // than a throw, so the status must be checked explicitly — which is why
      // Ponder's try/catch around its multicall cannot see per-call failures
      // and it tests `status === "success"` per result, as here.
      if (inside?.status !== "success" || info?.status !== "success") {
        return failed[i]!;
      }
      const [fg0, fg1] = inside.result as readonly [bigint, bigint];
      const [liq, last0, last1] = info.result as readonly [bigint, bigint, bigint];
      return {
        tokenId: p.tokenId,
        ok: true,
        feeGrowthInside0X128: fg0,
        feeGrowthInside1X128: fg1,
        feeGrowthInside0LastX128: last0,
        feeGrowthInside1LastX128: last1,
        liquidity: liq,
      };
    });
  },
);

/**
 * `getFeeGrowthInside` for ONE position, for the ModifyLiquidity trace gate.
 *
 * Separate from the batch effect because the caller is different in kind: the
 * sweep reads many positions at one block, while this reads one position at the
 * block of the event being handled. Ponder issues exactly this read on every
 * ModifyLiquidity (`readFeeGrowthInside`) for two purposes — to keep the
 * `fg*Last` baseline current, and to decide whether a trace is needed at all.
 *
 * Cached, unlike the batch: the input is one (pool, ticks, block) triple, and a
 * replay of the same block asks the identical question, so a hit is both
 * possible and correct. The block number is part of the key, which is what makes
 * it sound under reorgs — effect results are not rolled back.
 */
export const getFeeGrowthInside = createEffect(
  {
    name: "getFeeGrowthInside",
    input: S.schema({
      chainId: S.number,
      stateView: S.string,
      poolId: S.string,
      tickLower: S.number,
      tickUpper: S.number,
      blockNumber: S.bigint,
    }),
    output: S.schema({
      ok: S.boolean,
      feeGrowthInside0X128: S.bigint,
      feeGrowthInside1X128: S.bigint,
    }),
    cache: true,
    rateLimit: { calls: 100, per: "second" },
  },
  async ({ context, input }) => {
    try {
      const [fg0, fg1] = (await stateClient(input.chainId).readContract({
        address: input.stateView as `0x${string}`,
        abi: STATE_VIEW_ABI,
        functionName: "getFeeGrowthInside",
        args: [input.poolId as `0x${string}`, input.tickLower, input.tickUpper],
        blockNumber: input.blockNumber,
      })) as readonly [bigint, bigint];
      return { ok: true, feeGrowthInside0X128: fg0, feeGrowthInside1X128: fg1 };
    } catch (e) {
      // `ok: false` must NOT be read as "fee growth is zero". The caller treats
      // it as "unknown", which forces the trace rather than skipping it — the
      // safe direction, since skipping would silently record no collected fee.
      //
      // And it must not be CACHED. `cache: true` above is for successful reads;
      // persisting a failure would pin "unknown" for that (pool, ticks, block)
      // forever, so a replay of that block re-traces a transaction whose fee
      // growth was in fact knowable. Same rule as the trace effect.
      context.cache = false;
      context.log.warn(
        `getFeeGrowthInside failed for pool ${input.poolId} at block ${input.blockNumber}: ` +
          `${e instanceof Error ? e.message : String(e)} — tracing this transaction anyway`,
      );
      return { ok: false, feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
    }
  },
);
