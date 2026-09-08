/*
 * Day / hour interval snapshots for pools, tokens and the per-chain protocol
 * rollup. Ported from v4-subgraph/src/utils/intervalUpdates.ts.
 *
 * Three structural differences from the subgraph, all forced by Envio:
 *
 * 1. The subgraph's helpers re-`load()` Pool / PoolManager from the store.
 *    Envio has no such aliasing: at the call sites the mutated pool/token/
 *    poolManager are still un-`set()` locals, so a `context.Pool.get()` here
 *    would return the PREVIOUS event's row. Every helper therefore takes the
 *    already-mutated entity object as an argument.
 *
 * 2. The subgraph mutates the returned entity a second time in the mapping and
 *    calls `save()` again. `context.X.set()` is a whole-object write with no
 *    handle to mutate afterwards, so the volume/fee deltas are passed IN.
 *    ModifyLiquidity and Initialize pass no delta (they contribute txCount and
 *    the price/TVL snapshot only, exactly as the subgraph does).
 *
 * 3. Ids are chain-namespaced. config.yaml does not set
 *    `disable_default_cross_chain`, so an entity id is the whole primary key
 *    across every configured chain.
 */

import {
  BigDecimal,
  type EvmOnEventContext,
  type Pool,
  type PoolDayData,
  type PoolHourData,
  type PoolManager,
  type Token,
  type TokenDayData,
  type TokenHourData,
  type UniswapDayData,
} from "envio";

import { ZERO_BD, ZERO_BI } from "./constants";
import { sanitizeBD } from "./index";

type handlerContext = EvmOnEventContext;

const DAY = 86400;
const HOUR = 3600;

/* -------------------------------------------------------------------------- */
/* Period keys                                                                */
/* -------------------------------------------------------------------------- */

// `event.block.timestamp` is a JS `number` (unix seconds) in Envio, not a
// bigint, so this is Math.floor and not truncating bigint division.
export function dayIndex(blockTimestamp: number): number {
  return Math.floor(blockTimestamp / DAY);
}

export function hourIndex(blockTimestamp: number): number {
  return Math.floor(blockTimestamp / HOUR);
}

export function dayStartUnix(blockTimestamp: number): number {
  return dayIndex(blockTimestamp) * DAY;
}

export function hourStartUnix(blockTimestamp: number): number {
  return hourIndex(blockTimestamp) * HOUR;
}

/* -------------------------------------------------------------------------- */
/* Ids                                                                        */
/* -------------------------------------------------------------------------- */
/*
 * `pool.id` is already `<chainId>_<poolIdBytes32>` and `token.id` is already
 * `<chainId>_<address lowercased>`, so these append to the existing id rather
 * than re-deriving it. Re-deriving a token id from event params would use the
 * un-lowercased address and silently create a parallel row set.
 *
 * The separator is `_`, matching every other id in this indexer (the subgraph
 * uses `-`; src/utils/pricing.ts parses ids positionally with `.split("_")`).
 * No component can contain `_` — chainId and the period index are decimal, the
 * pool id and address are fixed-length 0x hex — so the ids are unambiguous.
 */

export function poolDayDataId(poolId: string, blockTimestamp: number): string {
  return `${poolId}_${dayIndex(blockTimestamp)}`;
}

export function poolHourDataId(poolId: string, blockTimestamp: number): string {
  return `${poolId}_${hourIndex(blockTimestamp)}`;
}

export function tokenDayDataId(tokenId: string, blockTimestamp: number): string {
  return `${tokenId}_${dayIndex(blockTimestamp)}`;
}

export function tokenHourDataId(tokenId: string, blockTimestamp: number): string {
  return `${tokenId}_${hourIndex(blockTimestamp)}`;
}

