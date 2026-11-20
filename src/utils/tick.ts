import { BigDecimal } from "envio";
import { ONE_BD, ZERO_BI } from "./constants";
import { fastExponentiation, safeDiv } from "./index";

export function createInitialTick(
  tickId: string,
  tickIdx: number,
  poolId: string,
  timestamp: bigint,
  blockNumber: bigint
) {
  const tick = {
    id: tickId,
    pool_id: poolId,
    tickIdx: BigInt(tickIdx),
    poolAddress: poolId,
    createdAtTimestamp: timestamp,
    createdAtBlockNumber: blockNumber,
    liquidityGross: ZERO_BI,
    liquidityNet: ZERO_BI,
    price0: ONE_BD,
    price1: ONE_BD,
  };

  // 1.0001^tick is token1/token0. The same ticks come up again and again
  // (full-range positions, popular range bounds), so the prices are cached.
  const [price0, price1] = tickPrices(tickIdx);
  tick.price0 = price0;
  tick.price1 = price1;

  return tick;
}

// Bounded so a chain with millions of distinct ticks can't grow it forever.
const TICK_PRICE_CACHE_LIMIT = 100_000;
const tickPriceCache = new Map<number, [BigDecimal, BigDecimal]>();

function tickPrices(tickIdx: number): [BigDecimal, BigDecimal] {
  let prices = tickPriceCache.get(tickIdx);
  if (prices === undefined) {
    const price0Raw = fastExponentiation(new BigDecimal("1.0001"), tickIdx);
    // Limit precision to prevent PostgreSQL overflow (18 decimal places should be plenty)
    const price0 = new BigDecimal(price0Raw.toFixed(18));
    const price1Raw = safeDiv(ONE_BD, price0);
    const price1 = new BigDecimal(price1Raw.toFixed(18));
    prices = [price0, price1];
    if (tickPriceCache.size >= TICK_PRICE_CACHE_LIMIT) tickPriceCache.clear();
    tickPriceCache.set(tickIdx, prices);
  }
  return prices;
}
