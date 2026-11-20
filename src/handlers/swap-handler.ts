/*
 * Swap event handlers for Uniswap v4 pools
 *
 * Swaps are ~90% of all events, so this handler is the indexer's hot path.
 * It keeps the subgraph's maths but avoids repeated work: each entity is built
 * once and set once, and BigDecimal operations that have a cheaper exact form
 * (a decimal shift instead of dividing by 10^6, `negated`, `abs`) use it.
 */
import { indexer, BigDecimal, type Swap } from "envio";
import { getChainConfig } from "../utils/chains";
import {
  convertTokenToDecimal,
  safeDiv,
  times,
  sanitizeBD,
  divByPowerOfTen,
  half,
} from "../utils/index";
import { ADDRESS_ZERO, ZERO_BD } from "../utils/constants";
import {
  findNativePerTokenWithBundle,
  getNativePriceInUSD,
  getTrackedAmountUSD,
  sqrtPriceX96ToTokenPrices,
} from "../utils/pricing";

indexer.onEvent({ contract: "PoolManager", event: "Swap" }, async ({ event, context }) => {
  const chainConfig = getChainConfig(event.chainId);
  const chainId = event.chainId.toString();

  const [poolManager, pool, existingBundle, ethPriceUSD] = await Promise.all([
    context.PoolManager.get(`${event.chainId}_${event.srcAddress}`),
    context.Pool.get(`${event.chainId}_${event.params.id}`),
    context.Bundle.get(chainId),
    getNativePriceInUSD(
      context,
      chainId,
      chainConfig.stablecoinWrappedNativePoolId,
      chainConfig.stablecoinIsToken0
    ),
  ]);

  if (!pool || !poolManager) {
    return;
  }

  const isHookedPool = pool.hooks !== ADDRESS_ZERO;

  const [existingToken0, existingToken1, poolHookStats] = await Promise.all([
    context.Token.get(pool.token0),
    context.Token.get(pool.token1),
    isHookedPool
      ? context.HookStats.get(`${event.chainId}_${pool.hooks}`)
      : undefined,
  ]);

  if (!existingToken0 || !existingToken1) {
    return;
  }

  // Check if this pool should be skipped
  // NOTE: Subgraph only has this check in Initialize handler since skipped pools
  // are never created, but we keep it here for safety in case we switch to
  // getOrThrow APIs in the future and don't want exceptions thrown
  if (chainConfig.poolsToSkip.includes(event.params.id)) {
    return;
  }

  const bundle = existingBundle ?? { id: chainId, ethPriceUSD: ZERO_BD };

  // Update tokens' derivedETH values first. They price against the Bundle as
  // stored before this swap, like the subgraph.
  const [token0DerivedETHRaw, token1DerivedETHRaw] = await Promise.all([
    findNativePerTokenWithBundle(
      context,
      existingBundle,
      existingToken0,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
    findNativePerTokenWithBundle(
      context,
      existingBundle,
      existingToken1,
      chainConfig.wrappedNativeAddress,
      chainConfig.stablecoinAddresses,
      chainConfig.minimumNativeLocked
    ),
  ]);

  if (context.isPreload) {
    return;
  }

  const token0DerivedETH = sanitizeBD(token0DerivedETHRaw);
  const token1DerivedETH = sanitizeBD(token1DerivedETHRaw);
  const ethPrice = bundle.ethPriceUSD;
  // USD per token. BigDecimal multiplication is exact, so a * derivedETH * ethPrice
  // equals a * (derivedETH * ethPrice), and this one product serves every USD
  // value below. Unpriced tokens (derivedETH 0) are common, hence `times`.
  const price0USD = times(token0DerivedETH, ethPrice);
  const price1USD = times(token1DerivedETH, ethPrice);

  const prices = sqrtPriceX96ToTokenPrices(
    event.params.sqrtPriceX96,
    existingToken0,
    existingToken1,
    chainConfig.nativeTokenDetails
  );
  // Convert amounts using proper decimal handling
  // Unlike V3, a negative amount represents that amount is being sent to the pool and vice versa, so invert the sign
  const amount0 = convertTokenToDecimal(
    event.params.amount0,
    existingToken0.decimals
  ).negated();
  const amount1 = convertTokenToDecimal(
    event.params.amount1,
    existingToken1.decimals
  ).negated();
  // Get absolute amounts for volume
  const amount0Abs = amount0.abs();
  const amount1Abs = amount1.abs();
  const amount0USD = times(amount0Abs, price0USD);
  const amount1USD = times(amount1Abs, price1USD);
  // Get tracked amount USD (amountNUSD is amountNAbs at its token's USD price)
  const trackedAmountUSD = getTrackedAmountUSD(
    existingBundle,
    amount0USD,
    existingToken0.id,
    amount1USD,
    existingToken1.id,
    chainConfig.whitelistTokens
  );
  const amountTotalUSDTracked = half(trackedAmountUSD);
  const amountTotalETHTracked = safeDiv(amountTotalUSDTracked, ethPrice);
  const amountTotalUSDUntracked = half(amount0USD.plus(amount1USD));
  // Fees: the fee tier is in hundredths of a basis point, so x * fee / 1e6.
  // Dividing by 10^6 is a decimal shift (see divByPowerOfTen).
  const feeTier = new BigDecimal(pool.feeTier.toString());
  const feesETH = divByPowerOfTen(amountTotalETHTracked.times(feeTier), 6);
  const feesUSD = divByPowerOfTen(amountTotalUSDTracked.times(feeTier), 6);
  const feesUSDUntracked = amountTotalUSDUntracked.times(
    feeTier.shiftedBy(-6) // exact: fee / 1e6
  );
  // Calculate collected fees in tokens
  const feesToken0 = divByPowerOfTen(amount0Abs.times(feeTier), 6);
  const feesToken1 = divByPowerOfTen(amount1Abs.times(feeTier), 6);

  // Pool (feeTier updated to actual swap fee for dynamic fee pools)
  const currentPoolTvlETH = pool.totalValueLockedETH;
  const currentPoolTvlUSD = pool.totalValueLockedUSD;
  const totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0);
  const totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1);
  const poolTvlETH = times(totalValueLockedToken0, token0DerivedETH).plus(
    times(totalValueLockedToken1, token1DerivedETH)
  );
  const poolTvlUSD = sanitizeBD(times(poolTvlETH, ethPrice));
  const swapFee = BigInt(event.params.fee);
  context.Pool.set({
    ...pool,
    feeTier: swapFee,
    txCount: pool.txCount + 1n,
    sqrtPrice: event.params.sqrtPriceX96,
    tick: event.params.tick,
    token0Price: prices[0],
    token1Price: prices[1],
    totalValueLockedToken0,
    totalValueLockedToken1,
    liquidity: event.params.liquidity,
    volumeToken0: pool.volumeToken0.plus(amount0Abs),
    volumeToken1: pool.volumeToken1.plus(amount1Abs),
    volumeUSD: sanitizeBD(pool.volumeUSD.plus(amountTotalUSDTracked)),
    untrackedVolumeUSD: pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked),
    feesUSD: pool.feesUSD.plus(feesUSD),
    feesUSDUntracked: pool.feesUSDUntracked.plus(feesUSDUntracked),
    collectedFeesToken0: pool.collectedFeesToken0.plus(feesToken0),
    collectedFeesToken1: pool.collectedFeesToken1.plus(feesToken1),
    collectedFeesUSD: pool.collectedFeesUSD.plus(feesUSD),
    totalValueLockedETH: poolTvlETH,
    totalValueLockedUSD: poolTvlUSD,
  });

  // Tokens
  const token0Tvl = existingToken0.totalValueLocked.plus(amount0);
  const token1Tvl = existingToken1.totalValueLocked.plus(amount1);
  context.Token.set({
    ...existingToken0,
    derivedETH: token0DerivedETH,
    volume: existingToken0.volume.plus(amount0Abs),
    totalValueLocked: token0Tvl,
    volumeUSD: existingToken0.volumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: existingToken0.untrackedVolumeUSD.plus(
      amountTotalUSDUntracked
    ),
    feesUSD: existingToken0.feesUSD.plus(feesUSD),
    txCount: existingToken0.txCount + 1n,
    totalValueLockedUSD: times(token0Tvl, price0USD),
  });
  context.Token.set({
    ...existingToken1,
    derivedETH: token1DerivedETH,
    volume: existingToken1.volume.plus(amount1Abs),
    totalValueLocked: token1Tvl,
    volumeUSD: existingToken1.volumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: existingToken1.untrackedVolumeUSD.plus(
      amountTotalUSDUntracked
    ),
    feesUSD: existingToken1.feesUSD.plus(feesUSD),
    txCount: existingToken1.txCount + 1n,
    totalValueLockedUSD: times(token1Tvl, price1USD),
  });

  // PoolManager aggregates (TVL: swap this pool's old value for its new one)
  const managerTvlETH = poolManager.totalValueLockedETH
    .minus(currentPoolTvlETH)
    .plus(poolTvlETH);
  context.PoolManager.set({
    ...poolManager,
    txCount: poolManager.txCount + 1n,
    totalVolumeETH: poolManager.totalVolumeETH.plus(amountTotalETHTracked),
    totalVolumeUSD: poolManager.totalVolumeUSD.plus(amountTotalUSDTracked),
    untrackedVolumeUSD: poolManager.untrackedVolumeUSD.plus(
      amountTotalUSDUntracked
    ),
    totalFeesETH: poolManager.totalFeesETH.plus(feesETH),
    totalFeesUSD: poolManager.totalFeesUSD.plus(feesUSD),
    totalValueLockedETH: managerTvlETH,
    totalValueLockedUSD: times(managerTvlETH, ethPrice),
    numberOfSwaps: poolManager.numberOfSwaps + 1n,
    hookedSwaps: isHookedPool
      ? poolManager.hookedSwaps + 1n
      : poolManager.hookedSwaps,
  });

  // Use for USD swap amount
  const hasTrackedVolume = amountTotalUSDTracked.gt(ZERO_BD);
  const finalAmountUSD = hasTrackedVolume
    ? amountTotalUSDTracked
    : amountTotalUSDUntracked;

  const entity: Swap = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    transaction: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    pool: pool.id,
    token0_id: existingToken0.id,
    token1_id: existingToken1.id,
    sender: event.params.sender,
    origin: event.transaction.from || "NONE",
    amount0: amount0,
    amount1: amount1,
    amountUSD: sanitizeBD(finalAmountUSD),
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
    logIndex: BigInt(event.logIndex),
    fee: swapFee,
  };
  context.Swap.set(entity);

  // Bundle: only write when the native price moved (it rarely does between
  // swaps on other pools), saving a set and a row per batch.
  const newEthPriceUSD = sanitizeBD(ethPriceUSD);
  if (!existingBundle || !existingBundle.ethPriceUSD.eq(newEthPriceUSD)) {
    context.Bundle.set({ ...bundle, ethPriceUSD: newEthPriceUSD });
  }

  // After processing the swap, update HookStats if it's a hooked pool
  if (poolHookStats) {
    // Calculate volume and fees, using untracked volume as fallback.
    // The untracked fee uses the swap's own fee, the pool's fee after this swap.
    const volumeToAdd = finalAmountUSD;
    const feesToAdd = hasTrackedVolume
      ? feesUSD
      : amountTotalUSDUntracked.times(
          new BigDecimal(swapFee.toString()).shiftedBy(-6)
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
        .plus(poolTvlUSD), // Add new TVL
    });
  }
});
