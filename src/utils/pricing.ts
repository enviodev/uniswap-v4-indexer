import {
  BigDecimal,
  type Bundle,
  type EvmOnEventContext,
  type Pool,
  type Token,
} from "envio";

type handlerContext = EvmOnEventContext;
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, ZERO_BI } from "./constants";
import { NativeTokenDetails } from "./nativeTokenDetails";
import { safeDiv } from "./index";

const Q192 = 2n ** 192n;
const SCALE_20 = 10n ** 20n;
const SCALE_40 = 10n ** 40n;

/** round(n / d) with halves rounded up, for n >= 0 and d > 0. */
function divRoundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

const pow10Cache = new Map<bigint, bigint>();
function pow10(exp: bigint): bigint {
  let cached = pow10Cache.get(exp);
  if (cached === undefined) {
    cached = 10n ** exp;
    pow10Cache.set(exp, cached);
  }
  return cached;
}

/**
 * Token prices from a pool's sqrtPriceX96, in integer arithmetic.
 *
 * It returns exactly what the BigDecimal version did, step by step:
 *   price1 = sqrtPrice^2 / 2^192          (rounded to 20 places, half up)
 *            * 10^decimals0 / 10^decimals1 (rounded to 20 places, half up)
 *   price0 = 1 / price1                   (rounded to 20 places, 0 if price1 is 0)
 * Each rounding is the one bignumber.js applies to `.div`, so the stored values
 * don't change. Doing it on bigints skips three long divisions per call.
 */
export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: bigint,
  token0: Token,
  token1: Token,
  nativeTokenDetails: NativeTokenDetails
): [BigDecimal, BigDecimal] {
  const token0Decimals =
    token0.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token0.decimals;
  const token1Decimals =
    token1.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token1.decimals;

  // Both values are scaled by 10^20.
  const ratio = divRoundHalfUp(sqrtPriceX96 * sqrtPriceX96 * SCALE_20, Q192);
  const price1Scaled = divRoundHalfUp(
    ratio * pow10(token0Decimals > 0n ? token0Decimals : 0n),
    pow10(token1Decimals > 0n ? token1Decimals : 0n)
  );
  const price0Scaled =
    price1Scaled === 0n ? 0n : divRoundHalfUp(SCALE_40, price1Scaled);

  return [
    new BigDecimal(`${price0Scaled}e-20`),
    new BigDecimal(`${price1Scaled}e-20`),
  ];
}

export async function getNativePriceInUSD(
  context: handlerContext,
  chainId: string,
  stablecoinWrappedNativePoolId: string,
  stablecoinIsToken0: boolean
): Promise<BigDecimal> {
  // Chains whose native token is itself a USD stablecoin (Arc: native USDC)
  // have no native/stable pool to read. They set the pool id to "" and the
  // native price is $1 by definition.
  if (stablecoinWrappedNativePoolId === "") {
    return ONE_BD;
  }
  const poolId = `${chainId}_${stablecoinWrappedNativePoolId}`;
  const stablecoinWrappedNativePool = await context.Pool.get(poolId);

  if (stablecoinWrappedNativePool) {
    return stablecoinIsToken0
      ? stablecoinWrappedNativePool.token0Price
      : stablecoinWrappedNativePool.token1Price;
  }
  return ZERO_BD;
}

/**
 * A pool may only set a token's price when the value it implies for the token
 * side is consistent with the pool's verifiable (whitelisted) side.
 *
 * The bound is empirical, not an AMM invariant — v4 concentrated liquidity
 * legitimately allows lopsided pools (one-sided range orders, wide-range
 * launch overhangs valued at spot). Measured across all organically traded
 * one-sided pools on the production indexer (2,584 pools with >=500 txs above
 * the pricing threshold, 2026-07-14): 96% sit below 10x, 99.6% below 100x,
 * 99.9% below 1000x, and NONE between 1e4x and 1e6x — while every observed
 * poison pool sits at 7.6e3x-1e24x. 1000x cuts through the empty band with
 * ~7x margin to the nearest junk and one-in-a-thousand impact on real pools.
 * Without this guard an attacker passes minimumNativeLocked with ~1 ETH, sets
 * an absurd price with one swap, and (optionally) withdraws — freezing a junk
 * derivedETH that inflates TVL/volume USD everywhere the token appears. With
 * it, faking $X of value requires depositing ~$X/1000 of real capital.
 */
export const MAX_PRICING_POOL_VALUE_IMBALANCE = new BigDecimal("1000");

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
// 1 / ethPriceUSD prices every stablecoin. The native price only moves when the
// stablecoin/native pool trades, so the last inverse is reused until it does.
let lastEthPriceUSD: BigDecimal | undefined;
let lastInverse: BigDecimal = ZERO_BD;
function inverseNativePrice(ethPriceUSD: BigDecimal): BigDecimal {
  if (
    lastEthPriceUSD === undefined ||
    (lastEthPriceUSD !== ethPriceUSD && !lastEthPriceUSD.eq(ethPriceUSD))
  ) {
    lastInverse = safeDiv(ONE_BD, ethPriceUSD);
    lastEthPriceUSD = ethPriceUSD;
  }
  return lastInverse;
}

