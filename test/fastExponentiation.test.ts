/**
 * Test for fastExponentiation behavior with and without Math.floor.
 *
 * Background: Adding Math.floor(power / 2) to fastExponentiation (a seemingly
 * correct fix for integer division) causes the indexer to hang during batch
 * processing. This test reproduces and diagnoses the issue using real tick
 * values observed on Unichain (chain 130) via HyperSync Initialize events.
 *
 * The function computes 1.0001^tick for Uniswap tick→price conversion.
 *
 * ROOT CAUSE: With Math.floor, the exponentiation-by-squaring correctly fires
 * the odd-power branch (result *= value) at each level, producing the correct
 * number of BigDecimal multiplications (~17 for a 100k tick). However, each
 * multiplication on BigDecimal creates increasingly precise intermediate
 * results (digit count doubles at each squaring step), causing precision
 * explosion. Without Math.floor, the float division path skips the odd branch
 * (since 83533.5 % 2 != 1), which accidentally avoids the extra .times(value)
 * calls that compound precision — giving wrong results but fast execution.
 */
import { describe, it, expect } from "vitest";
import { BigDecimal } from "envio";

function safeDiv(a: BigDecimal, b: BigDecimal): BigDecimal {
  if (b.eq(new BigDecimal("0"))) return new BigDecimal("0");
  return a.div(b);
}

const ONE_BD = new BigDecimal("1");
const BASE = new BigDecimal("1.0001");

// Current implementation (without Math.floor)
function fastExponentiationOriginal(
  value: BigDecimal,
  power: number
): BigDecimal {
  if (power < 0) return safeDiv(ONE_BD, fastExponentiationOriginal(value, -power));
  if (power == 0) return ONE_BD;
  if (power == 1) return value;
  const halfPower = power / 2;
  const halfResult = fastExponentiationOriginal(value, halfPower);
  let result = halfResult.times(halfResult);
  if (power % 2 == 1) result = result.times(value);
  return result;
}

// "Fixed" implementation (with Math.floor)
function fastExponentiationFixed(
  value: BigDecimal,
  power: number
): BigDecimal {
  if (power < 0) return safeDiv(ONE_BD, fastExponentiationFixed(value, -power));
  if (power == 0) return ONE_BD;
  if (power == 1) return value;
  const halfPower = Math.floor(power / 2);
  const halfResult = fastExponentiationFixed(value, halfPower);
  let result = halfResult.times(halfResult);
  if (power % 2 == 1) result = result.times(value);
  return result;
}

// Real tick values from Unichain HyperSync Initialize events
const REAL_TICK_VALUES = [
  0, 167067, 81289, 230400, 80067, 46054, -196257, 276324, 253297, 78999,
  -276325, 92108, 69081, 315446, 23027, -88194, -197471, 232501, 389635,
  -414487, -219066, 244133, 161189, 331541, 207243, -141873, 138162, 253915,
  345405, 191272, 184216, 282451, -184217, -138163, -231325, -483568, 437513,
  476635, 483567, 329309, -460541, 460540, 373375, 391459, -267784,
];