// Chain-scoped, NOT the subgraph's bare dayIndex: a bare dayIndex would merge
// every chain's daily rollup into one row where the accumulated columns
// (volumeUSD, feesUSD) sum cross-chain while the assigned ones (tvlUSD,
// txCount) are last-writer-wins.
//
// Invariant: exactly one PoolManager address per chain (true in config.yaml and
// config.yaml today). If a chain ever gains a second PoolManager,
// switch to `${poolManager.id}_${dayIndex(...)}`.
export function uniswapDayDataId(chainId: bigint | number, blockTimestamp: number): string {
  return `${chainId}_${dayIndex(blockTimestamp)}`;
}

/* -------------------------------------------------------------------------- */
/* Volume / fee deltas                                                        */
/* -------------------------------------------------------------------------- */

export type PoolIntervalDelta = {
  volumeToken0: BigDecimal;
  volumeToken1: BigDecimal;
  volumeUSD: BigDecimal;
  feesUSD: BigDecimal;
};

export type TokenIntervalDelta = {
  volume: BigDecimal;
  volumeUSD: BigDecimal;
  untrackedVolumeUSD: BigDecimal;
  feesUSD: BigDecimal;
};

export type UniswapIntervalDelta = {
  volumeETH: BigDecimal;
  volumeUSD: BigDecimal;
  feesUSD: BigDecimal;
};

// BigDecimal (bignumber.js) instances are immutable, so sharing these is safe.
export const ZERO_POOL_DELTA: PoolIntervalDelta = {
  volumeToken0: ZERO_BD,
  volumeToken1: ZERO_BD,
  volumeUSD: ZERO_BD,
  feesUSD: ZERO_BD,
};

export const ZERO_TOKEN_DELTA: TokenIntervalDelta = {
  volume: ZERO_BD,
  volumeUSD: ZERO_BD,
  untrackedVolumeUSD: ZERO_BD,
  feesUSD: ZERO_BD,
};

export const ZERO_UNISWAP_DELTA: UniswapIntervalDelta = {
  volumeETH: ZERO_BD,
  volumeUSD: ZERO_BD,
  feesUSD: ZERO_BD,
};

/* -------------------------------------------------------------------------- */
/* Preload                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Warm the interval rows for this event during the preload pass.
 *
 * Envio runs each handler twice: a parallel preload pass that batches every
 * `context.X.get()` into one round trip, then a sequential pass where writes
 * take effect. All five update* helpers run AFTER the `if (context.isPreload)
 * return;` guard, so their reads would otherwise degrade to individual
 * sequential fetches. Call this BEFORE the guard — every id it needs depends
 * only on the block timestamp and the pool/token ids, which are known by then.
 *
 * Results are discarded: the point is the side effect of populating the load
 * layer's in-memory table, which the sequential pass then short-circuits to.
 */
export async function preloadIntervalData(
  context: handlerContext,
  opts: {
    blockTimestamp: number;
    chainId: bigint | number;
    poolId?: string;
    tokenIds?: readonly string[];
    includeUniswapDayData?: boolean;
  }
): Promise<void> {
  const {
    blockTimestamp,
    chainId,
    poolId,
    tokenIds = [],
    includeUniswapDayData = false,
  } = opts;

  const reads: Promise<unknown>[] = [];

  if (poolId !== undefined) {
    reads.push(context.PoolDayData.get(poolDayDataId(poolId, blockTimestamp)));
    reads.push(context.PoolHourData.get(poolHourDataId(poolId, blockTimestamp)));
  }

  for (const tokenId of tokenIds) {
    reads.push(context.TokenDayData.get(tokenDayDataId(tokenId, blockTimestamp)));
    reads.push(context.TokenHourData.get(tokenHourDataId(tokenId, blockTimestamp)));
  }

  if (includeUniswapDayData) {
    reads.push(
      context.UniswapDayData.get(uniswapDayDataId(chainId, blockTimestamp))
    );
  }

  await Promise.all(reads);
}

/* -------------------------------------------------------------------------- */
/* UniswapDayData                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Per-chain protocol-wide daily rollup.
 *
 * `tvlUSD` and `txCount` are ASSIGNED from the PoolManager snapshot, not
 * accumulated - matching the subgraph. `volumeUSDUntracked` is initialised to
 * zero and never written again, also matching the subgraph.
 */
