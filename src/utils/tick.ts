import { BigDecimal } from "generated";
import { ONE_BD, ZERO_BI } from "./constants";
import { fastExponentiation, safeDiv } from "./index";

export function createInitialTick(
  tickId: string,
  tickIdx: number,
  poolId: string,
  chainId: bigint,
  timestamp: bigint,
  blockNumber: bigint
) {
  const tick = {
    id: tickId,
    chainId,
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

  // 1.0001^tick is token1/token0.
  const price0Raw = fastExponentiation(new BigDecimal("1.0001"), tickIdx);

  // Limit precision to prevent PostgreSQL overflow (18 decimal places should be plenty)
  const price0 = new BigDecimal(price0Raw.toFixed(18));
  tick.price0 = price0;

  const price1Raw = safeDiv(ONE_BD, price0);
  const price1 = new BigDecimal(price1Raw.toFixed(18));
  tick.price1 = price1;

  return tick;
}