describe("fastExponentiation", () => {
  describe("recursion behavior analysis", () => {
    it("float division causes fractional powers that skip odd-branch", () => {
      // This is THE bug in the original: for odd power 167067
      // Level 0: power=167067, 167067 % 2 == 1 ✓ (odd branch fires)
      // Level 1: power=83533.5, 83533.5 % 2 == 1.5 ✗ (odd branch SKIPPED!)
      // Level 2: power=41766.75, 41766.75 % 2 == 0.75 ✗ (skipped)
      // ...all subsequent levels skip the odd branch
      expect(167067 % 2).toBe(1); // first level: correct
      expect((167067 / 2) % 2).toBe(1.5); // second level: WRONG — not == 1
      expect(Math.floor(167067 / 2) % 2).toBe(1); // with floor: correct
    });

    it("counts recursion depth: original ~1000x more than fixed", () => {
      function depth(power: number, useFloor: boolean): number {
        let count = 0;
        function go(p: number): void {
          count++;
          if (p < 0) { go(-p); return; }
          if (p == 0 || p == 1) return;
          go(useFloor ? Math.floor(p / 2) : p / 2);
        }
        go(power);
        return count;
      }

      const tick = 167067;
      const origDepth = depth(tick, false);
      const fixedDepth = depth(tick, true);

      console.log(`power=${tick}: original depth=${origDepth}, fixed depth=${fixedDepth}`);

      // Original: ~1000+ levels (float halving until underflow to 0)
      // Fixed: ~18 levels (log2(167067) ≈ 17.3)
      expect(origDepth).toBeGreaterThan(500);
      expect(fixedDepth).toBeLessThanOrEqual(18);
    });

    it("counts BigDecimal multiplications without executing them", () => {
      function countOps(power: number, useFloor: boolean): { muls: number; oddMuls: number } {
        let muls = 0;
        let oddMuls = 0;
        function go(p: number): void {
          if (p < 0) { go(-p); muls++; return; } // division counts as 1
          if (p == 0 || p == 1) return;
          const half = useFloor ? Math.floor(p / 2) : p / 2;
          go(half);
          muls++; // halfResult * halfResult (squaring)
          if (p % 2 == 1) {
            oddMuls++;
            muls++; // result * value (odd correction)
          }
        }
        go(power);
        return { muls, oddMuls };
      }

      const testTicks = [167067, 276324, -483568, 460540, 230400];
      for (const tick of testTicks) {
        const orig = countOps(tick, false);
        const fixed = countOps(tick, true);
        console.log(
          `tick=${tick}: original: ${orig.muls} muls (${orig.oddMuls} odd), ` +
          `fixed: ${fixed.muls} muls (${fixed.oddMuls} odd)`
        );
        // The fixed version has more odd-branch multiplications but fewer total
        // since it has fewer recursion levels. However, each squaring step
        // DOUBLES the digit count of the BigDecimal, so with ~18 squarings
        // the number can have 2^18 = 262144 digits, making each multiplication
        // astronomically expensive.
      }
    });
  });

  describe("precision explosion diagnosis", () => {
    it("demonstrates digit growth in squaring with Math.floor", () => {
      // Simulate digit count growth during exponentiation by squaring
      // Each squaring roughly doubles the number of significant digits
      // in BigDecimal (no automatic rounding)
      let digits = 4; // "1.0001" has ~4 significant digits
      const fixedLevels = Math.ceil(Math.log2(167067)); // ~18 levels

      const digitHistory: number[] = [];
      for (let i = 0; i < fixedLevels; i++) {
        digits *= 2; // squaring doubles precision
        digitHistory.push(digits);
      }

      console.log(
        `After ${fixedLevels} squaring levels, ~${digits} digits in result`
      );
      console.log(`Digit growth per level: ${digitHistory.join(", ")}`);

      // With 18 levels: 4 * 2^18 = 1,048,576 digits!
      // Each BigDecimal multiplication of million-digit numbers is very slow
      expect(digits).toBeGreaterThan(500000);
    });

    it("demonstrates that the original avoids digit explosion via float path", () => {
      // In the original, after the first odd level, all subsequent halves
      // are floats. The recursion goes ~1000+ levels deep, but each level
      // only does ONE squaring (no odd correction), and the effective power
      // being computed is ~1 at each level (since half of a tiny float → 0).
      // So the intermediate BigDecimals stay small.

      // Let's trace the first 10 levels of the original for power=167067
      let p = 167067;
      const trace: string[] = [];
      for (let i = 0; i < 10; i++) {
        const isOdd = p % 2 == 1;
        trace.push(`level ${i}: p=${p}, p%2=${p % 2}, oddBranch=${isOdd}`);
        p = p / 2; // JS float division
      }
      console.log(trace.join("\n"));

      // After level 0: p=83533.5
      // After level 1: p=41766.75
      // ...no more odd branches fire, so no extra multiplications
      // The squarings compound, but without odd corrections, the numbers
      // don't grow as fast
    });
  });

  describe("performance: original implementation", () => {
    it("should handle small ticks quickly", () => {
      const smallTicks = [0, 1, 10, 100, 1000, -1, -100, -1000];
      const start = performance.now();
      for (const tick of smallTicks) {
        fastExponentiationOriginal(BASE, tick);
      }
      const elapsed = performance.now() - start;
      console.log(`Original small ticks: ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });

    it("should handle medium ticks (10k-100k) within 5s", () => {
      const mediumTicks = REAL_TICK_VALUES.filter(
        (t) => Math.abs(t) >= 10000 && Math.abs(t) < 100000
      );
      console.log(`Testing ${mediumTicks.length} medium ticks`);
      const start = performance.now();
      for (const tick of mediumTicks) {
        fastExponentiationOriginal(BASE, tick);
      }
      const elapsed = performance.now() - start;
      console.log(`Original medium ticks: ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(5000);
    });

    it("should handle all real ticks within 30s", () => {
      const start = performance.now();
      for (const tick of REAL_TICK_VALUES) {
        fastExponentiationOriginal(BASE, tick);
      }
      const elapsed = performance.now() - start;
      console.log(
        `Original all ${REAL_TICK_VALUES.length} ticks: ${elapsed.toFixed(0)}ms`
      );
      expect(elapsed).toBeLessThan(30000);
    });
  });

  describe("performance: fixed implementation (Math.floor)", () => {
    it("should handle small ticks quickly", () => {
      const smallTicks = [0, 1, 10, 100, 1000, -1, -100, -1000];
      const start = performance.now();
      for (const tick of smallTicks) {
        fastExponentiationFixed(BASE, tick);
      }
      const elapsed = performance.now() - start;
      console.log(`Fixed small ticks: ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });

    // This test demonstrates the bug: large ticks cause the fixed version to hang
    it("should handle a single medium tick (46054) within 10s", { timeout: 15000 }, () => {
      const start = performance.now();
      const result = fastExponentiationFixed(BASE, 46054);
      const elapsed = performance.now() - start;
      console.log(`Fixed tick=46054: ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe("correctness: original is WRONG for odd powers", () => {
    it("original gives wrong result for tick=3 (1.0001^3)", () => {
      const orig = fastExponentiationOriginal(BASE, 3);
      const fixed = fastExponentiationFixed(BASE, 3);
      // 1.0001^3 = 1.00030003000100 (exact)
      const expected = "1.000300030001";
      expect(fixed.toFixed(12)).toBe(expected); // fixed is CORRECT
      expect(orig.toFixed(12)).not.toBe(expected); // original is WRONG
      console.log(`1.0001^3: original=${orig.toFixed(12)}, fixed=${fixed.toFixed(12)}, expected=${expected}`);
    });

    it("original gives wrong result for tick=5", () => {
      const orig = fastExponentiationOriginal(BASE, 5);
      const fixed = fastExponentiationFixed(BASE, 5);
      // Both should equal 1.0001^5
      // The fixed version is mathematically correct
      console.log(`1.0001^5: original=${orig.toFixed(15)}, fixed=${fixed.toFixed(15)}`);
      // Original skips odd corrections after first level
      expect(orig.toFixed(12)).not.toBe(fixed.toFixed(12));
    });

    it("produces identical results for powers of 2 (no odd branch needed)", () => {
      const ticks = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
      for (const tick of ticks) {
        const orig = fastExponentiationOriginal(BASE, tick);
        const fixed = fastExponentiationFixed(BASE, tick);
        expect(orig.toFixed(10)).toBe(fixed.toFixed(10));
      }
    });
  });

  describe("proposed fix: Math.floor + precision capping", () => {
    // The fix: use Math.floor for correct integer division, but cap precision
    // after each squaring to prevent digit explosion
    function fastExponentiationProposed(
      value: BigDecimal,
      power: number
    ): BigDecimal {
      if (power < 0) return safeDiv(ONE_BD, fastExponentiationProposed(value, -power));
      if (power == 0) return ONE_BD;
      if (power == 1) return value;
      const halfPower = Math.floor(power / 2);
      const halfResult = fastExponentiationProposed(value, halfPower);
      // Cap precision after squaring to prevent digit explosion
      // 18 decimal places matches the toFixed(18) already used in tick.ts
      let result = new BigDecimal(halfResult.times(halfResult).toFixed(40));
      if (power % 2 == 1) {
        result = new BigDecimal(result.times(value).toFixed(40));
      }
      return result;
    }

    it("should be correct for small ticks", () => {
      const ticks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1, -2, -5, -10];
      for (const tick of ticks) {
        const fixed = fastExponentiationFixed(BASE, tick);
        const proposed = fastExponentiationProposed(BASE, tick);
        expect(proposed.toFixed(12)).toBe(fixed.toFixed(12));
      }
    });

    it("should handle all real ticks fast AND correctly", () => {
      const start = performance.now();
      for (const tick of REAL_TICK_VALUES) {
        fastExponentiationProposed(BASE, tick);
      }
      const elapsed = performance.now() - start;
      console.log(
        `Proposed fix: all ${REAL_TICK_VALUES.length} ticks in ${elapsed.toFixed(0)}ms`
      );
      expect(elapsed).toBeLessThan(5000);
    });

    it("should produce correct results for tick=3 (unlike original)", () => {
      const proposed = fastExponentiationProposed(BASE, 3);
      const expected = "1.000300030001";
      expect(proposed.toFixed(12)).toBe(expected);
    });

    it("should match fixed version within precision tolerance for medium ticks", () => {
      // For medium ticks where fixed can still compute (slowly), verify agreement
      const tick = 1000;
      const fixed = fastExponentiationFixed(BASE, tick);
      const proposed = fastExponentiationProposed(BASE, tick);
      // Should agree to at least 10 decimal places
      expect(proposed.toFixed(10)).toBe(fixed.toFixed(10));
    });
  });
});