export async function updateUniswapDayData(
  context: handlerContext,
  poolManager: PoolManager,
  blockTimestamp: number,
  delta: UniswapIntervalDelta = ZERO_UNISWAP_DELTA
): Promise<UniswapDayData> {
  const id = uniswapDayDataId(poolManager.chainId, blockTimestamp);
  const existing = await context.UniswapDayData.get(id);

  const base: UniswapDayData = existing ?? {
    id,
    chainId: poolManager.chainId,
    date: dayStartUnix(blockTimestamp),
    volumeETH: ZERO_BD,
    volumeUSD: ZERO_BD,
    volumeUSDUntracked: ZERO_BD,
    feesUSD: ZERO_BD,
    txCount: ZERO_BI,
    tvlUSD: ZERO_BD,
  };

  const updated: UniswapDayData = {
    ...base,
    volumeETH: sanitizeBD(base.volumeETH.plus(delta.volumeETH)),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(delta.volumeUSD)),
    feesUSD: sanitizeBD(base.feesUSD.plus(delta.feesUSD)),
    // snapshots, not accumulations
    tvlUSD: poolManager.totalValueLockedUSD,
    txCount: poolManager.txCount,
  };

  context.UniswapDayData.set(updated);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* PoolDayData / PoolHourData                                                 */
/* -------------------------------------------------------------------------- */

export async function updatePoolDayData(
  context: handlerContext,
  pool: Pool,
  blockTimestamp: number,
  delta: PoolIntervalDelta = ZERO_POOL_DELTA
): Promise<PoolDayData> {
  const id = poolDayDataId(pool.id, blockTimestamp);
  const existing = await context.PoolDayData.get(id);

  const base: PoolDayData = existing ?? {
    id,
    chainId: pool.chainId,
    date: dayStartUnix(blockTimestamp),
    pool_id: pool.id,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    txCount: ZERO_BI,
    open: pool.token0Price,
    high: pool.token0Price,
    low: pool.token0Price,
    close: pool.token0Price,
  };

  const updated: PoolDayData = {
    ...base,
    // end-of-period snapshot, overwritten on every event
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    close: pool.token0Price,
    high: pool.token0Price.gt(base.high) ? pool.token0Price : base.high,
    low: pool.token0Price.lt(base.low) ? pool.token0Price : base.low,
    // accumulated over the period
    volumeToken0: sanitizeBD(base.volumeToken0.plus(delta.volumeToken0)),
    volumeToken1: sanitizeBD(base.volumeToken1.plus(delta.volumeToken1)),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(delta.volumeUSD)),
    feesUSD: sanitizeBD(base.feesUSD.plus(delta.feesUSD)),
    txCount: base.txCount + 1n,
  };

  context.PoolDayData.set(updated);
  return updated;
}

export async function updatePoolHourData(
  context: handlerContext,
  pool: Pool,
  blockTimestamp: number,
  delta: PoolIntervalDelta = ZERO_POOL_DELTA
): Promise<PoolHourData> {
  const id = poolHourDataId(pool.id, blockTimestamp);
  const existing = await context.PoolHourData.get(id);

  const base: PoolHourData = existing ?? {
    id,
    chainId: pool.chainId,
    periodStartUnix: hourStartUnix(blockTimestamp),
    pool_id: pool.id,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    txCount: ZERO_BI,
    open: pool.token0Price,
    high: pool.token0Price,
    low: pool.token0Price,
    close: pool.token0Price,
  };

  const updated: PoolHourData = {
    ...base,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    close: pool.token0Price,
    high: pool.token0Price.gt(base.high) ? pool.token0Price : base.high,
    low: pool.token0Price.lt(base.low) ? pool.token0Price : base.low,
    volumeToken0: sanitizeBD(base.volumeToken0.plus(delta.volumeToken0)),
    volumeToken1: sanitizeBD(base.volumeToken1.plus(delta.volumeToken1)),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(delta.volumeUSD)),
    feesUSD: sanitizeBD(base.feesUSD.plus(delta.feesUSD)),
    txCount: base.txCount + 1n,
  };

  context.PoolHourData.set(updated);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* TokenDayData / TokenHourData                                               */
