/*
 * Periodic uncollected-fee refresh — the port of Ponder's `FeeSync:block`.
 *
 * Ponder declares this as `blocks: { FeeSync: { interval, startBlock: "latest" } }`.
 * The Envio equivalent is `indexer.onBlock` with an `_every` stride, and the
 * handler context is an alias of the event context, so it has both entity writes
 * and the effect caller.
 *
 * `startBlock: "latest"` IS LOAD-BEARING, AND ENVIO CANNOT EXPRESS IT
 *
 * Ponder's sweep runs ONLY at the chain head; it never fires during a historical
 * backfill. Envio's `onBlock` `where` predicate is evaluated once per chain at
 * REGISTRATION time, so it cannot encode head-proximity — a `_every` stride
 * matches historical blocks just the same. Registering this sweep across a
 * backfill range means, for the two chains currently enabled, roughly 14,100
 * firings on Ethereum and 32,150 on Avalanche, each one a stale-set query plus a
 * chunk of RPC, and all of it pure waste: uncollected fees are a CURRENT-STATE
 * quantity, so a value read at historical block N is overwritten by the next
 * firing and is never observable by any consumer.
 *
 * So `startBlock: "latest"` is reproduced in TWO layers (`src/utils/chainHead.ts`).
 *
 * The first is a `_gte` floor at the chain head as of process start, passed to
 * `where`. Envio then never creates a block item below that floor, so a backfill
 * costs nothing here at all — not even a no-op handler call per stride. This is
 * the layer that makes indexing fast, and it is why the sweep's RPC never
 * competes with the backfill for the node.
 *
 * The second is the runtime gate, which handles what a fixed floor cannot: a
 * startup where the head could not be read, and an indexer that LOSES the head
 * later. It latches — once a chain reaches the tip it stays enabled through
 * ordinary lag, and only disables again on a backfill-sized regression.
 *
 * A block-handler item carries only its block NUMBER — Envio builds it "from the
 * handler's own block number, not from the stores" — so neither layer can use a
 * timestamp; both are block-distance tests.
 *
 * FOUR OTHER DELIBERATE DIFFERENCES FROM PONDER
 *
 * 1. It writes `feesUpdatedAtBlock`, never `updatedAtBlock`. Ponder stamps the
 *    single `updatedAtBlock` column on every position each cycle, and that
 *    column is what the backend's live listener watches as a change feed — so
 *    one sweep arrives downstream as the entire active set "changing" and fans
 *    out thousands of position refreshes for quantities that never moved. That
 *    is the reported hourly stall's second half, and separating the two
 *    watermarks is the fix.
 *
 * 2. It reads only IN-RANGE positions. An out-of-range position accrues no new
 *    fees, so its uncollected amount is exactly zero and no read is needed.
 *    Ponder applies the same rule but only AFTER reading, because it needs
 *    `getSlot0` to learn the tick. Envio has the tick from events, so the
 *    in-range set is known before any RPC and the read is proportional to it.
 *
 * 3. It self-heals `liquidity` from the chain for the positions it reads, as
 *    Ponder does — but only for IN-RANGE ones, since those are the only ones it
 *    reads. See the note at the write site.
 *
 * 4. It is bounded per firing. Ponder selects every active position with no
 *    limit, and once one firing exceeds its interval each further interval
 *    queues another full refresh, so the lag can only grow — which is how two of
 *    its four chains ended up permanently frozen.
 */

import { indexer } from "envio";

import { getPositionFeeGrowthBatch } from "../effects/positionState";
import { calculateUncollectedFees } from "../utils/fees";
import { convertTokenToDecimal } from "../utils/index";
import { currentAmounts, isDegenerate, isInRange } from "../utils/positions";
import { v4AddressesFor } from "../utils/v4Addresses";
import { headAtStartup, isAtChainHead } from "../utils/chainHead";
import { feeSweepChainIds } from "../utils/v4Addresses";
import { activeChainIds } from "../utils/chains";

/**
 * Blocks between sweeps, per chain — chosen to land near one hour, matching
 * Ponder's `feeSyncIntervalBlocks` so the refresh cadence is unchanged.
 *
 * Unlike Ponder's, `_every` alignment is deterministic relative to the start
 * block, so the phase does not re-anchor on every process restart.
 */
const SWEEP_INTERVAL_BLOCKS: Readonly<Record<number, number>> = {
  1: 300, // ~12.05s blocks → 60.2 min
  10: 1800, // ~2s → 60 min
  42161: 8000, // ~0.25s → 33 min (Ponder's value)
  43114: 1200, // ~1.06s → 21 min (Ponder's value)
  4663: 36000, // ~0.1s → 60.1 min
};

