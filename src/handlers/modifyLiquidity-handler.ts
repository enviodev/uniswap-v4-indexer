/*
 * Liquidity event handlers for Uniswap v4 pools
 */
import { indexer } from "envio";
import {
  getAmount0,
  getAmount1,
} from "../utils/liquidityMath/liquidityAmounts";
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

  if (context.isPreload) {
    // Warm the interval rows here - see the note in swap-handler.ts.
    await preloadIntervalData(context, {
      blockTimestamp: event.block.timestamp,
      chainId: event.chainId,
      poolId,
      tokenIds: [existingToken0.id, existingToken1.id],
      includeUniswapDayData: true,
    });
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
});