export async function findNativePerToken(
  context: handlerContext,
  token: Token,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumNativeLocked: BigDecimal
): Promise<BigDecimal> {
  const chainId = token.id.slice(0, token.id.indexOf("_"));
  return findNativePerTokenWithBundle(
    context,
    await context.Bundle.get(chainId),
    token,
    wrappedNativeAddress,
    stablecoinAddresses,
    minimumNativeLocked
  );
}

/** findNativePerToken for a caller that already holds the chain's Bundle. */
export async function findNativePerTokenWithBundle(
  context: handlerContext,
  bundle: Bundle | undefined,
  token: Token,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumNativeLocked: BigDecimal
): Promise<BigDecimal> {
  const tokenAddress = token.id.slice(token.id.indexOf("_") + 1);

  if (tokenAddress == wrappedNativeAddress || tokenAddress == ADDRESS_ZERO) {
    return ONE_BD;
  }

  if (!bundle) return ZERO_BD;

  if (stablecoinAddresses.includes(tokenAddress)) {
    // Nothing to preload; the preload result is thrown away.
    return context.isPreload ? ZERO_BD : inverseNativePrice(bundle.ethPriceUSD);
  }

  // Pool ids already carry the chainId (see TokenWhitelistPools in schema).
  const whiteList =
    (await context.TokenWhitelistPools.get(token.id))?.pools ?? [];
  const pools = await Promise.all(
    whiteList.map((poolAddress) => context.Pool.get(poolAddress))
  );

  const tokenFetches: {
    pool: Pool;
    tokenId: string;
    isToken0: boolean;
  }[] = [];
  for (const pool of pools) {
    if (pool && pool.liquidity > ZERO_BI) {
      // Pool token ids are `${chainId}_${address}`, like token.id.
      if (pool.token0 == token.id) {
        tokenFetches.push({ pool, tokenId: pool.token1, isToken0: false });
      }
      if (pool.token1 == token.id) {
        tokenFetches.push({ pool, tokenId: pool.token0, isToken0: true });
      }
    }
  }
  const tokens = await Promise.all(
    tokenFetches.map((f) => context.Token.get(f.tokenId))
  );

  // The preload pass only needs the loads above; its result is thrown away.
  if (context.isPreload) {
    return ZERO_BD;
  }

  let largestLiquidityETH = ZERO_BD;
  let priceSoFar = ZERO_BD;
  for (let i = 0; i < tokenFetches.length; i++) {
    const otherToken = tokens[i];
    if (!otherToken) continue;
    const { pool, isToken0 } = tokenFetches[i]!;
    const ethLocked = isToken0
      ? pool.totalValueLockedToken0.times(otherToken.derivedETH)
      : pool.totalValueLockedToken1.times(otherToken.derivedETH);
    // Cheap checks first: most pools lose here, before the price maths.
    if (!ethLocked.gt(largestLiquidityETH) || !ethLocked.gt(minimumNativeLocked)) {
      continue;
    }
    const candidatePrice = isToken0
      ? pool.token0Price.times(otherToken.derivedETH)
      : pool.token1Price.times(otherToken.derivedETH);
    // Value the candidate price implies for OUR token's side of the pool.
    // Reject prices that value it far beyond the pool's verifiable side —
    // see MAX_PRICING_POOL_VALUE_IMBALANCE.
    const ourSideBalance = isToken0
      ? pool.totalValueLockedToken1
      : pool.totalValueLockedToken0;
    const impliedOurSideETH = ourSideBalance.times(candidatePrice);
    if (
      impliedOurSideETH.lte(ethLocked.times(MAX_PRICING_POOL_VALUE_IMBALANCE))
    ) {
      largestLiquidityETH = ethLocked;
      priceSoFar = candidatePrice;
    }
  }
  return priceSoFar;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
const TWO_BD = new BigDecimal("2");

export function getTrackedAmountUSD(
  bundle: Bundle | undefined,
  amount0USD: BigDecimal,
  token0Id: string,
  amount1USD: BigDecimal,
  token1Id: string,
  whitelistTokens: string[]
): BigDecimal {
  if (!bundle) return ZERO_BD;

  // Strip chainId prefix from token ids for whitelist comparison
  const token0Whitelisted = whitelistTokens.includes(
    token0Id.slice(token0Id.indexOf("_") + 1)
  );
  const token1Whitelisted = whitelistTokens.includes(
    token1Id.slice(token1Id.indexOf("_") + 1)
  );

  // both are whitelist tokens, return sum of both amounts
  if (token0Whitelisted && token1Whitelisted) {
    return amount0USD.plus(amount1USD);
  }
  // take double value of the whitelisted token amount
  if (token0Whitelisted) {
    return amount0USD.times(TWO_BD);
  }
  if (token1Whitelisted) {
    return amount1USD.times(TWO_BD);
  }
  // neither token is on white list, tracked amount is 0
  return ZERO_BD;
}

export function calculateAmountUSD(
  amount0: BigDecimal,
  amount1: BigDecimal,
  token0DerivedETH: BigDecimal,
  token1DerivedETH: BigDecimal,
  ethPriceUSD: BigDecimal
): BigDecimal {
  return amount0
    .times(token0DerivedETH.times(ethPriceUSD))
    .plus(amount1.times(token1DerivedETH.times(ethPriceUSD)));
}
