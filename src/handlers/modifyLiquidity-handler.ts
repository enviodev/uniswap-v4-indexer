/*
 * Liquidity event handlers for Uniswap v4 pools
 */
import { indexer } from "envio";
import {
  getAmount0,
  getAmount1,
} from "../utils/liquidityMath/liquidityAmounts";
import {
  currentAmounts,
  gasCostEth,
  isDegenerate,
  newPosition,
  positionId,
  positionTxId,
  tokenIdFromSalt,
} from "../utils/positions";
import { getFeesAccrued } from "../effects/feesAccrued";
import {
  feeGate,
  readFeeGrowthInside,
  shouldTraceFees,
  type FeeGateEvent,
} from "../utils/feeGate";
import { positionManagerFor } from "../utils/v4Addresses";
import { ZERO_BD } from "../utils/constants";
import { convertTokenToDecimal, sanitizeBD } from "../utils";
import { createInitialTick } from "../utils/tick";
import { getChainConfig } from "../utils/chains";
import {
  preloadIntervalData,
  updatePoolDayData,
  updatePoolHourData,
  updateTokenDayData,
  updateTokenHourData,
  updateUniswapDayData,
} from "../utils/intervalUpdates";

/**
 * Chains already warned about a missing PositionManager entry, so the warning
 * is one line per chain rather than one per event. Module-level, matching the
 * existing per-chain caches in utils/chainHead.ts and effects/feesAccrued.ts.
 */
const warnedNoPositionManager = new Set<number>();

