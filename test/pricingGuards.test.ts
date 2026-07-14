/**
 * Tests for findNativePerToken's imbalance guard
 * (MAX_PRICING_POOL_VALUE_IMBALANCE): a pool may only set a token's derivedETH
 * when the value it implies for the token side is ≤ 1000× the pool's
 * verifiable (whitelisted) side. The bound is empirical (see pricing.ts) —
 * concentrated liquidity legitimately produces lopsided pools into the
 * hundreds×, junk starts at ~7,600×.
 *
 * Fixtures replicate real attacks observed on the production indexer
 * (2026-07-13 forensics):
 *  - USDC/being (Base):   $4,388 real USDC → $5.0e27 fake TVL (poison-and-park)
 *  - ETH/1xETH (mainnet): 1.010 ETH parked (threshold is 1.0) + 1.3e9 tokens
 *    priced at exactly 1 ETH — honest-looking price, fake balance
 *  - agETH (mainnet):     real Kelp LST hijacked via a 99.99%-fee trap pool,
 *    derivedETH poisoned to 1.1173e4 ETH (real ≈ 1 ETH)
 */
import { describe, it, expect } from "vitest";
import { BigDecimal } from "envio";
import {
  findNativePerToken,
  MAX_PRICING_POOL_VALUE_IMBALANCE,
} from "../src/utils/pricing";

const bd = (v: string | number) => new BigDecimal(v.toString());

const CHAIN = "1";
const ETH_PRICE_USD = bd(2000);
const MIN_NATIVE_LOCKED = bd(1);

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const STABLECOINS = [USDC];

const tokenId = (addr: string) => `${CHAIN}_${addr}`;

/** Minimal Token entity for pricing purposes. */
function makeToken(
  addr: string,
  opts: { derivedETH?: BigDecimal; whitelistPools?: string[] } = {}
) {
  return {
    id: tokenId(addr),
    derivedETH: opts.derivedETH ?? bd(0),
    whitelistPools: opts.whitelistPools ?? [],
  } as any;
}

/**
 * Minimal whitelist Pool entity. The whitelisted token is always token0 and
 * the token being priced is token1, so findNativePerToken's isToken0 branch
 * (ethLocked from token0's side, candidate price = token0Price × derivedETH)
 * is exercised — the same shape as every observed attack pool.
 */
function makePool(
  id: string,
  opts: {
    token0: string;
    token1: string;
    tvl0: BigDecimal; // whitelisted side balance
    tvl1: BigDecimal; // priced-token side balance
    token0Price: BigDecimal; // price of token1 in units of token0's ETH value
    liquidity?: bigint;
  }
) {
  return {
    id,
    token0: tokenId(opts.token0),
    token1: tokenId(opts.token1),
    totalValueLockedToken0: opts.tvl0,
    totalValueLockedToken1: opts.tvl1,
    token0Price: opts.token0Price,
    token1Price: bd(0), // unused in the isToken0 branch
    liquidity: opts.liquidity ?? 1n,
  } as any;
}

/** In-memory stand-in for the handler context used by findNativePerToken. */
function makeContext(pools: any[], tokens: any[]) {
  const poolMap = new Map(pools.map((p) => [p.id, p]));
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  return {
    Bundle: {
      get: async (id: string) =>
        id === CHAIN ? { id, ethPriceUSD: ETH_PRICE_USD } : undefined,
    },
    Pool: { get: async (id: string) => poolMap.get(id) },
    Token: { get: async (id: string) => tokenMap.get(id) },
  } as any;
}

const priceFor = (context: any, token: any) =>
  findNativePerToken(context, token, WETH, STABLECOINS, MIN_NATIVE_LOCKED);

