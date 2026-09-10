/*
 * Position-level accounting for Uniswap v4 NFT liquidity positions.
 *
 * Ported from the Ponder indexer (`copypools-subgraph/ponder/apps/v4/src/index.ts`
 * + `core/`), deliberately mechanism-for-mechanism rather than redesigned: that
 * logic is already tested against live data on four chains, so the port keeps its
 * arithmetic, its rounding and its edge cases and changes only the runtime.
 *
 * WHAT MAKES THIS POSSIBLE WITHOUT AN RPC CALL
 *
 * `ModifyLiquidity.salt` IS the NFT tokenId — PositionManager packs it there, and
 * Ponder relies on exactly that (`index.ts:176`, `BigInt(salt).toString()`). The
 * event is otherwise position-blind, so without reading `salt` there is no way to
 * attribute a liquidity change to a position at all. Envio's handler has always
 * received the field and never read it.
 *
 * Current pooled `amount0`/`amount1` are pure math over
 * (tickLower, tickUpper, pool.tick, liquidity, pool.sqrtPrice). Ponder needs an
 * `eth_call` to `getSlot0` for the last two; here they come from `Initialize` and
 * `Swap`, and in v4 only a swap can move the tick — so the event-tracked values
 * equal on-chain slot0 and the whole amounts path costs nothing.
 *
 * WHAT IS NOT HERE
 *
 * Fee accounting. `totalFeesUncollected*` needs `getFeeGrowthInside`, and
 * `totalFeesCollected*` needs the `feesAccrued` return value of
 * `modifyLiquidity`, which appears in no log — v4 has no Collect event and
 * `ModifyLiquidity` carries no fee field. Both arrive later, through effects, and
 * both leave the fields at their previous value until then.
 */

import { BigDecimal } from "envio";
import { getAmount0, getAmount1 } from "./liquidityMath/liquidityAmounts";
import { TickMath } from "./liquidityMath/tickMath";
import { convertTokenToDecimal } from "./index";
import { ZERO_BD } from "./constants";

/**
 * The tokenId encoded in a `ModifyLiquidity.salt`, or `undefined` when the salt
 * carries none.
 *
 * Zero is treated as absent on purpose: it is the default salt for direct
 * liquidity provision and is not a minted NFT id.
 *
 * THIS FUNCTION DOES NOT ESTABLISH THAT THE SALT IS AN NFT ID, and cannot: a
 * salt is only a tokenId because the PositionManager put it there, and a
 * non-zero salt from any other caller is an arbitrary bytes32. The caller check
 * is the caller's job — see the `positionManagerFor` gate in
 * handlers/modifyLiquidity-handler.ts, which is Ponder's index.ts:165. Calling
 * this without that gate produces bogus positions and, when a salt collides
 * numerically with a live tokenId, corrupts a real one.
 */
export function tokenIdFromSalt(salt: string): bigint | undefined {
  try {
    const id = BigInt(salt);
    return id === 0n ? undefined : id;
  } catch {
    return undefined;
  }
}

export function positionId(chainId: number | bigint, tokenId: bigint): string {
  return `${chainId}_${tokenId}`;
}

export type PositionTxType = "DEPOSIT" | "WITHDRAW" | "COLLECT_FEES";

/**
 * `type` is part of the identity, not a label.
 *
 * One `ModifyLiquidity` can produce BOTH a WITHDRAW and a COLLECT_FEES row at
 * the same txHash and logIndex — Ponder's primary key is
 * `(chainId, txHash, logIndex, type)` for exactly that reason. Envio ids are a
 * single string, so omitting `type` here silently drops one of the two rows.
 */
export function positionTxId(
  chainId: number | bigint,
  txHash: string,
  logIndex: number | bigint,
  type: PositionTxType,
): string {
  return `${chainId}_${txHash}_${logIndex}_${type}`;
}

/**
 * Gas in the chain's native token, human units.
 *
 * Note this is EXECUTION gas. On an OP-stack chain the L1 data fee is a separate
 * receipt field; Ponder omits it and documents that as unfixable there because
 * its receipt has no `l1Fee`. Envio's `field_selection` can request more, so this
 * takes whatever the caller supplies rather than assuming.
 */
export function gasCostEth(
  gasUsed: bigint | undefined,
  effectiveGasPrice: bigint | undefined,
  l1Fee?: bigint | undefined,
): BigDecimal {
  const execution = (gasUsed ?? 0n) * (effectiveGasPrice ?? 0n);
  // The OP-stack L1 data fee, already denominated in wei. Absent on non-OP
  // chains, where it is simply zero. Ponder cannot include this at all — its
  // receipt has no `l1Fee` and its own docs call that unfixable — so a position
  // on an OP-stack chain gets a MORE accurate gas figure here than there, and a
  // differential test against Ponder should expect this term to differ.
  return convertTokenToDecimal(execution + (l1Fee ?? 0n), 18n);
}

