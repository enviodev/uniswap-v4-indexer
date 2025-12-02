import { BigDecimal, type handlerContext } from "generated";

import { exponentToBigDecimal, safeDiv } from "../utils/index";
import { type Token } from "generated";
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, ZERO_BI } from "./constants";
import { NativeTokenDetails } from "./nativeTokenDetails";

const Q192 = BigInt(2) ** BigInt(192);

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

  const num = new BigDecimal((sqrtPriceX96 * sqrtPriceX96).toString());
  const denom = new BigDecimal(Q192.toString());
  const price1 = num
    .div(denom)
    .times(exponentToBigDecimal(token0Decimals))
    .div(exponentToBigDecimal(token1Decimals));

  const price0 = safeDiv(new BigDecimal("1"), price1);
  return [price0, price1];
}

export async function getNativePriceInUSD(
  context: handlerContext,
  chainId: string,
  stablecoinWrappedNativePoolId: string,
  stablecoinIsToken0: boolean
): Promise<BigDecimal> {
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
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export async function findNativePerToken(
  context: handlerContext,
  token: Token,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumNativeLocked: BigDecimal
): Promise<BigDecimal> {
  const tokenAddress = token.id.split("_")[1]!;
  const chainId = token.id.split("_")[0]!; // Make sure this is being used for Bundle lookup

  if (tokenAddress == wrappedNativeAddress || tokenAddress == ADDRESS_ZERO) {
    return ONE_BD;
  }

  const whiteList = token.whitelistPools;
  let largestLiquidityETH = ZERO_BD;
  let priceSoFar = ZERO_BD;

  const bundle = await context.Bundle.get(chainId);
  if (!bundle) return ZERO_BD;

  if (stablecoinAddresses.includes(tokenAddress)) {
    priceSoFar = safeDiv(ONE_BD, bundle.ethPriceUSD);
  } else {
    for (let i = 0; i < whiteList.length; ++i) {
      const poolAddress = whiteList[i]!;
      // Pool IDs already include chainId since we store them that way in whitelistPools
      const pool = await context.Pool.get(poolAddress);

      if (pool) {
        if (pool.liquidity > ZERO_BI) {
          const poolToken0 = pool.token0.split("_")[1];
          const poolToken1 = pool.token1.split("_")[1];

          if (poolToken0 == tokenAddress) {
            const token1 = await context.Token.get(pool.token1);
            if (token1) {
              const ethLocked = pool.totalValueLockedToken1.times(
                token1.derivedETH
              );
              if (
                ethLocked.gt(largestLiquidityETH) &&
                ethLocked.gt(minimumNativeLocked)
              ) {
                largestLiquidityETH = ethLocked;
                priceSoFar = pool.token1Price.times(token1.derivedETH);
              }
            }
          }
          if (poolToken1 == tokenAddress) {
            const token0 = await context.Token.get(pool.token0);
            if (token0) {
              const ethLocked = pool.totalValueLockedToken0.times(
                token0.derivedETH
              );
              if (
                ethLocked.gt(largestLiquidityETH) &&
                ethLocked.gt(minimumNativeLocked)
              ) {
                largestLiquidityETH = ethLocked;
                priceSoFar = pool.token0Price.times(token0.derivedETH);
              }
            }
          }
        }
      }
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
export async function getTrackedAmountUSD(
  context: handlerContext,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  chainId: string,
  whitelistTokens: string[]
): Promise<BigDecimal> {
  const bundle = await context.Bundle.get(chainId);
  if (!bundle) return ZERO_BD;

  const price0USD = token0.derivedETH.times(bundle.ethPriceUSD);
  const price1USD = token1.derivedETH.times(bundle.ethPriceUSD);

  // Strip chainId prefix from token ids for whitelist comparison
  const token0Address = token0.id.split("_")[1]!;
  const token1Address = token1.id.split("_")[1]!;

  // both are whitelist tokens, return sum of both amounts
  if (
    whitelistTokens.includes(token0Address) &&
    whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD));
  }

  // take double value of the whitelisted token amount
  if (
    whitelistTokens.includes(token0Address) &&
    !whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount0.times(price0USD).times(new BigDecimal("2"));
  }

  // take double value of the whitelisted token amount
  if (
    !whitelistTokens.includes(token0Address) &&
    whitelistTokens.includes(token1Address)
  ) {
    return tokenAmount1.times(price1USD).times(new BigDecimal("2"));
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
