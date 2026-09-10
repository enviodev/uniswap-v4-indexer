/*
 * Uncollected-fee math and BalanceDelta decoding.
 *
 * A near-verbatim port of the Ponder indexer's `core/fees.ts` and
 * `core/balanceDelta.ts`. The arithmetic, the guards and the deliberate
 * omissions are all carried across unchanged, because that code is already
 * tested against live data on four chains — the point of this migration is to
 * change the runtime, not the numbers.
 *
 * Raw base units throughout. The consumer divides into decimals downstream.
 */

/** 2^128, the fee-growth fixed-point scale. */
export const Q128 = 1n << 128n;
export const MAX_UINT256 = (1n << 256n) - 1n;

export interface UncollectedFees {
  amount0: bigint;
  amount1: bigint;
}

/**
 * uint256 wrap for fee-growth ring arithmetic.
 *
 * Kept for reference and deliberately NOT used, exactly as in Ponder: a
 * negative off-chain delta is a stale or out-of-range read, not a real modular
 * wrap, so the code below clamps instead of wrapping.
 */
export function toUint256(n: bigint): bigint {
  return n < 0n ? n + (MAX_UINT256 + 1n) : n;
}

/**
 * uncollected = (feeGrowthInside − feeGrowthInsideLast) × liquidity / 2^128.
 *
 * ONE guard, and it matters: a negative delta is clamped to zero rather than
 * wrapped. Off-chain we compare an already-composed `feeGrowthInside` against a
 * stored baseline, so a negative result means a stale read or an out-of-range
 * stored baseline — not a genuine wrap — and `toUint256` wraparound would
 * manufacture a fee of roughly 2^256.
 *
 * There is intentionally NO magnitude cap. Token supply and decimals are
 * unbounded, so any ceiling silently drops legitimate large fees on cheap
 * high-supply tokens — which was the original bug in this logic. The
 * astronomical out-of-range artifact is prevented at the CALL SITE instead: the
 * sweep only diffs a position while it is IN RANGE, so the current read is a
 * small in-range value, and an out-of-range stored baseline then makes the delta
 * negative and it is clamped here. Never astronomical, so no cap is needed.
 *
 * Decimals are not parameters here for the same reason — there is nothing to
 * scale against.
 */
export function calculateUncollectedFees(
  liquidity: bigint,
  feeGrowthInside0X128: bigint,
  feeGrowthInside1X128: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
): UncollectedFees {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  const rawDelta0 = feeGrowthInside0X128 - feeGrowthInside0LastX128;
  const rawDelta1 = feeGrowthInside1X128 - feeGrowthInside1LastX128;
  if (rawDelta0 < 0n && rawDelta1 < 0n) return { amount0: 0n, amount1: 0n };

  const delta0 = rawDelta0 < 0n ? 0n : rawDelta0;
  const delta1 = rawDelta1 < 0n ? 0n : rawDelta1;

  return {
    amount0: (delta0 * liquidity) / Q128,
    amount1: (delta1 * liquidity) / Q128,
  };
}

// ─── BalanceDelta ────────────────────────────────────────────────────────────
//
// v4 packs two int128s into one int256: amount0 in the high 128 bits, amount1 in
// the low 128, each two's-complement signed. Used to read `modifyLiquidity`'s
// `feesAccrued` return value out of a call trace.

/** Sign-extend the low 128 bits of `v` to a signed bigint. */
export function signExt128(v: bigint): bigint {
  const masked = v & ((1n << 128n) - 1n);
  return masked >= 1n << 127n ? masked - (1n << 128n) : masked;
}

export function decodeBalanceDelta(u: bigint): { amount0: bigint; amount1: bigint } {
  return {
    amount0: signExt128(u >> 128n),
    amount1: signExt128(u & ((1n << 128n) - 1n)),
  };
}

/** Absolute value — `feesAccrued` is signed but a collected fee is a magnitude. */
export function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}
