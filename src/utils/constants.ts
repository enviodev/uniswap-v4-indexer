import { BigDecimal } from "generated";

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

// LPFeeLibrary.DYNAMIC_FEE_FLAG. Pools initialized with this fee have their fee
// determined by the hook at swap time, not fixed at creation.
export const DYNAMIC_FEE_FLAG = BigInt(8_388_608);
// Static fee tiers above this (>5% = 50_000 hundredths-of-bip) are almost always
// specialized wrapper/LST products rather than AMM pools. Their reported TVL is
// not a reliable AMM TVL and is excluded from trackedTVLUSD.
export const HIGH_STATIC_FEE_THRESHOLD = BigInt(50_000);