indexer.onEvent({ contract: "PoolManager", event: "ModifyLiquidity" }, async ({ event, context }) => {
  // Get chain config for pools to skip
  const chainConfig = getChainConfig(event.chainId);

  // Check if this pool should be skipped
  // NOTE: Subgraph only has this check in Initialize handler since skipped pools
  // are never created, but we keep it here for safety in case we switch to
  // getOrThrow APIs in the future and don't want exceptions thrown
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  const poolId = `${event.chainId}_${event.params.id}`;

  // tick entities
  const lowerTickId = poolId + "#" + BigInt(event.params.tickLower).toString();
  const upperTickId = poolId + "#" + BigInt(event.params.tickUpper).toString();

  // Fetch pool + ticks concurrently
  const [existingPool, existingLowerTick, existingUpperTick] =
    await Promise.all([
      context.Pool.get(poolId),
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
    ]);
  if (!existingPool) return;

  // Fetch tokens, bundle, poolManager, and hookStats concurrently
  const isHookedPool =
    existingPool.hooks !== "0x0000000000000000000000000000000000000000";
  const hookStatsId = isHookedPool
    ? `${event.chainId}_${existingPool.hooks}`
    : undefined;

  const [existingToken0, existingToken1, bundle, existingPoolManager, existingHookStats] =
    await Promise.all([
      context.Token.get(existingPool.token0),
      context.Token.get(existingPool.token1),
      context.Bundle.get(event.chainId.toString()),
      context.PoolManager.getOrThrow(
        `${event.chainId}_${event.srcAddress}`
      ),
      hookStatsId ? context.HookStats.get(hookStatsId) : undefined,
    ]);
  if (!existingToken0 || !existingToken1 || !bundle) return;

  /*
   * The fee gate's whole input, built ONCE and shared by both passes.
   *
   * `existingPool` rather than the mutated `pool` below, and that is exact, not
   * approximate: `pool` is `{...existingPool}` with `txCount`,
   * `totalValueLockedToken0/1`, `liquidity`, `totalValueLockedETH` and
   * `totalValueLockedUSD` overridden (the `let pool = {...}` block below, and
   * the two reassignments after it — :240-284 at the time of writing). `tick` and
   * `sqrtPrice` — the only two fields `isDegenerate` reads — are never touched,
   * so the predicate cannot differ between the two objects.
   *
   * One object, not two constructions, because the effect memo is keyed on the
   * input: if the preload pass and the real pass built even slightly different
   * inputs, the real pass would miss the dict and pay full RPC latency inside
   * the strictly serial handler loop. See utils/feeGate.ts for the mechanism.
   */
  const feeGateEvent: FeeGateEvent = {
    chainId: event.chainId,
    sender: event.params.sender,
    salt: event.params.salt,
    poolId: event.params.id,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    blockNumber: event.block.number,
    poolTick: existingPool.tick,
    poolSqrtPrice: existingPool.sqrtPrice,
  };

  if (context.isPreload) {
    /*
     * Everything this handler can possibly need from the network or the store,
     * issued HERE so the whole batch's reads overlap.
     *
     * `preloadBatchOrThrow` runs every handler in the batch concurrently;
     * `runBatchHandlersOrThrow` then runs them one at a time. A read left
     * behind the `return` below is therefore a read taken at full latency, in
     * series, once per event — which is what `getFeeGrowthInside` was, and it
     * is issued on nearly every PositionManager ModifyLiquidity.
     *
     * The two entity reads are the same story without the RPC:
     * `Position.get` and `PositionTransaction.getWhere` are one SELECT each per
     * event in the serial pass, and collapse into grouped queries under preload
     * (`UserContext.res.mjs:69,84` pass `isPreload` through as `shouldGroup`).
     *
     * Results are discarded, exactly as `preloadIntervalData` documents at
     * utils/intervalUpdates.ts:159-171 — the point is the side effect on the
     * load layer and the effect output dict, which the real pass reads back.
     *
     * `getFeesAccrued` is deliberately NOT hoisted. It is gated on the RESULT of
     * `getFeeGrowthInside`, so hoisting it means tracing speculatively, and at
     * {calls: 20, per: "second"} those speculative traces would displace real
     * ones in the same rate-limit window for an upside capped near 1x.
     */
    const gate = feeGate(feeGateEvent);
    await Promise.all([
      // Warm the interval rows here - see the note in swap-handler.ts.
      preloadIntervalData(context, {
        blockTimestamp: event.block.timestamp,
        chainId: event.chainId,
        poolId,
        tokenIds: [existingToken0.id, existingToken1.id],
        includeUniswapDayData: true,
      }),
      readFeeGrowthInside(context, feeGateEvent),
      // Only for a PositionManager caller: a non-attributable event never
      // reaches either read in the real pass, so warming them would be a query
      // spent on nothing.
      gate.attributable
        ? context.PositionTransaction.getWhere({
            txHash: { _eq: event.transaction.hash },
          })
        : undefined,
      gate.tokenId !== undefined
        ? context.Position.get(positionId(event.chainId, gate.tokenId))
        : undefined,
    ]);
    return;
  }

  // --- Tick updates ---
  const lowerTickIdx = Number(event.params.tickLower);
  const upperTickIdx = Number(event.params.tickUpper);
  const amount = event.params.liquidityDelta;

  let lowerTick =
    existingLowerTick ??
    createInitialTick(
      lowerTickId,
      lowerTickIdx,
      poolId,
      BigInt(event.block.timestamp),
      BigInt(event.block.number)
    );
  let upperTick =
    existingUpperTick ??
    createInitialTick(
      upperTickId,
      upperTickIdx,
      poolId,
      BigInt(event.block.timestamp),
      BigInt(event.block.number)
    );

  lowerTick = {
    ...lowerTick,
    liquidityGross: lowerTick.liquidityGross + amount,
    liquidityNet: lowerTick.liquidityNet + amount,
  };
  upperTick = {
    ...upperTick,
    liquidityGross: upperTick.liquidityGross + amount,
    liquidityNet: upperTick.liquidityNet - amount,
  };

  // Save tick entities
  context.Tick.set(lowerTick);
  context.Tick.set(upperTick);

  // --- Pool, token, and manager updates ---
  const currTick = existingPool.tick ?? 0n;
  const currSqrtPriceX96 = existingPool.sqrtPrice ?? 0n;
  // Calculate the token amounts from the liquidity change
  const amount0Raw = getAmount0(
    event.params.tickLower,
    event.params.tickUpper,
    currTick,
    event.params.liquidityDelta,
    currSqrtPriceX96
  );
  const amount1Raw = getAmount1(
    event.params.tickLower,
    event.params.tickUpper,
    currTick,
    event.params.liquidityDelta,
    currSqrtPriceX96
  );
  // Convert to proper decimals
  const amount0 = convertTokenToDecimal(amount0Raw, existingToken0.decimals);
  const amount1 = convertTokenToDecimal(amount1Raw, existingToken1.decimals);

  // Calculate amountUSD based on token prices
  const amountUSD = amount0
    .times(existingToken0.derivedETH)
    .plus(amount1.times(existingToken1.derivedETH))
    .times(bundle.ethPriceUSD);

  // Update pool TVL and txCount
  let pool = {
    ...existingPool,
    txCount: existingPool.txCount + 1n,
    totalValueLockedToken0: existingPool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: existingPool.totalValueLockedToken1.plus(amount1),
  };
  // Only update liquidity if position is in range and tick is initialized
  if (
    pool.tick !== null &&
    pool.tick !== undefined &&
    event.params.tickLower <= pool.tick &&
    event.params.tickUpper > pool.tick
  ) {
    pool = {
      ...pool,
      liquidity: pool.liquidity + event.params.liquidityDelta,
    };
  }
  // Update token TVL and txCount
  let token0 = {
    ...existingToken0,
    txCount: existingToken0.txCount + 1n,
    totalValueLocked: existingToken0.totalValueLocked.plus(amount0),
  };
  let token1 = {
    ...existingToken1,
    txCount: existingToken1.txCount + 1n,
    totalValueLocked: existingToken1.totalValueLocked.plus(amount1),
  };
  // Store current pool TVL for later
  const currentPoolTvlETH = pool.totalValueLockedETH;
  const currentPoolTvlUSD = pool.totalValueLockedUSD;
  // After updating token TVLs, calculate ETH and USD values
  pool = {
    ...pool,
    totalValueLockedETH: pool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
  };
  pool = {
    ...pool,
    totalValueLockedUSD: sanitizeBD(
      pool.totalValueLockedETH.times(bundle.ethPriceUSD)
    ),
  };
  // Update token totalValueLockedUSD
  token0 = {
    ...token0,
    totalValueLockedUSD: token0.totalValueLocked.times(
      token0.derivedETH.times(bundle.ethPriceUSD)
    ),
  };
  token1 = {
    ...token1,
    totalValueLockedUSD: token1.totalValueLocked.times(
      token1.derivedETH.times(bundle.ethPriceUSD)
    ),
  };
  // Update PoolManager
  let poolManager = {
    ...existingPoolManager,
    txCount: existingPoolManager.txCount + 1n,
    // Reset and recalculate TVL
    totalValueLockedETH: existingPoolManager.totalValueLockedETH
      .minus(currentPoolTvlETH)
      .plus(pool.totalValueLockedETH),
  };
  poolManager = {
    ...poolManager,
    totalValueLockedUSD: poolManager.totalValueLockedETH.times(
      bundle.ethPriceUSD
    ),
  };

  // ---- interval data (day / hour snapshots) ----
  // ModifyLiquidity contributes NO volume and NO fees, only the txCount bump
  // and the price / TVL snapshot - matching
  // v4-subgraph/src/mappings/modifyLiquidity.ts:176-182, which discards every
  // return value and has no follow-up mutation block.
  const blockTimestamp = event.block.timestamp;
  await Promise.all([
    updateUniswapDayData(context, poolManager, blockTimestamp),
    updatePoolDayData(context, pool, blockTimestamp),
    updatePoolHourData(context, pool, blockTimestamp),
    updateTokenDayData(context, token0, bundle.ethPriceUSD, blockTimestamp),
    updateTokenHourData(context, token0, bundle.ethPriceUSD, blockTimestamp),
    updateTokenDayData(context, token1, bundle.ethPriceUSD, blockTimestamp),
    updateTokenHourData(context, token1, bundle.ethPriceUSD, blockTimestamp),
  ]);

  // Create ModifyLiquidity entity
  const modifyLiquidityId = `${event.chainId}_${event.transaction.hash}_${event.logIndex}`;
  const modifyLiquidity = {
    id: modifyLiquidityId,
    transaction: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    pool_id: pool.id,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    amount: event.params.liquidityDelta,
    amount0: amount0,
    amount1: amount1,
    amountUSD: sanitizeBD(amountUSD),
    tickLower: BigInt(event.params.tickLower),
    tickUpper: BigInt(event.params.tickUpper),
    logIndex: BigInt(event.logIndex),
  };

  // Check if this is a hooked pool and update HookStats
  if (isHookedPool && existingHookStats) {
    // Update the TVL for this hook
    context.HookStats.set({
      ...existingHookStats,
      totalValueLockedUSD: existingHookStats.totalValueLockedUSD
        .minus(currentPoolTvlUSD) // Remove old TVL
        .plus(pool.totalValueLockedETH.times(bundle.ethPriceUSD)), // Add new TVL
    });
  }

  context.ModifyLiquidity.set(modifyLiquidity);
  context.PoolManager.set(poolManager);
  context.Pool.set(pool);
  context.Token.set(token0);
  context.Token.set(token1);

  // ─── Position attribution ──────────────────────────────────────────────────
  //
  // `salt` IS the NFT tokenId (PositionManager packs it there; Ponder relies on
  // the same fact at apps/v4/src/index.ts:176). Without reading it this event is
  // position-blind and none of the position surface can exist.
  //
  // Everything below is derived from the event plus state this handler already
  // computed — no RPC. Fee columns are deliberately left at their previous
  // values: `totalFeesUncollected*` needs getFeeGrowthInside and
  // `totalFeesCollected*` needs the `feesAccrued` return value of
  // modifyLiquidity, which is in no log. Both arrive via effects later.
  //
  // ─── NFT POSITIONS ONLY: the caller MUST be the PositionManager ────────────
  //
  // `salt` is an NFT tokenId only when the PositionManager put it there. The
  // v4 position key is (owner = msg.sender, tickLower, tickUpper, salt) — see
  // the `getPositionInfo` ABI in effects/positionState.ts:65-79 — and `salt` is
  // a CALLER-SUPPLIED bytes32 with no constraint on its value
  // (effects/feesAccrued.ts:53-62). Any contract that opens a PoolManager lock
  // can therefore call modifyLiquidity with any salt it likes: hooks, custom
  // routers, vaults, and third-party position managers all do.
  //
  // Ponder filters on exactly this, as the FIRST statement of its handler, and
  // its config delivers every ModifyLiquidity unfiltered (`args: {}`), so this
  // one line is the whole guard there:
  //
  //     if (sender.toLowerCase() !== POSITION_MANAGER_ADDRESS) return;
  //         — apps/v4/src/index.ts:165
  //
  // Without it, a non-NFT salt becomes a tokenId and gets a Position row. Two
  // consequences, the second severe:
  //
  //   1. Junk rows. `Position.tokenId` is a BigInt, so it always serialises as
  //      decimal digits and always passes the backend's only defence — the
  //      `/^\d+$/` format test at
  //      backend/src/subgraph/adapters/ponder-compatible.adapter.ts:732. That
  //      filter was written for the vanilla subgraph's COMPOUND HEX ids; it is
  //      inert against this shape. So the rows reach the leaderboard as real
  //      positions, owned by whichever EOA sent the transaction.
  //
  //   2. Collision with a REAL position. The row key is `<chainId>_<tokenId>`,
  //      so a salt that is numerically equal to a live NFT id writes the SAME
  //      row. PositionManager tokenIds are a counter from 1, so the populated
  //      range is small integers — precisely what a vault indexing its
  //      positions, or any other v4 position manager running its own counter
  //      from 1, would use as a salt. The write then clobbers the genuine
  //      position's `poolId`, ticks, and running `liquidity` while KEEPING its
  //      owner and created-at, and the next sweep asks
  //      getPositionInfo(<hook pool>, PositionManager, <hook ticks>, salt),
  //      gets liquidity 0, and zeroes the real user's `amount0`/`amount1`.
  //
  // Placed AFTER the pool/token/tick/interval writes above and before the gas
  // query below: those mirror the vanilla subgraph, which counts every
  // ModifyLiquidity regardless of caller, so the return must not skip them.
  // It cannot be an Envio `eventFilters` on the indexed `sender` either — that
  // would drop the event before those writes.
  const positionManager = positionManagerFor(event.chainId);
  if (!positionManager) {
    // Refuse to attribute rather than attribute wrongly. Such a chain has no
    // fee sweep either (feeSync-block.ts:97 gates on `v4AddressesFor`), so its
    // position rows would never get uncollected fees or refreshed amounts — a
    // half-built row that reads as real is worse than no row. Warned once per
    // chain so enabling a chain without a table entry is loud, not silent.
    if (!warnedNoPositionManager.has(event.chainId)) {
      warnedNoPositionManager.add(event.chainId);
      context.log.warn(
        `No PositionManager address for chain ${event.chainId} — position ` +
          `attribution is DISABLED on this chain. Add its config.yaml ` +
          `PositionManager to POSITION_MANAGERS in src/utils/v4Addresses.ts.`,
      );
    }
    return;
  }
  // `sender` is an EIP-55 checksummed address: `address_format` defaults to
  // `checksum` (node_modules/envio/src/Config.res:663) and config.yaml does not
  // override it, which is also why initialize-handler.ts:97 lowercases.
  if (event.params.sender.toLowerCase() !== positionManager) return;

  const fullTxGasCostETH = gasCostEth(
    event.transaction.gasUsed,
    event.transaction.effectiveGasPrice,
    event.transaction.l1Fee,
  );

  /*
   * Gas is a property of the TRANSACTION, so it is charged exactly once no
   * matter how many positions that transaction touches.
   *
   * Ponder does this by counting rows of the same tx with a STRICTLY LOWER log
   * index and charging the full amount only when there are none, so the cost
   * lands on the lowest-logIndex row-writing event and nowhere else
   * (apps/v4/src/index.ts:270-282). Strictly-lower is what makes it replay-safe:
   * an event's own row, recreated on a replay, has the same logIndex and so can
   * never disqualify itself.
   *
   * The port previously added the full transaction gas to EVERY position it
   * touched, so a router batching n positions overstated gas n-fold — and
   * `totalGasCostETH` feeds net-of-cost performance, so that inflates a real
   * customer-visible figure.
   */
  const priorRowsThisTx = await context.PositionTransaction.getWhere({
    txHash: { _eq: event.transaction.hash },
  });
  const isGasBearer = !priorRowsThisTx.some(
    (r) => r.chainId === BigInt(event.chainId) && r.logIndex < BigInt(event.logIndex),
  );
  const txGasCostETH = isGasBearer ? fullTxGasCostETH : ZERO_BD;

  const tokenId = tokenIdFromSalt(event.params.salt);
  if (tokenId !== undefined) {
    const pid = positionId(event.chainId, tokenId);
    const existing =
      (await context.Position.get(pid)) ??
      newPosition({
        id: pid,
        chainId: BigInt(event.chainId),
        tokenId,
        // A ModifyLiquidity can precede the mint Transfer, so ownership is
        // provisional here and the Transfer handler corrects it.
        owner: event.transaction.from || "NONE",
        origin: event.transaction.from || "NONE",
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
      });

    const delta = event.params.liquidityDelta;
    const isAdd = delta > 0n;
    const rawNextLiquidity = existing.liquidity + delta;

    // On-chain liquidity cannot go negative; a negative running sum means a
    // missed or out-of-order event. Ponder clamps to zero and WARNS rather than
    // storing the negative (apps/v4/src/index.ts:192-198) — storing it would
    // propagate into `isActive`, the amount math and every aggregate below.
    if (rawNextLiquidity < 0n) {
      context.log.warn(
        `ModifyLiquidity: negative liquidity for position ${tokenId} ` +
          `(prev=${existing.liquidity} delta=${delta}) — clamping to 0`,
      );
    }
    const nextLiquidity = rawNextLiquidity < 0n ? 0n : rawNextLiquidity;

    // Tick math is meaningless at the edges of the representable domain, where
    // it returns numbers that are enormous but physically absurd. Ponder gates
    // every amount on this and so does the sweep.
    const degenerate = isDegenerate(pool.tick ?? 0n, pool.sqrtPrice ?? 0n);

    // EXACT collected fees, from the call trace.
    //
    // `feesAccrued` is a RETURN VALUE of PoolManager.modifyLiquidity and appears
    // in no event — v4 has no Collect event and this event carries no fee field
    // — so a trace is the only foolproof source. Ported from Ponder's
    // core/fees-trace.ts, and the effect returns every salt in the transaction
    // at once so a batched multi-position tx costs one trace.
    //
    /*
     * PONDER'S FREE TRACE-SKIP, which is the difference between tracing every
     * ModifyLiquidity and tracing only the ones that settled a fee.
     *
     * Ponder gates the trace on a three-way AND (apps/v4/src/index.ts:222):
     *
     *     existing && prevLiquidity > 0n && feeGrowthChanged
     *
     * where `feeGrowthChanged` compares the pool's CURRENT `feeGrowthInside`
     * against the baseline stored on the position at its last settle. If they
     * are equal, no fee has accrued since that settle, so `feesAccrued` is
     * provably zero and there is nothing for a trace to discover. The other two
     * conjuncts are the same argument: a position that does not exist yet, or
     * held no liquidity, cannot have accrued anything.
     *
     * Ponder claims it only ever skips provably-zero cases. THAT CLAIM IS
     * FALSE ON A DECREASE, and `shouldTraceFees` below no longer relies on it
     * there — see its docstring in utils/feeGate.ts for the (0, 0)-from-cleared-
     * ticks hole and the Avalanche tokenId 137 ground truth. On an INCREASE the
     * argument holds and the heuristic is kept in full.
     *
     * An out-of-range position's fee growth still CHANGES, so it is still
     * traced and still exact, which is why this is not the out-of-range
     * shortcut the port previously used.
     *
     * The port had this as an OR of two conditions, which traced essentially
     * every event: one `debug_traceTransaction` per ModifyLiquidity, the most
     * expensive call in the indexer, against a rate limit. This trades it for
     * one `getFeeGrowthInside` eth_call, which is cheap and cached.
     */
    const hadPosition = existing.poolId !== "";
    const gateCanPass = !degenerate && hadPosition && existing.liquidity > 0n;

    /*
     * THE SAME CALL THE PRELOAD BLOCK ABOVE ALREADY MADE, with the same
     * `feeGateEvent`, so this normally resolves from the effect output dict
     * without touching the network (`LoadManager.res.mjs:80`). It stays here
     * rather than being read out of a variable so that the real path remains
     * correct on its own — a preload pass that was skipped, or whose throw was
     * swallowed, costs latency here and nothing else.
     *
     * The predicate lives in `feeGate` (utils/feeGate.ts) and is NOT repeated
     * here. Two copies is the specific failure this refactor exists to prevent:
     * a preload copy that drifts from the real one either warms an input nobody
     * asks for or, worse, misses the one that is asked for and puts a full RPC
     * round trip back inside the serial loop.
     *
     * Within this branch the gate reduces to `!degenerate` — the caller is
     * already known to be the PositionManager and `tokenId` is already known to
     * exist — which is exactly where Ponder has it
     * (apps/v4/src/index.ts:211-212), and deliberately NOT on `gateCanPass`.
     * Gating the READ on `gateCanPass` silently lost fees: a mint has
     * `hadPosition === false`, so the read was skipped and
     * `feeGrowthInside0/1LastX128` kept `newPosition()`'s default of 0n, which
     * is indistinguishable from the genuine (0, 0) that a cleared tick pair
     * reports on the eventual close. Measured on Avalanche tokenId 1097 and
     * Arbitrum tokenIds 268 and 771.
     */
    const fgNow = await readFeeGrowthInside(context, feeGateEvent);

    // A FAILED read is not "unchanged". Treating it as unchanged would skip the
    // trace and silently record no collected fee, so an unknown answer forces
    // the trace — the direction that cannot fabricate a zero.
    const feeGrowthChanged =
      !!fgNow &&
      (!fgNow.ok ||
        fgNow.feeGrowthInside0X128 !== existing.feeGrowthInside0LastX128 ||
        fgNow.feeGrowthInside1X128 !== existing.feeGrowthInside1LastX128);

    // Re-baseline to what the pool reports now, so the next event's comparison
    // is against this settle. Ponder advances this even when the trace fails,
    // so accounting stays consistent and only that one collect is under-counted.
    const fg0Last = fgNow?.ok ? fgNow.feeGrowthInside0X128 : existing.feeGrowthInside0LastX128;
    const fg1Last = fgNow?.ok ? fgNow.feeGrowthInside1X128 : existing.feeGrowthInside1LastX128;

    let settled0 = ZERO_BD;
    let settled1 = ZERO_BD;
    /*
     * `gateCanPass && (feeGrowthChanged || liquidityDelta < 0n)`.
     *
     * The disjunct is the reason a re-index is being spent, and the full
     * argument — including the Avalanche tokenId 137 ground truth and why this
     * DIVERGES FROM PONDER on purpose — is on `shouldTraceFees` in
     * utils/feeGate.ts. In one line: `getFeeGrowthInside` returns exactly (0, 0)
     * from a CLEARED tick pair, which is the state a full close leaves, so on a
     * close the baseline and the fresh read are both 0, `feeGrowthChanged` is
     * false, and the collected fee was silently recorded as ZERO. A v4 liquidity
     * decrease always returns `feesAccrued`, so the heuristic has nothing useful
     * to add on that path and is dropped there.
     */
    if (
      shouldTraceFees({
        gateCanPass,
        feeGrowthChanged,
        liquidityDelta: event.params.liquidityDelta,
      })
    ) {
      const fees = await context.effect(getFeesAccrued, {
        chainId: event.chainId,
        txHash: event.transaction.hash,
        poolManager: chainConfig.poolManagerAddress,
      });
      // LAST match, not first. The effect returns one entry per
      // modifyLiquidity frame, and a transaction can legitimately contain two
      // frames for the same salt; Ponder collects them into a Map keyed by salt
      // (core/fees-trace.ts:116), so a repeated salt resolves to the last
      // frame. `.find` took the first, which is a different number.
      const mine = [...fees].reverse().find((f) => f.salt === tokenId.toString());
      if (mine) {
        settled0 = convertTokenToDecimal(mine.amount0, token0.decimals);
        settled1 = convertTokenToDecimal(mine.amount1, token1.decimals);
      }
    }

    /*
     * The event amounts AS THE POSITION SURFACE SEES THEM — zeroed on a
     * degenerate pool.
     *
     * Ponder gates its event amounts on `degenerate` (apps/v4/src/index.ts:243-244)
     * and those feed BOTH the cashflow aggregates and the ledger row amounts, so
     * a pool parked at the domain edge contributes zeros rather than the
     * astronomical artifact the tick formulas produce there.
     *
     * A SEPARATE pair rather than reusing `amount0`/`amount1` directly, because
     * those also feed this handler's vanilla-subgraph parity surface — pool and
     * token volume, the ModifyLiquidity entity, the USD figures — and the
     * subgraph counts every ModifyLiquidity unguarded. Ponder's handler is
     * position-only, so it can guard in one place; this one cannot.
     *
     * Observed on Avalanche tokenId 239: pool 0x88170bcf… sits at tick -887272
     * (MIN_TICK) with sqrtPrice 4295128740 (MIN_SQRT_RATIO+1). Both indexers
     * already agreed `isPriceable: false`, but Ponder's DEPOSIT row reads
     * amount0 = 0 where this port read 6.753059.
     */
    const posAmount0 = degenerate ? ZERO_BD : amount0;
    const posAmount1 = degenerate ? ZERO_BD : amount1;

    // Does this event produce a PositionTransaction row at all? Ponder's
    // `willWriteRow`, and the condition that gates gas below.
    const willWriteRow = delta !== 0n || settled0.gt(ZERO_BD) || settled1.gt(ZERO_BD);

    // `amount0`/`amount1` above are SIGNED by liquidityDelta — negative on a
    // withdraw. Cashflow aggregates want magnitudes on the matching side, which
    // is why each branch takes only one pair.
    const nextPosition = {
      ...existing,
      poolId: event.params.id,
      tickLower: BigInt(event.params.tickLower),
      tickUpper: BigInt(event.params.tickUpper),
      liquidity: nextLiquidity,
      isActive: nextLiquidity > 0n,

      depositedToken0: isAdd
        ? existing.depositedToken0.plus(posAmount0)
        : existing.depositedToken0,
      depositedToken1: isAdd
        ? existing.depositedToken1.plus(posAmount1)
        : existing.depositedToken1,
      withdrawnToken0: isAdd
        ? existing.withdrawnToken0
        : existing.withdrawnToken0.minus(posAmount0),
      withdrawnToken1: isAdd
        ? existing.withdrawnToken1
        : existing.withdrawnToken1.minus(posAmount1),

      // Recomputed from the post-change liquidity against the pool's current
      // tick — the whole reason this needs no getSlot0. Zeroed on a degenerate
      // pool, where the formulas produce astronomical nonsense, and the position
      // is flagged unpriceable so no consumer treats the zero as a valuation.
      ...(degenerate
        ? { amount0: ZERO_BD, amount1: ZERO_BD }
        : currentAmounts({
            tickLower: BigInt(event.params.tickLower),
            tickUpper: BigInt(event.params.tickUpper),
            liquidity: nextLiquidity,
            pool: { tick: pool.tick ?? 0n, sqrtPriceX96: pool.sqrtPrice ?? 0n },
            decimals0: token0.decimals,
            decimals1: token1.decimals,
          })),
      isPriceable: !degenerate,

      // Stamped on the FIRST transition to zero and preserved thereafter, and
      // cleared when liquidity returns. Ponder's rule exactly
      // (apps/v4/src/index.ts:290-296): re-stamping on every later zero-delta
      // event, as the port did, keeps moving a position's close time forward
      // and makes any holding-period derived from it wrong.
      closedAtTimestamp:
        nextLiquidity > 0n
          ? undefined
          : !existing.isActive && existing.closedAtTimestamp !== undefined
            ? existing.closedAtTimestamp
            : BigInt(event.block.timestamp),

      // The settle baseline for the next event's trace-skip comparison.
      feeGrowthInside0LastX128: fg0Last,
      feeGrowthInside1LastX128: fg1Last,

      totalFeesCollected0: existing.totalFeesCollected0.plus(settled0),
      totalFeesCollected1: existing.totalFeesCollected1.plus(settled1),
      // Just settled ⇒ nothing outstanding. The sweep refreshes it on its own
      // cadence; Ponder does exactly this (index.ts:318, "just settled → 0").
      totalFeesUncollected0: ZERO_BD,
      totalFeesUncollected1: ZERO_BD,

      /*
       * Only charged when this event actually writes a ledger row.
       *
       * Ponder computes gas inside `if (willWriteRow)`, where
       * `willWriteRow = liquidityDelta !== 0n || settled0 > 0 || settled1 > 0`
       * (apps/v4/src/index.ts:261-282). A zero-delta ModifyLiquidity that
       * settles nothing — a collect on a position with nothing accrued — writes
       * no row there and is charged no gas.
       *
       * This port charged it unconditionally, so such a no-op inflated
       * `totalGasCostETH` by a whole transaction's gas with no ledger row to
       * account for it: measured at 4-31% over on 5 of 223 Avalanche positions,
       * and it broke the invariant that the aggregate equals the sum of the
       * position's own rows. `totalGasCostETH` feeds net-of-cost performance,
       * so that is a customer-visible figure.
       */
      totalGasCostETH: willWriteRow
        ? existing.totalGasCostETH.plus(txGasCostETH)
        : existing.totalGasCostETH,

      // A real position change — the backend's change feed should see this.
      // `feesUpdatedAtBlock` is untouched; only the fee sweep owns it.
      updatedAtBlock: BigInt(event.block.number),
      updatedAtTimestamp: BigInt(event.block.timestamp),
    };
    context.Position.set(nextPosition);

    // COLLECT_FEES carries the traced fee amounts, so it can only be written now
    // that the trace has returned. A pure collect in v4 is a ModifyLiquidity
    // with liquidityDelta == 0, and Ponder keys on the same condition.
    if (settled0.gt(ZERO_BD) || settled1.gt(ZERO_BD)) {
      context.PositionTransaction.set({
        id: positionTxId(
          event.chainId,
          event.transaction.hash,
          event.logIndex,
          "COLLECT_FEES",
        ),
        chainId: BigInt(event.chainId),
        position_id: pid,
        tokenId,
        txHash: event.transaction.hash,
        logIndex: BigInt(event.logIndex),
        type: "COLLECT_FEES",
        amount0: settled0,
        amount1: settled1,
        // Gas only when this IS the whole transaction's purpose. A
        // withdraw-plus-fees puts it on the WITHDRAW row instead, so one
        // transaction never contributes gas twice.
        gasCostETH: delta === 0n ? txGasCostETH : ZERO_BD,
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        sender: event.transaction.from || "NONE",
      });
    }

    if (delta !== 0n) {
      const type = isAdd ? "DEPOSIT" : "WITHDRAW";
      context.PositionTransaction.set({
        id: positionTxId(event.chainId, event.transaction.hash, event.logIndex, type),
        chainId: BigInt(event.chainId),
        position_id: pid,
        tokenId,
        txHash: event.transaction.hash,
        logIndex: BigInt(event.logIndex),
        type,
        /*
         * MAGNITUDES, not the signed event amounts.
         *
         * Ponder writes `toHuman(isAdd ? eventAmt0 : -eventAmt0, dec0)`
         * (apps/v4/src/index.ts:344-345), so a WITHDRAW row's amounts are
         * POSITIVE there. `amount0`/`amount1` here are signed by
         * `liquidityDelta` and are negative on a withdraw, so they need the same
         * negation — the position aggregates already do it, via
         * `withdrawnToken0.minus(amount0)`.
         *
         * This is not cosmetic. The backend serves this column through to the
         * customer with the sign intact, so leaving it signed would flip every
         * withdraw amount negative the moment positions are read from Envio
         * instead of Ponder — 164 of 164 rows on Avalanche, identical in
         * magnitude and wrong in sign.
         */
        amount0: isAdd ? posAmount0 : ZERO_BD.minus(posAmount0),
        amount1: isAdd ? posAmount1 : ZERO_BD.minus(posAmount1),
        // Gas lands on this row. A pure collect (delta == 0) carries it on its
        // own COLLECT_FEES row instead, so it is never counted twice for one
        // transaction — the backend de-dupes per txHash when rendering.
        gasCostETH: txGasCostETH,
        timestamp: BigInt(event.block.timestamp),
        blockNumber: BigInt(event.block.number),
        sender: event.transaction.from || "NONE",
      });
    }
  }
});