/* -------------------------------------------------------------------------- */
/*
 * `ethPriceUSD` is passed in rather than read from the Bundle so the caller
 * controls which price is used. Pass the SAME value the calling handler used
 * for `token.totalValueLockedUSD` (today: `bundle.ethPriceUSD`), or priceUSD
 * and totalValueLockedUSD in one row will disagree.
 *
 * Neither entity has a txCount field, so no counter is bumped here.
 */

export async function updateTokenDayData(
  context: handlerContext,
  token: Token,
  ethPriceUSD: BigDecimal,
  blockTimestamp: number,
  delta: TokenIntervalDelta = ZERO_TOKEN_DELTA
): Promise<TokenDayData> {
  const id = tokenDayDataId(token.id, blockTimestamp);
  const tokenPrice = sanitizeBD(token.derivedETH.times(ethPriceUSD));
  const existing = await context.TokenDayData.get(id);

  const base: TokenDayData = existing ?? {
    id,
    chainId: token.chainId,
    date: dayStartUnix(blockTimestamp),
    token_id: token.id,
    volume: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
    priceUSD: tokenPrice,
    feesUSD: ZERO_BD,
    open: tokenPrice,
    high: tokenPrice,
    low: tokenPrice,
    close: tokenPrice,
  };

  const updated: TokenDayData = {
    ...base,
    close: tokenPrice,
    priceUSD: tokenPrice,
    high: tokenPrice.gt(base.high) ? tokenPrice : base.high,
    low: tokenPrice.lt(base.low) ? tokenPrice : base.low,
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
    volume: sanitizeBD(base.volume.plus(delta.volume)),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(delta.volumeUSD)),
    untrackedVolumeUSD: sanitizeBD(
      base.untrackedVolumeUSD.plus(delta.untrackedVolumeUSD)
    ),
    feesUSD: sanitizeBD(base.feesUSD.plus(delta.feesUSD)),
  };

  context.TokenDayData.set(updated);
  return updated;
}

export async function updateTokenHourData(
  context: handlerContext,
  token: Token,
  ethPriceUSD: BigDecimal,
  blockTimestamp: number,
  delta: TokenIntervalDelta = ZERO_TOKEN_DELTA
): Promise<TokenHourData> {
  const id = tokenHourDataId(token.id, blockTimestamp);
  const tokenPrice = sanitizeBD(token.derivedETH.times(ethPriceUSD));
  const existing = await context.TokenHourData.get(id);

  const base: TokenHourData = existing ?? {
    id,
    chainId: token.chainId,
    periodStartUnix: hourStartUnix(blockTimestamp),
    token_id: token.id,
    volume: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
    priceUSD: tokenPrice,
    feesUSD: ZERO_BD,
    open: tokenPrice,
    high: tokenPrice,
    low: tokenPrice,
    close: tokenPrice,
  };

  const updated: TokenHourData = {
    ...base,
    close: tokenPrice,
    priceUSD: tokenPrice,
    high: tokenPrice.gt(base.high) ? tokenPrice : base.high,
    low: tokenPrice.lt(base.low) ? tokenPrice : base.low,
    totalValueLocked: token.totalValueLocked,
    totalValueLockedUSD: token.totalValueLockedUSD,
    volume: sanitizeBD(base.volume.plus(delta.volume)),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(delta.volumeUSD)),
    untrackedVolumeUSD: sanitizeBD(
      base.untrackedVolumeUSD.plus(delta.untrackedVolumeUSD)
    ),
    feesUSD: sanitizeBD(base.feesUSD.plus(delta.feesUSD)),
  };

  context.TokenHourData.set(updated);
  return updated;
}
