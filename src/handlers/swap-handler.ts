/*
 * Swap event handlers for Uniswap v4 pools
 */
import { PoolManager, BigDecimal, type Swap } from "generated";
import { getChainConfig } from "../utils/chains";
import { convertTokenToDecimal } from "../utils";
import { getTrackedAmountUSD, getNativePriceInUSD } from "../utils/pricing";
import { safeDiv } from "../utils/index";
import { findNativePerToken } from "../utils/pricing";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";

PoolManager.Swap.handler(async ({ event, context }) => {
  const chainConfig = getChainConfig(event.chainId);

  let [poolManager, pool, bundle, ethPriceUSD] = await Promise.all([
    context.PoolManager.get(`${event.chainId}_${event.srcAddress}`),
    context.Pool.get(`${event.chainId}_${event.params.id}`),
    context.Bundle.get(event.chainId.toString()),
    getNativePriceInUSD(
      context,
      event.chainId.toString(),
      chainConfig.stablecoinWrappedNativePoolId,
      chainConfig.stablecoinIsToken0
    ),
  ]);

  if (!pool || !poolManager) {
    return;
  }

  let token0;
  let token1;
  let poolHookStats;

  const isHookedPool =
    pool.hooks !== "0x0000000000000000000000000000000000000000";

  [token0, token1, poolHookStats] = await Promise.all([
    context.Token.get(pool.token0),
    context.Token.get(pool.token1),
    isHookedPool
      ? context.HookStats.get(`${event.chainId}_${pool.hooks}`)
      : undefined,
    ,
  ]);

  if (!token0 || !token1) {
    return;
  }

  // Check if this pool should be skipped
  // NOTE: Subgraph only has this check in Initialize handler since skipped pools
  // are never created, but we keep it here for safety in case we switch to
  // getOrThrow APIs in the future and don't want exceptions thrown
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  bundle = bundle || {
    id: event.chainId.toString(),
    ethPriceUSD: new BigDecimal("0"),
  };

  // Update tokens' derivedETH values first
  const [token0DerivedETH, token1DerivedETH] = await Promise.all([
    findNativePerToken(
      context,
      token0,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
    findNativePerToken(
      context,
      token1,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
  ]);
  token0 = { ...token0, derivedETH: token0DerivedETH };
  token1 = { ...token1, derivedETH: token1DerivedETH };

  if (context.isPreload) {
    return;
  }

  const prices = sqrtPriceX96ToTokenPrices(
    event.params.sqrtPriceX96,
    token0,
    token1,
    chainConfig.nativeTokenDetails
  );
  // Convert amounts using proper decimal handling
  // Unlike V3, a negative amount represents that amount is being sent to the pool and vice versa, so invert the sign
  const amount0 = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  ).times(new BigDecimal("-1"));
  const amount1 = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  ).times(new BigDecimal("-1"));
  // Get absolute amounts for volume
  const amount0Abs = amount0.lt(new BigDecimal("0"))
    ? amount0.times(new BigDecimal("-1"))
    : amount0;
  const amount1Abs = amount1.lt(new BigDecimal("0"))
    ? amount1.times(new BigDecimal("-1"))
    : amount1;
  const amount0ETH = amount0Abs.times(token0.derivedETH);
  const amount1ETH = amount1Abs.times(token1.derivedETH);
  const amount0USD = amount0ETH.times(bundle.ethPriceUSD);
  const amount1USD = amount1ETH.times(bundle.ethPriceUSD);
  // Get tracked amount USD
  const trackedAmountUSD = await getTrackedAmountUSD(
    context,
    amount0Abs,
    token0,
    amount1Abs,
    token1,
    event.chainId.toString(),
    chainConfig.whitelistTokens
  );
  const amountTotalUSDTracked = trackedAmountUSD.div(new BigDecimal("2"));
  const amountTotalETHTracked = safeDiv(
    amountTotalUSDTracked,
    bundle.ethPriceUSD
  );
  const amountTotalUSDUntracked = amount0USD
    .plus(amount1USD)
    .div(new BigDecimal("2"));
  // Update the pool feeTier with the fee from the swap event
  // This is important for dynamic fee pools where we want to store the actual last fee
  // rather than the dynamic flag (0x800000 / 8388608)
  pool = {
    ...pool,
    feeTier: BigInt(event.params.fee),
  };

  // Calculate fees
  const feesETH = amountTotalETHTracked
    .times(pool.feeTier.toString())
    .div(new BigDecimal("1000000"));
  const feesUSD = amountTotalUSDTracked
    .times(pool.feeTier.toString())
    .div(new BigDecimal("1000000"));
  // Calculate untracked fees
  const feesUSDUntracked = amountTotalUSDUntracked.times(
    new BigDecimal(pool.feeTier.toString()).div(new BigDecimal("1000000"))
  );
  // Calculate collected fees in tokens
  const feesToken0 = amount0Abs
    .times(pool.feeTier.toString())
    .div(new BigDecimal("1000000"));
  const feesToken1 = amount1Abs
    .times(pool.feeTier.toString())
    .div(new BigDecimal("1000000"));
  // Store current pool TVL values for later calculations
  const currentPoolTvlETH = pool.totalValueLockedETH;
  const currentPoolTvlUSD = pool.totalValueLockedUSD;
  // Update pool values
  pool = {
    ...pool,
    txCount: pool.txCount + 1n,
    sqrtPrice: event.params.sqrtPriceX96,
    tick: event.params.tick,
    token0Price: prices[0],
    token1Price: prices[1],
    totalValueLockedToken0: pool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: pool.totalValueLockedToken1.plus(amount1),
    liquidity: event.params.liquidity,
    volumeToken0: pool.volumeToken0.plus(amount0Abs),
    volumeToken1: pool.volumeToken1.plus(amount1Abs),
    volumeUSD: pool.volumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
    feesUSD: pool.feesUSD.plus(feesUSD),
    feesUSDUntracked: pool.feesUSDUntracked.plus(feesUSDUntracked),
    collectedFeesToken0: pool.collectedFeesToken0.plus(feesToken0),
    collectedFeesToken1: pool.collectedFeesToken1.plus(feesToken1),
    collectedFeesUSD: pool.collectedFeesUSD.plus(feesUSD),
  };
  pool = {
    ...pool,
    totalValueLockedETH: pool.totalValueLockedToken0
      .times(token0.derivedETH)
      .plus(pool.totalValueLockedToken1.times(token1.derivedETH)),
  };
  pool = {
    ...pool,
    totalValueLockedUSD: pool.totalValueLockedETH.times(bundle.ethPriceUSD),
  };
  // Update token0 data
  token0 = {
    ...token0,
    volume: token0.volume.plus(amount0Abs),
    totalValueLocked: token0.totalValueLocked.plus(amount0),
    volumeUSD: token0.volumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
    feesUSD: token0.feesUSD.plus(feesUSD),
    txCount: token0.txCount + 1n,
  };
  // Update token1 data
  token1 = {
    ...token1,
    volume: token1.volume.plus(amount1Abs),
    totalValueLocked: token1.totalValueLocked.plus(amount1),
    volumeUSD: token1.volumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
    feesUSD: token1.feesUSD.plus(feesUSD),
    txCount: token1.txCount + 1n,
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
  // Update PoolManager aggregates
  poolManager = {
    ...poolManager,
    txCount: poolManager.txCount + 1n,
    totalVolumeETH: poolManager.totalVolumeETH.plus(amountTotalETHTracked),
    totalVolumeUSD: poolManager.totalVolumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: poolManager.untrackedVolumeUSD.plus(
      amountTotalUSDUntracked
    ),
    totalFeesETH: poolManager.totalFeesETH.plus(feesETH),
    totalFeesUSD: poolManager.totalFeesUSD.plus(feesUSD),
    // Reset and recalculate TVL
    totalValueLockedETH: poolManager.totalValueLockedETH
      .minus(currentPoolTvlETH)
      .plus(pool.totalValueLockedETH),
  };
  // Then calculate USD value based on the updated ETH value
  poolManager = {
    ...poolManager,
    totalValueLockedUSD: poolManager.totalValueLockedETH.times(
      bundle.ethPriceUSD
    ),
  };

  // Use for USD swap amount
  const finalAmountUSD = amountTotalUSDTracked.gt(new BigDecimal("0"))
    ? amountTotalUSDTracked
    : amountTotalUSDUntracked;

  let entity: Swap = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    chainId: BigInt(event.chainId),
    transaction: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    pool: `${event.chainId}_${event.params.id}`,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    amount0: amount0,
    amount1: amount1,
    amountUSD: finalAmountUSD,
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
    logIndex: BigInt(event.logIndex),
  };
  // Use immutability pattern
  context.Bundle.set({
    ...bundle,
    ethPriceUSD,
  });
  context.Pool.set(pool);
  context.PoolManager.set(poolManager);
  context.Swap.set(entity);
  context.Token.set(token0);
  context.Token.set(token1);

  poolManager = {
    ...poolManager,
    numberOfSwaps: poolManager.numberOfSwaps + 1n,
    hookedSwaps: isHookedPool
      ? poolManager.hookedSwaps + 1n
      : poolManager.hookedSwaps,
  };

  context.PoolManager.set(poolManager);

  // After processing the swap, update HookStats if it's a hooked pool
  if (poolHookStats) {
    // Calculate volume and fees, using untracked volume as fallback
    const volumeToAdd = amountTotalUSDTracked.gt(new BigDecimal("0"))
      ? amountTotalUSDTracked
      : amountTotalUSDUntracked;

    // Calculate fees based on the volume we're using (use the same calculation as earlier in the code)
    const feesToAdd = amountTotalUSDTracked.gt(new BigDecimal("0"))
      ? feesUSD
      : amountTotalUSDUntracked.times(
          new BigDecimal(pool.feeTier.toString()).div(new BigDecimal("1000000"))
        );

    context.HookStats.set({
      ...poolHookStats,
      numberOfSwaps: poolHookStats.numberOfSwaps + 1n,
      totalVolumeUSD: poolHookStats.totalVolumeUSD.plus(volumeToAdd), // right now this is includes untracked volume
      untrackedVolumeUSD: poolHookStats.untrackedVolumeUSD.plus(
        amountTotalUSDUntracked
      ),
      totalFeesUSD: poolHookStats.totalFeesUSD.plus(feesToAdd),
      totalValueLockedUSD: poolHookStats.totalValueLockedUSD
        .minus(currentPoolTvlUSD) // Remove old TVL
        .plus(pool.totalValueLockedUSD), // Add new TVL
    });
  }
});
