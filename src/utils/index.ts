import { BigDecimal } from "envio";
import { ZERO_BD, ONE_BD, ZERO_BI } from "./constants";

// bignumber.js defaults, which every `.div` in this indexer relies on: results
// keep 20 decimal places, rounded half up. The fast paths below reproduce that
// rounding exactly, so they return the same values as the `.div` they replace.
const DIV_DP = 20;
const ROUND_HALF_UP = BigDecimal.ROUND_HALF_UP;

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.isZero()) {
    return ZERO_BD;
  } else {
    return amount0.div(amount1);
  }
}

/**
 * `value.div(10^places)` without long division: shifting the decimal point is
 * exact, then rounding to 20 places matches what `.div` would return.
 */
export function divByPowerOfTen(value: BigDecimal, places: number): BigDecimal {
  return value.shiftedBy(-places).decimalPlaces(DIV_DP, ROUND_HALF_UP);
}

/** `value.div(2)`, computed as an exact halving rounded like `.div`. */
export function half(value: BigDecimal): BigDecimal {
  return value.times(0.5).decimalPlaces(DIV_DP, ROUND_HALF_UP);
}

// Cap BigDecimal precision at 40 decimal places. Postgres btree indexes have a
// hard 2704-byte-per-row limit, so an unbounded BigDecimal (e.g. from a runaway
// derivedETH on a manipulated oracle pool) can fail INSERTs on indexed numeric
// columns. Apply at indexed-column writes and at price-source values that
// propagate downstream (derivedETH, ethPriceUSD).
//
// Most values already fit and are returned as they are. The rest are rounded
// in place, which gives the same value as the old `toFixed(40)` string
// round-trip (both round half up) without building and parsing a string.
export function sanitizeBD(value: BigDecimal): BigDecimal {
  const dp = value.decimalPlaces();
  if (dp === null || dp <= 40) {
    return value;
  }
  return value.decimalPlaces(40, ROUND_HALF_UP);
}

export function hexToBigInt(hex: string): bigint {
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }
  return BigInt(`0x${hex}`);
}

/**
 * Implements exponentiation by squaring
 * (see https://en.wikipedia.org/wiki/Exponentiation_by_squaring )
 * to minimize the number of BigDecimal operations and their impact on performance.
 *
 * Uses Math.floor for correct integer division and caps intermediate precision
 * at 40 digits to prevent BigDecimal digit explosion during squaring steps
 * (without capping, 18 squaring levels would produce ~1M digit intermediates).
 */
export function fastExponentiation(
  value: BigDecimal,
  power: number
): BigDecimal {
  if (power < 0) {
    const result = fastExponentiation(value, -power);
    return safeDiv(ONE_BD, result);
  }

  if (power == 0) {
    return ONE_BD;
  }

  if (power == 1) {
    return value;
  }

  const halfPower = Math.floor(power / 2);
  const halfResult = fastExponentiation(value, halfPower);

  // Use the fact that x ^ (2n) = (x ^ n) * (x ^ n) and we can compute (x ^ n) only once.
  // Cap precision after each multiplication to prevent digit explosion.
  let result = new BigDecimal(halfResult.times(halfResult).toFixed(40));

  // For odd powers, x ^ (2n + 1) = (x ^ 2n) * x
  if (power % 2 == 1) {
    result = new BigDecimal(result.times(value).toFixed(40));
  }
  return result;
}

const NULL_ETH_HEX_STRING =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

export function isNullEthValue(value: string): boolean {
  return value == NULL_ETH_HEX_STRING;
}

export function convertTokenToDecimal(
  tokenAmount: bigint,
  exchangeDecimals: bigint
): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return new BigDecimal(tokenAmount.toString());
  }
  return divByPowerOfTen(
    new BigDecimal(tokenAmount.toString()),
    Number(exchangeDecimals)
  );
}
