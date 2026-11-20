/**
 * The hot-path helpers skip BigDecimal long division and string round-trips.
 * These tests pin them to the original BigDecimal code on random inputs, so the
 * indexed values stay identical.
 */
import { describe, expect, it } from "vitest";
import { BigDecimal, type Token } from "envio";
import {
  convertTokenToDecimal,
  divByPowerOfTen,
  half,
  sanitizeBD,
} from "../src/utils/index";
import { sqrtPriceX96ToTokenPrices } from "../src/utils/pricing";

// --- Original implementations, kept here as the reference ---
function refExponent(decimals: bigint): BigDecimal {
  let s = "1";
  for (let i = 0; i < Number(decimals); i++) s += "0";
  return new BigDecimal(s);
}
function refSafeDiv(a: BigDecimal, b: BigDecimal): BigDecimal {
  return b.eq(new BigDecimal("0")) ? new BigDecimal("0") : a.div(b);
}
function refConvert(amount: bigint, decimals: bigint): BigDecimal {
  if (decimals == 0n) return new BigDecimal(amount.toString());
  return new BigDecimal(amount.toString()).div(refExponent(decimals));
}
function refPrices(
  sqrtPriceX96: bigint,
  d0: bigint,
  d1: bigint
): [BigDecimal, BigDecimal] {
  const num = new BigDecimal((sqrtPriceX96 * sqrtPriceX96).toString());
  const denom = new BigDecimal((2n ** 192n).toString());
  const price1 = num.div(denom).times(refExponent(d0)).div(refExponent(d1));
  return [refSafeDiv(new BigDecimal("1"), price1), price1];
}
function refSanitize(v: BigDecimal): BigDecimal {
  return new BigDecimal(v.toFixed(40));
}

// Deterministic PRNG so failures reproduce.
let seed = 12345;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randBigInt(maxBits: number): bigint {
  const bits = 1 + Math.floor(rand() * maxBits);
  let v = 0n;
  for (let i = 0; i < bits; i += 16) {
    v = (v << 16n) | BigInt(Math.floor(rand() * 65536));
  }
  return v & ((1n << BigInt(bits)) - 1n);
}
const DECIMALS = [0n, 1n, 2n, 6n, 8n, 9n, 12n, 18n, 24n, 30n];
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
const token = (id: string, decimals: bigint) =>
  ({ id, decimals }) as unknown as Token;
const native = { symbol: "ETH", name: "Ether", decimals: 18n };

const same = (a: BigDecimal, b: BigDecimal) =>
  expect(a.toFixed(), `${a.toFixed()} vs ${b.toFixed()}`).toBe(b.toFixed());

describe("fast math matches the BigDecimal reference", () => {
  it("sqrtPriceX96ToTokenPrices", () => {
    for (let i = 0; i < 20000; i++) {
      const sqrtPrice = randBigInt(160);
      const d0 = pick(DECIMALS);
      const d1 = pick(DECIMALS);
      const [p0, p1] = sqrtPriceX96ToTokenPrices(
        sqrtPrice,
        token("1_0xa", d0),
        token("1_0xb", d1),
        native
      );
      const [r0, r1] = refPrices(sqrtPrice, d0, d1);
      same(p0, r0);
      same(p1, r1);
    }
  });

  it("convertTokenToDecimal", () => {
    for (let i = 0; i < 20000; i++) {
      const amount = randBigInt(256) * (rand() < 0.5 ? -1n : 1n);
      const d = pick(DECIMALS);
      same(convertTokenToDecimal(amount, d), refConvert(amount, d));
    }
  });

  it("divByPowerOfTen and half", () => {
    for (let i = 0; i < 20000; i++) {
      const v = new BigDecimal(
        `${rand() < 0.5 ? "-" : ""}${randBigInt(200)}e-${Math.floor(rand() * 60)}`
      );
      same(divByPowerOfTen(v, 6), v.div(new BigDecimal("1000000")));
      same(half(v), v.div(new BigDecimal("2")));
    }
  });

  it("sanitizeBD", () => {
    for (let i = 0; i < 20000; i++) {
      const v = new BigDecimal(
        `${rand() < 0.5 ? "-" : ""}${randBigInt(300)}e-${Math.floor(rand() * 90)}`
      );
      same(sanitizeBD(v), refSanitize(v));
    }
  });
});