/**
 * Positions per firing, and per multicall.
 *
 * The cap is the whole point: it makes a firing's cost bounded rather than
 * proportional to the position count, so a sweep can never take longer than its
 * own interval and start compounding.
 *
 * `SWEEP_CHUNK` mirrors Ponder's `refreshChunk` (400): one Multicall3 request
 * carries a whole chunk, so the request count is positions/400 rather than
 * positions. Reading one position per request — which this handler did before —
 * multiplied node load by 400 for identical data.
 */
const SWEEP_BATCH_SIZE = 400;
const SWEEP_CHUNK = 400;

/*
 * The chain heads as of process start, used as a `_gte` floor below.
 *
 * TOP-LEVEL AWAIT, DELIBERATELY. `where` is synchronous and runs once per chain
 * at registration, so the only place to learn the head before registering is
 * here, at module load. `headAtStartup` bounds itself with a timeout and
 * degrades to an empty map, so a sick RPC delays startup by that timeout at
 * worst — it cannot hang or fail the indexer.
 *
 * Only the sweepable chains are asked, so this is at most five cheap calls made
 * in parallel, once per process.
 */
const startupHeads = await headAtStartup(
  // Only chains this process actually indexes. `feeSweepChainIds()` is every
  // chain with a StateView address, which is a superset of the uncommented
  // chains in config.yaml — asking the rest would fire RPC at endpoints we
  // never use. When the config cannot be read the set is empty, and asking
  // nothing would silently disable the floor everywhere, so fall back to the
  // full candidate list in that case.
  (() => {
    const active = activeChainIds();
    const candidates = feeSweepChainIds();
    return active.size === 0 ? candidates : candidates.filter((id) => active.has(id));
  })(),
);

