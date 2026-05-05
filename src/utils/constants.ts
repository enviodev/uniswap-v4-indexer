import { BigDecimal } from "envio";

// Note: BigInt is a native type in TypeScript/JavaScript
// so we don't need to import it specifically for Envio

import { hexToBigInt } from "./index";

export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

export const ZERO_BI = BigInt(0);
export const ONE_BI = BigInt(1);
export const ZERO_BD = new BigDecimal("0");
export const ONE_BD = new BigDecimal("1");
export const Q96 = BigInt(2) ** BigInt(96);
export const MaxUint256 = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
);