export interface PoolPriceState {
  readonly tick: bigint;
  readonly sqrtPriceX96: bigint;
}

/**
 * Current pooled amounts for a position, in human token units.
 *
 * Out-of-range positions hold entirely one side, which the tick-math functions
 * already handle — no special case needed here.
 */
export function currentAmounts(args: {
  tickLower: bigint;
  tickUpper: bigint;
  liquidity: bigint;
  pool: PoolPriceState;
  decimals0: bigint;
  decimals1: bigint;
}): { amount0: BigDecimal; amount1: BigDecimal } {
  const { tickLower, tickUpper, liquidity, pool, decimals0, decimals1 } = args;
  if (liquidity <= 0n) return { amount0: ZERO_BD, amount1: ZERO_BD };

  const raw0 = getAmount0(tickLower, tickUpper, pool.tick, liquidity, pool.sqrtPriceX96);
  const raw1 = getAmount1(tickLower, tickUpper, pool.tick, liquidity, pool.sqrtPriceX96);

  return {
    amount0: convertTokenToDecimal(raw0, decimals0),
    amount1: convertTokenToDecimal(raw1, decimals1),
  };
}

/**
 * Is a position in range, i.e. can it accrue new fees?
 *
 * Worth having as its own function: an out-of-range position's uncollected fees
 * are exactly zero, so the fee sweep can skip it entirely. Ponder knows this too
 * but cannot act on it before reading, because it needs `getSlot0` to learn the
 * tick. Here the tick is already known, which is what lets the sweep read only
 * the positions that can actually have changed.
 */
export function isInRange(tickLower: bigint, tickUpper: bigint, poolTick: bigint): boolean {
  return poolTick >= tickLower && poolTick < tickUpper;
}

/**
 * Is this pool's price at the edge of the representable domain?
 *
 * A port of Ponder's `isDegenerate` (core/math.ts), and it is a guard on the
 * ARITHMETIC, not on the pool's legitimacy. At the tick/sqrt-price domain
 * boundaries the amount formulas lose all precision and return values that are
 * numerically enormous but physically meaningless — the "astronomical artifact"
 * Ponder's comments refer to. A position in such a pool gets zeroed amounts and
 * `isPriceable: false` rather than a fabricated headline figure.
 *
 * The port previously hardcoded `isPriceable: true` and computed amounts
 * unconditionally, which is precisely how a degenerate pool produces a
 * plausible-looking multi-billion-dollar position.
 */
export function isDegenerate(tick: bigint, sqrtPriceX96: bigint): boolean {
  return (
    tick >= TickMath.MAX_TICK ||
    tick <= TickMath.MIN_TICK ||
    sqrtPriceX96 >= TickMath.MAX_SQRT_RATIO ||
    sqrtPriceX96 <= TickMath.MIN_SQRT_RATIO
  );
}

/**
 * A complete, zeroed Position row.
 *
 * Envio requires the whole entity on `set`, and a Transfer can legitimately
 * arrive BEFORE the position's first ModifyLiquidity — minting the NFT and
 * adding liquidity are separate events with no guaranteed order across a block.
 * So whichever handler sees the position first seeds it here, and the other
 * fills in what it owns. Liquidity state starts empty rather than absent, which
 * is also what makes the fields non-nullable in the schema.
 */
export function newPosition(args: {
  id: string;
  chainId: bigint;
  tokenId: bigint;
  owner: string;
  origin: string;
  timestamp: bigint;
  blockNumber: bigint;
}) {
  return {
    id: args.id,
    chainId: args.chainId,
    tokenId: args.tokenId,
    owner: args.owner,
    origin: args.origin,

    poolId: "",
    tickLower: 0n,
    tickUpper: 0n,
    liquidity: 0n,
    isActive: false,
    // Optimistic until the degenerate-pool guard runs on a real liquidity event.
    isPriceable: true,

    createdAtTimestamp: args.timestamp,
    createdAtBlockNumber: args.blockNumber,
    closedAtTimestamp: undefined,

    depositedToken0: ZERO_BD,
    depositedToken1: ZERO_BD,
    withdrawnToken0: ZERO_BD,
    withdrawnToken1: ZERO_BD,
    totalFeesCollected0: ZERO_BD,
    totalFeesCollected1: ZERO_BD,
    totalFeesUncollected0: ZERO_BD,
    totalFeesUncollected1: ZERO_BD,

    amount0: ZERO_BD,
    amount1: ZERO_BD,

    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,

    totalGasCostETH: ZERO_BD,

    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.timestamp,
    // Zero, not the current block: no fee read has happened yet, and claiming
    // otherwise would make the first sweep think this row was already current.
    feesUpdatedAtBlock: 0n,
    feesUpdatedAtTimestamp: 0n,
  };
}