indexer.onBlock(
  {
    name: "feeSync",
    where: ({ chain }) => {
      const interval = SWEEP_INTERVAL_BLOCKS[chain.id];
      // A chain with no StateView address or no interval cannot be swept, and
      // returning false skips it entirely rather than firing a no-op handler.
      if (!interval || !v4AddressesFor(chain.id)) return false;

      /*
       * `_gte` at the head-as-of-startup is what makes a backfill cost NOTHING
       * here, rather than costing a cheap-but-nonzero no-op per stride.
       *
       * Without it Envio generates a block item for every `_every` stride across
       * the whole historical range — ~14,100 on Ethereum and ~32,150 on
       * Avalanche — and invokes the handler for each, which then has to ask
       * whether it is at the head and return. With it, those items are never
       * created: the sweep begins firing exactly when indexing reaches the tip.
       *
       * `_every` alignment becomes relative to `_gte` (per Envio's own docs on
       * the filter), which is fine — the stride's phase is arbitrary, only its
       * period matters.
       *
       * A chain missing from the map is one whose head could not be read at
       * startup. It registers with no floor, exactly as before, and the runtime
       * gate in the handler carries the whole burden. Slower, never wrong.
       */
      const floor = startupHeads.get(chain.id);
      return floor === undefined
        ? { block: { number: { _every: interval } } }
        : { block: { number: { _every: interval, _gte: floor } } };
    },
  },
  async ({ block, context }) => {
    /*
     * Envio runs block handlers TWICE — once with `isPreload: true` to warm
     * loads and effects in parallel, then again for real (`EventProcessing.res`
     * dispatches `Block(...)` items in the preload pass). Entity writes are
     * safely discarded in that pass (`set` is `noopSet` under preload), so
     * nothing double-counts, but the RPC is NOT free: this sweep's fee read is
     * uncached by design (its input is block-pinned, so a cache entry could
     * never be hit twice), which means the preload pass issues the whole
     * multicall, throws the result away, and the real pass issues it again.
     *
     * Returning early halves the sweep's node load. Nothing is lost by skipping
     * the warm-up: the sweep's reads are one batched effect the real pass
     * awaits anyway, not the many independent loads preload exists to overlap.
     */
    if (context.isPreload) return;

    const chainId = context.chain.id;
    const addresses = v4AddressesFor(chainId);
    if (!addresses) return;

    const interval = BigInt(SWEEP_INTERVAL_BLOCKS[chainId] ?? 0);
    const blockNumber = BigInt(block.number);

    /*
     * The runtime head gate — now a SECOND line of defence rather than the
     * first, since the `_gte` floor above normally stops these items existing.
     *
     * It still matters in two cases. One: the startup head could not be read,
     * so there is no floor. Two: the indexer LOSES the head later — an RPC
     * outage or a deep rollback leaves it processing blocks that are above the
     * floor but far below the current tip, and sweeping those is as pointless as
     * sweeping a backfill.
     *
     * `isAtChainHead` LATCHES: once a chain has reached the tip it stays enabled
     * through ordinary lag, and only switches off again on a backfill-sized
     * regression. That is what stops the sweep flapping on and off during normal
     * live operation, where being a few hundred blocks behind between firings is
     * expected rather than exceptional.
     */
    if (!(await isAtChainHead(chainId, blockNumber, interval, context.log))) return;

    /*
     * WHEN THE SWEEP RAN — not the block's own time, which a block handler is
     * never given (see the header).
     *
     * These are two different facts and the row records both: the VALUE is as of
     * `feesUpdatedAtBlock`, and `feesUpdatedAtTimestamp` is when we measured it.
     * They coincide while the indexer is at the tip, and the gate above is
     * latched, so they can diverge by up to the relatch window — a few hours —
     * when the indexer is lagging. A consumer that cares about the data's age
     * should read `feesUpdatedAtBlock`; this column answers "when did the
     * refresh last run", which is what a staleness monitor wants.
     *
     * The port previously wrote `position.feesUpdatedAtTimestamp` here, i.e. the
     * row's own previous value, which left it permanently 0.
     */
    const sweptAt = BigInt(Math.floor(Date.now() / 1000));

    // Ask for the positions this cycle has not refreshed, rather than reading
    // every active position and sorting in memory. `feesUpdatedAtBlock` is
    // indexed for exactly this query, which is what keeps the working set
    // bounded — Ponder's unbounded `select ... where isActive` is the reason one
    // slow firing there compounds into a permanent stall.
    // `_lte`, not `_lt`: consecutive `_every` firings are exactly `interval`
    // apart, so a row stamped at the previous firing has
    // `feesUpdatedAtBlock === blockNumber - interval` exactly. Under `_lt` it
    // misses by one and waits a further full interval, halving the real refresh
    // cadence relative to the one configured above.
    const cutoff = blockNumber - interval;
    const stale = await context.Position.getWhere({
      chainId: { _eq: BigInt(chainId) },
      feesUpdatedAtBlock: { _lte: cutoff < 0n ? 0n : cutoff },
    });

    // A position with no liquidity earns nothing, and one with no pool has not
    // seen its first ModifyLiquidity yet.
    //
    // Sorted explicitly by watermark. `getWhere` gives no ordering guarantee, so
    // the "oldest fee-read first" rotation this cap depends on is not free: an
    // arbitrary order can re-pick the same 400 rows every firing and starve the
    // rest indefinitely.
    const candidates = stale
      .filter((p) => p.isActive && p.liquidity > 0n && p.poolId !== "")
      .sort((a, b) => (a.feesUpdatedAtBlock < b.feesUpdatedAtBlock ? -1 : a.feesUpdatedAtBlock > b.feesUpdatedAtBlock ? 1 : 0))
      .slice(0, SWEEP_BATCH_SIZE);

    if (candidates.length === 0) return;

    // Partition before any RPC: an out-of-range position provably has zero
    // uncollected fees, so it needs no read at all.
    const toRead: typeof candidates = [];
    let zeroed = 0;
    let skipped = 0;

    for (const position of candidates) {
      const pool = await context.Pool.get(`${chainId}_${position.poolId}`);
      if (!pool) {
        skipped += 1;
        continue;
      }
      const poolTick = pool.tick ?? 0n;

      if (!isInRange(position.tickLower, position.tickUpper, poolTick)) {
        zeroed += 1;
        context.Position.set({
          ...position,
          totalFeesUncollected0: convertTokenToDecimal(0n, 0n),
          totalFeesUncollected1: convertTokenToDecimal(0n, 0n),
          feesUpdatedAtBlock: blockNumber,
          feesUpdatedAtTimestamp: sweptAt,
        });
        continue;
      }
      toRead.push(position);
    }

    // One Multicall3 per chunk, as Ponder does.
    let read = 0;
    let failed = 0;

    for (let start = 0; start < toRead.length; start += SWEEP_CHUNK) {
      const chunk = toRead.slice(start, start + SWEEP_CHUNK);
      const states = await context.effect(getPositionFeeGrowthBatch, {
        chainId,
        stateView: addresses.stateView,
        positionManager: addresses.positionManager,
        multicall3: addresses.multicall3,
        blockNumber,
        positions: chunk.map((p) => ({
          tokenId: p.tokenId,
          poolId: p.poolId,
          tickLower: Number(p.tickLower),
          tickUpper: Number(p.tickUpper),
        })),
      });

      const byTokenId = new Map(states.map((s) => [s.tokenId, s]));

      for (const position of chunk) {
        const state = byTokenId.get(position.tokenId);
        const pool = await context.Pool.get(`${chainId}_${position.poolId}`);
        if (!pool) {
          skipped += 1;
          continue;
        }
        const token0 = await context.Token.get(pool.token0);
        const token1 = await context.Token.get(pool.token1);
        if (!token0 || !token1) {
          skipped += 1;
          continue;
        }

        // A failed read keeps the previous uncollected value — a stale fee is
        // recoverable, a fabricated zero is not distinguishable from a real one.
        //
        // But the watermark IS stamped either way, which is Ponder's behaviour:
        // its per-position write is unconditional and falls back to the stored
        // liquidity when the call failed. Skipping the write instead leaves the
        // row below the cutoff forever, so a persistently failing read re-selects
        // the same positions on every firing and the stale set can only grow —
        // which is exactly what a broken multicall produced here.
        if (!state || !state.ok) {
          failed += 1;
          context.Position.set({
            ...position,
            feesUpdatedAtBlock: blockNumber,
            feesUpdatedAtTimestamp: sweptAt,
          });
          continue;
        }
        read += 1;

        const uncollected = calculateUncollectedFees(
          // The on-chain liquidity, not our running sum: if they disagree, the
          // contract is right and the fee must be computed against its value.
          state.liquidity,
          state.feeGrowthInside0X128,
          state.feeGrowthInside1X128,
          state.feeGrowthInside0LastX128,
          state.feeGrowthInside1LastX128,
        );

        // Refresh the pooled amounts too. Ponder recomputes these every sweep
        // from live slot0, because a position's token split moves with the pool
        // price even when the position itself never changes. Computing them only
        // on ModifyLiquidity leaves them frozen at the last liquidity event.
        // The tick here is event-maintained rather than read, so this costs no
        // RPC — and it is guarded by the same degenerate-pool check Ponder
        // applies, since tick math at the domain edges produces garbage.
        const poolTick = pool.tick ?? 0n;
        const degenerate = isDegenerate(poolTick, pool.sqrtPrice);
        const amounts = degenerate
          ? { amount0: position.amount0, amount1: position.amount1 }
          : currentAmounts({
              tickLower: position.tickLower,
              tickUpper: position.tickUpper,
              liquidity: state.liquidity,
              pool: { tick: poolTick, sqrtPriceX96: pool.sqrtPrice },
              decimals0: token0.decimals,
              decimals1: token1.decimals,
            });

        /*
         * SELF-HEAL from the chain, which Ponder does on every sweep.
         *
         * `position.liquidity` is a running sum of `liquidityDelta` over the
         * events we saw; `state.liquidity` is what the contract holds right now.
         * They should be equal, and if they are not the contract is right —
         * Ponder writes the on-chain value unconditionally
         * (apps/v4/src/index.ts:452-459) precisely so a missed or out-of-order
         * event heals on the next cycle instead of drifting forever.
         *
         * LIMIT, STATED HONESTLY: this port only reads IN-RANGE positions (that
         * is what makes the sweep cheap), so only they are healed. An
         * out-of-range position keeps its running sum until it comes back into
         * range. Ponder pays an RPC per active position to cover both; the
         * trade is deliberate, not an oversight.
         */
        const healedLiquidity = state.liquidity;
        const nowActive = healedLiquidity > 0n;

        context.Position.set({
          ...position,
          liquidity: healedLiquidity,
          isActive: nowActive,
          // Closing and reopening, mirroring Ponder's two branches: stamp on the
          // transition to zero, preserve an existing close time, and CLEAR it
          // when liquidity returns so a reopened position is not left looking
          // closed.
          closedAtTimestamp: nowActive
            ? undefined
            : (position.closedAtTimestamp ?? sweptAt),
          totalFeesUncollected0: convertTokenToDecimal(uncollected.amount0, token0.decimals),
          totalFeesUncollected1: convertTokenToDecimal(uncollected.amount1, token1.decimals),
          amount0: amounts.amount0,
          amount1: amounts.amount1,
          // Re-baseline to the contract's stored last, so accrual resumes
          // cleanly on range re-entry. Ponder does this on both branches; the
          // port previously never wrote these at all, which left the baseline
          // permanently zero and the trace gate unable to detect a settle.
          feeGrowthInside0LastX128: state.feeGrowthInside0LastX128,
          feeGrowthInside1LastX128: state.feeGrowthInside1LastX128,
          // ONLY the fee watermark. `updatedAtBlock` is untouched on purpose.
          feesUpdatedAtBlock: blockNumber,
          feesUpdatedAtTimestamp: sweptAt,
        });
      }
    }

    context.log.info(
      `feeSync chain=${chainId} block=${block.number} candidates=${candidates.length} ` +
        `read=${read} failed=${failed} zeroed-out-of-range=${zeroed} skipped=${skipped}`,
    );
  },
);
