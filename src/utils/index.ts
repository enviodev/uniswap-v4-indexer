import { BigDecimal } from "envio";
import { ZERO_BD, ONE_BD, ZERO_BI } from "./constants";

export function exponentToBigDecimal(decimals: bigint): BigDecimal {
  let resultString = "1";

  for (let i = 0; i < Number(decimals); i++) {
    resultString += "0";
  }

  return new BigDecimal(resultString);
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.eq(ZERO_BD)) {
    return ZERO_BD;
  } else {
    return amount0.div(amount1);
  }
}

// Cap BigDecimal precision at 40 decimal places. Postgres btree indexes have a
// hard 2704-byte-per-row limit, so an unbounded BigDecimal (e.g. from a runaway
// derivedETH on a manipulated oracle pool) can fail INSERTs on indexed numeric
// columns. Apply at indexed-column writes and at price-source values that
// propagate downstream (derivedETH, ethPriceUSD).
export function sanitizeBD(value: BigDecimal): BigDecimal {
  return new BigDecimal(value.toFixed(40));
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
  return new BigDecimal(tokenAmount.toString()).div(
    exponentToBigDecimal(exchangeDecimals)
  );
}