describe("findNativePerToken imbalance guard", () => {
  const weth = makeToken(WETH, { derivedETH: bd(1) });

  it("rejects poison-and-park: USDC/being anatomy ($4,388 real vs $5e27 claimed)", async () => {
    // 4,388.72 USDC (2.19 ETH — passes the 1 ETH threshold) against 200M
    // `being` priced at ~1.25e16 ETH each. Pre-guard this set derivedETH and
    // produced the $5e27 pool. The guard must reject the price entirely.
    const usdc = makeToken(USDC, { derivedETH: bd("0.0005") }); // 1/2000
    const being = makeToken("0xbbbe40e7ae6e22aad49d6a7c9389ef25714be179", {
      whitelistPools: ["poison-pool"],
    });
    const pool = makePool("poison-pool", {
      token0: USDC,
      token1: being.id.split("_")[1]!,
      tvl0: bd("4388.723262"),
      tvl1: bd("200000000"),
      token0Price: bd("2.5e19"), // being priced in USDC terms
    });
    const context = makeContext([pool], [usdc, weth]);

    const price = await priceFor(context, being);
    expect(price.eq(bd(0))).toBe(true);
  });

  it("rejects honest-price fake-balance: ETH/1xETH anatomy (1.01 ETH vs 1.3e9 tokens at parity)", async () => {
    // The price (exactly 1 ETH) looks perfectly legitimate — the lie is the
    // 1.3 billion free-minted tokens. Implied side value 1.3e9 ETH ≫ 100 × 1.01.
    const oneXEth = makeToken("0x41d91195960719e3c0077a9dd1716a050708b9b1", {
      whitelistPools: ["surgical-pool"],
    });
    const pool = makePool("surgical-pool", {
      token0: WETH,
      token1: oneXEth.id.split("_")[1]!,
      tvl0: bd("1.01"), // surgically just above the 1.0 threshold
      tvl1: bd("1300000000"),
      token0Price: bd(1),
    });
    const context = makeContext([pool], [weth]);

    const price = await priceFor(context, oneXEth);
    expect(price.eq(bd(0))).toBe(true);
  });

  it("trap pool with larger ethLocked loses to a balanced legit pool: agETH anatomy", async () => {
    // The 99.99%-fee trap pool has MORE whitelisted capital than the legit
    // pool, so pre-guard it won the largest-ethLocked selection and poisoned
    // agETH's derivedETH to ~1.1e4 ETH. The guard must skip it and let the
    // balanced pool set the real ~1 ETH price.
    const agEth = makeToken("0xe1b4d34e8754600962cd944b535180bd758e6c2e", {
      whitelistPools: ["trap-pool", "legit-pool"],
    });
    const trap = makePool("trap-pool", {
      token0: WETH,
      token1: agEth.id.split("_")[1]!,
      tvl0: bd("55"),
      tvl1: bd("30"),
      token0Price: bd("11173"), // poisoned price
    });
    const legit = makePool("legit-pool", {
      token0: WETH,
      token1: agEth.id.split("_")[1]!,
      tvl0: bd("50"),
      tvl1: bd("49"),
      token0Price: bd("1.02"), // real LST price
    });
    const context = makeContext([trap, legit], [weth]);

    const price = await priceFor(context, agEth);
    expect(price.eq(bd("1.02"))).toBe(true);
  });

  it("accepts a legit memecoin pool with balanced sides (PEPE/ETH shape)", async () => {
    // 500 WETH against 8.5e10 PEPE at 5.88e-9 ETH each ≈ 500 ETH — balanced,
    // so the guard must not interfere with normal long-tail pricing.
    const pepe = makeToken("0x6982508145454ce325ddbe47a25d4ec3d2311933", {
      whitelistPools: ["pepe-pool"],
    });
    const pool = makePool("pepe-pool", {
      token0: WETH,
      token1: pepe.id.split("_")[1]!,
      tvl0: bd("500"),
      tvl1: bd("85000000000"),
      token0Price: bd("5.88e-9"),
    });
    const context = makeContext([pool], [weth]);

    const price = await priceFor(context, pepe);
    expect(price.eq(bd("5.88e-9"))).toBe(true);
  });

  it("accepts exactly at the imbalance bound (lte, not lt)", async () => {
    // implied side value == 1000 × ethLocked must still pass.
    const token = makeToken("0x1111111111111111111111111111111111111111", {
      whitelistPools: ["edge-pool"],
    });
    const pool = makePool("edge-pool", {
      token0: WETH,
      token1: token.id.split("_")[1]!,
      tvl0: bd("10"),
      tvl1: bd("10000"),
      token0Price: bd("1"), // implied = 10000 = 1000 × 10
    });
    const context = makeContext([pool], [weth]);

    const price = await priceFor(context, token);
    expect(price.eq(bd("1"))).toBe(true);
    expect(MAX_PRICING_POOL_VALUE_IMBALANCE.eq(bd(1000))).toBe(true);
  });

  it("accepts a legitimately lopsided launch pool (wide one-sided range, ~500x)", async () => {
    // v4 concentrated liquidity: a wide-range launch that has only been
    // bought into slightly holds most of its value as token overhang at spot.
    // Measured organic pools reach the hundreds×; the guard must not reject
    // them (this shape sat in the false-positive band when the bound was 100).
    const launch = makeToken("0x4444444444444444444444444444444444444444", {
      whitelistPools: ["launch-pool"],
    });
    const pool = makePool("launch-pool", {
      token0: WETH,
      token1: launch.id.split("_")[1]!,
      tvl0: bd("2"), // real ETH bought in so far
      tvl1: bd("900000000"), // remaining overhang
      token0Price: bd("1.1e-6"), // implied ≈ 990 ETH ≈ 495 × ethLocked
    });
    const context = makeContext([pool], [weth]);

    const price = await priceFor(context, launch);
    expect(price.eq(bd("1.1e-6"))).toBe(true);
  });

  it("still enforces minimumNativeLocked on balanced pools", async () => {
    const token = makeToken("0x2222222222222222222222222222222222222222", {
      whitelistPools: ["tiny-pool"],
    });
    const pool = makePool("tiny-pool", {
      token0: WETH,
      token1: token.id.split("_")[1]!,
      tvl0: bd("0.5"), // below the 1 ETH minimum
      tvl1: bd("0.5"),
      token0Price: bd("1"),
    });
    const context = makeContext([pool], [weth]);

    const price = await priceFor(context, token);
    expect(price.eq(bd(0))).toBe(true);
  });

  it("leaves the wrapped-native and stablecoin fast paths untouched", async () => {
    const context = makeContext([], []);
    const wethPrice = await priceFor(context, makeToken(WETH));
    expect(wethPrice.eq(bd(1))).toBe(true);

    const usdcPrice = await priceFor(context, makeToken(USDC));
    expect(usdcPrice.eq(bd("0.0005"))).toBe(true); // 1 / 2000
  });
});
