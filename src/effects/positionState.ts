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
 * NO RESULT CACHE ON THE BATCH EFFECT, DELIBERATELY — AND IT CANNOT BE FLIPPED
 *
 * Three reasons, in ascending order of finality. See `cache: false` on
 * `getPositionFeeGrowthBatch` below, where the decisive one is spelled out:
 *
 *   1. Envio's effect cache keys on the input, and every input here carries the
 *      block number it was read at, so a cache entry could never be hit twice —
 *      the sweep reads a different block every firing. `cache: true` would
 *      persist one row per (batch, block) forever and hit none of them.
 *   2. A FAILED read returns a zero sentinel, and caching that would make a
 *      transient RPC failure permanent.
 *   3. The input is a 400-POSITION ARRAY. The cache key is a TEXT PRIMARY KEY,
 *      so flipping this flag is a fatal StorageError on the first write, not
 *      merely a wasted row.
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
    /*
     * `cache: false`, AND THIS IS NOT A JUDGEMENT CALL — DO NOT FLIP IT.
     *
     * The two reasons in the header are real but only argue that a cache would
     * be useless: the input is block-pinned so no entry could ever be hit
     * twice, and caching the failure sentinel would freeze a transient RPC
     * failure into a permanent zero. Neither is fatal on its own, so both have
     * been re-litigated before. This one settles it:
     *
     * THE CACHE KEY IS THE WHOLE INPUT, VERBATIM, AS A PRIMARY KEY.
     * `UserContext.res.mjs:61` builds `cacheKey` with `Utils.Hash.makeOrThrow`,
     * which despite the name is NOT a digest — `Utils.res.mjs:559-620` is a
     * canonical JSON-ish serialiser that walks the value and concatenates it.
     * The effect cache table is `id` (String, PRIMARY KEY) + `output`
     * (`Internal.res.mjs:315-320`), so that string IS the row id.
     *
     * `positions` here is a 400-entry array (SWEEP_CHUNK), each entry a bytes32
     * poolId plus three numbers — roughly 135 characters serialised, so the key
     * is on the order of 55 KB. Postgres caps a btree index tuple at 2704
     * bytes. `cache: true` would therefore not waste a row; it would raise a
     * StorageError on the FIRST write of every sweep and take the chain down.
     */
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
 * Cached, unlike the batch: the input is one (pool, ticks, block) triple, so
 * the key is a few dozen bytes rather than the batch's ~55 KB, a replay of the
 * same block asks the identical question, and a hit is both possible and
 * correct. The block number is part of the key, which is what makes it sound
 * under reorgs — effect results are not rolled back.
 *
 * ISSUED FROM TWO CALL SITES, AND STILL ONE RPC PER (POOL, TICKS, BLOCK)
 *
 * `utils/feeGate.ts` calls this from the ModifyLiquidity handler's PRELOAD
 * block and again from its real path, so the whole batch's reads go out in
 * parallel instead of one at a time inside the strictly serial handler loop.
 *
 * That is not the "issued twice" that this repo's comments used to assert, and
 * that claim was FALSE ON 3.7.0 wherever it appeared. `UserContext.res.mjs:69`
 * passes `isPreload` through as `shouldGroup`: in the preload pass the calls
 * are grouped and executed, and `LoadLayer.res.mjs:82` writes each successful
 * output into an in-memory dict; in the real pass `shouldGroup` is false, so
 * `LoadManager.res.mjs:80` returns the dict entry without touching the network.
 * The dict is cleared only BEFORE the preload pass, never between the two.
 * Measured on both `cache: true` and `cache: false`: the real pass issues zero
 * additional invocations. The `cache` flag governs DB PERSISTENCE only
 * (`InMemoryStore.res.mjs:66-83` always writes the dict; only `idsToStore` is
 * conditional), which is why `context.cache = false` below still dedupes
 * within the batch while refusing to persist.
 *
 * The corollary the two call sites must respect: the input has to be
 * byte-identical between the passes, because the memo is keyed on it. That is
 * why `feeGate` builds the input in ONE place rather than at each site.
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
    /*
     * 500/s. AFTER THE PRELOAD HOIST THIS LIMITER, NOT RPC LATENCY, IS THE
     * CEILING, so the number is now load-bearing rather than a safety net.
     *
     * HOW IT WAS CHOSEN. config.yaml sets no `disable_default_cross_chain`, so
     * `crossChain` defaults to true and the window is SHARED across every
     * chain: the five currently uncommented chains (1, 10, 42161, 43114, 4663)
     * drew on one 100/s budget, i.e. ~20/s each. 500/s restores the evident
     * intent of the old number — ~100/s per chain at five chains — with the
     * shape of the sharing made explicit instead of accidental.
     *
     * WHAT THE PROVIDER CAN TAKE — and why this is 200 rather than 500.
     *
     * `stateClient` builds its transport with `http(url, { batch: true })` and
     * viem's scheduler defaults to batchSize 1000 / wait 0, so the concurrent
     * calls of a preload pass coalesce into few HTTP requests rather than many.
     * That is the upside. The catch, MEASURED against the real `LoadLayer`:
     * `executeWithRateLimit` releases `availableCalls` simultaneously, so
     * `rateLimit.calls` maps ONE-FOR-ONE onto the WIDTH of the JSON-RPC body
     * that leaves the process — n=600 at calls=100 produced 6 POSTs of width
     * 100 (5036ms); at calls=500, 2 POSTs of width 500 and 100 (1018ms). So
     * this number is a request-size knob, not just a rate knob, and a 500-wide
     * `eth_call` body is the kind of thing an endpoint rejects outright.
     *
     * Overshooting is therefore NOT free, and the failure is silent rather than
     * loud: a provider 429 is caught below and returns `ok: false`, which is
     * deliberately read as "unknown" and FORCES a trace; if that trace also
     * fails, `getFeesAccrued` returns `[]` and the fee is recorded as a plain
     * ZERO with only a log line to distinguish it. Trading a 5x wider request
     * for that risk is a bad trade on an indexer whose hard requirement is
     * exact collected fees.
     *
     * WHY 200 SPECIFICALLY — measured, not picked. The emitted body width is
     * min(rateLimit.calls, queue depth), so the right size is "one batch's
     * worth". Measured on the live 5-chain deployment at ~20% backfill,
     * PositionTransaction rows as a share of events processed:
     *     chain 1      84,257 / 2,010,773 = 4.19%
     *     chain 42161 140,020 / 4,860,676 = 2.88%
     *     chain 4663  424,789 / 8,882,445 = 4.78%
     * At full_batch_size 5000 that is ~145-240 qualifying ModifyLiquidity
     * events per batch, i.e. ~145-240 concurrent reads. So:
     *   100 is BINDING — a typical batch needs two windows for no reason.
     *   200 clears a typical batch in ONE window, body width capped at 200.
     *   500 is IDENTICAL on a typical batch (only ~200 are ever queued) and
     *       differs only on an unusually dense one — which is exactly when it
     *       emits a 500-wide body and invites the rejection described above.
     * 500 therefore buys nothing measurable and only changes behaviour in the
     * bad direction. Note this density is backfill-era; re-measure at head.
     *
     * RAISE IT ONLY AFTER MEASURING the actual provider: watch
     * `envio_effect_call_seconds` against `envio_effect_call_seconds_total`
     * (Metrics.res.mjs:181-183) — their RATIO is the achieved concurrency — and
     * confirm no 429s. Note the local `.env` sets an RPC URL for only two of the
     * five chains, so anyone testing locally is aiming this at keyless public
     * endpoints that will reject a wide batch long before a paid tier would.
     *
     * DO NOT "FIX" THE SHARING WITH `crossChain: false`. The effect cache table
     * is `id` + `output` only (`Internal.res.mjs:315-320`) and its NAME encodes
     * the scope — `envio_effect_<name>` when crossChain, `envio_<chainId>_
     * effect_<name>` when not (`Internal.res.mjs:222-228`, and the same split
     * for the .tsv cache at :295-301). Re-scoping this effect therefore points
     * it at a DIFFERENT table and silently orphans every row already cached, so
     * every historical `getFeeGrowthInside` would be re-read from the node.
     * `rateLimit` is runtime-only and has no cache identity, which is exactly
     * why it is the safe knob here.
     */
    rateLimit: { calls: 200, per: "second" },
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
