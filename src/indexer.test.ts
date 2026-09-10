/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/testing/SKILL.md for conventions.
 *
 * `eventsProcessed` ALSO MOVES WITH EFFECT CALLS. It went 12 -> 11 when the fee
 * sweep gained its `_gte` floor, and 11 -> 12 when `getFeeGrowthInside` stopped
 * being gated on `gateCanPass` (a mint now establishes its fee-growth baseline,
 * which is what stops a full close silently losing its collected fee). In both
 * cases the `changes` above were byte-identical — check that, since a real
 * dropped or duplicated event would show up there rather than in this counter.
 *
 * `eventsProcessed` COUNTS BLOCK-HANDLER ITEMS TOO. The fee sweep registers with
 * a `_gte` floor at the chain head as of process start (see
 * `src/handlers/feeSync-block.ts`), so no `feeSync` item is generated for a
 * historical block and this count is one lower than it was before that floor
 * existed. If you change the floor, expect this number to move — check that the
 * `changes` above it did NOT, since a real dropped event would show up there.
 *
 * TIMEOUT: these fetch real chain data over the network, so vitest's 5s default
 * is not a meaningful budget for them — it measures the network, not the code.
 * Two of them began failing at exactly 5006ms once the suite grew to eight
 * files, purely because more parallel workers compete for the same bandwidth;
 * each passes in ~2s when run alone. Raised here rather than globally, so unit
 * tests keep a tight budget and a genuine hang in one still fails fast.
 */

import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

const NETWORK_TIMEOUT_MS = 60_000;

describe("Uniswap V4 Indexer", { timeout: NETWORK_TIMEOUT_MS }, () => {
  it("Does not create Ticks for ModifyLiquidity on unknown pools", async (t) => {
    const indexer = createTestIndexer();

    t.expect(
      await indexer.process({
        chains: {
          1: { startBlock: 24240005, endBlock: 24240005 },
        },
      }),
      "ModifyLiquidity events whose pool is unknown (no prior Initialize) should be processed without writing Tick entities. The block also contains a PositionManager mint, captured as Position + Transfer."
    ).toMatchInlineSnapshot(`
      {
        "changes": [
          {
            "Position": {
              "sets": [
                {
                  "amount0": "0",
                  "amount1": "0",
                  "chainId": 1n,
                  "closedAtTimestamp": undefined,
                  "createdAtBlockNumber": 24240005n,
                  "createdAtTimestamp": 1768478831n,
                  "depositedToken0": "0",
                  "depositedToken1": "0",
                  "feeGrowthInside0LastX128": 0n,
                  "feeGrowthInside1LastX128": 0n,
                  "feesUpdatedAtBlock": 0n,
                  "feesUpdatedAtTimestamp": 0n,
                  "id": "1_133850",
                  "isActive": false,
                  "isPriceable": true,
                  "liquidity": 0n,
                  "origin": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "owner": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "poolId": "",
                  "tickLower": 0n,
                  "tickUpper": 0n,
                  "tokenId": 133850n,
                  "totalFeesCollected0": "0",
                  "totalFeesCollected1": "0",
                  "totalFeesUncollected0": "0",
                  "totalFeesUncollected1": "0",
                  "totalGasCostETH": "0",
                  "updatedAtBlock": 24240005n,
                  "updatedAtTimestamp": 1768478831n,
                  "withdrawnToken0": "0",
                  "withdrawnToken1": "0",
                },
              ],
            },
            "Transfer": {
              "sets": [
                {
                  "chainId": 1n,
                  "from": "0x0000000000000000000000000000000000000000",
                  "id": "1_24240005_344",
                  "logIndex": 344n,
                  "origin": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "position_id": "1_133850",
                  "timestamp": 1768478831n,
                  "to": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "tokenId": 133850n,
                  "transaction": "0xa1a917ccc6cf841aa416551270e1318023f04fcf605374c61b20c436b581e18b",
                },
              ],
            },
            "block": 24240005,
            "chainId": 1,
            "eventsProcessed": 12,
          },
        ],
      }
    `);
  });

  it("Writes day and hour interval snapshots for a swap", async (t) => {
    const indexer = createTestIndexer();

    // Block 24240015 carries a Swap on an ETH-paired v4 pool; the surrounding
    // range also initialises the pool, so every interval entity is exercised.
    await indexer.process({
      chains: {
        1: { startBlock: 24240011, endBlock: 24240020 },
      },
    });

    const poolDayData = await indexer.PoolDayData.getAll();
    const poolHourData = await indexer.PoolHourData.getAll();
    const tokenDayData = await indexer.TokenDayData.getAll();
    const tokenHourData = await indexer.TokenHourData.getAll();
    const uniswapDayData = await indexer.UniswapDayData.getAll();

    // One pool touched -> one row per pool period; two tokens -> two rows each.
    t.expect([
      poolDayData.length,
      poolHourData.length,
      tokenDayData.length,
      tokenHourData.length,
      uniswapDayData.length,
    ]).toEqual([1, 1, 2, 2, 1]);

    const day = poolDayData[0]!;
    const hour = poolHourData[0]!;

    // Period keys: the bucket index is derived from the block timestamp and the
    // start-of-period column must be that index multiplied back out.
    const DAY_INDEX = 20468;
    const HOUR_INDEX = 491244;
    t.expect(day.date).toBe(DAY_INDEX * 86400);
    t.expect(hour.periodStartUnix).toBe(HOUR_INDEX * 3600);

    // Ids are the already-chain-namespaced parent id plus the period index, so
    // rows cannot collide across chains (config.yaml sets no
    // disable_default_cross_chain).
    t.expect(day.id).toBe(`${day.pool_id}_${DAY_INDEX}`);
    t.expect(hour.id).toBe(`${hour.pool_id}_${HOUR_INDEX}`);
    t.expect(day.pool_id.startsWith("1_")).toBe(true);
    t.expect(uniswapDayData[0]!.id).toBe(`1_${DAY_INDEX}`);
    for (const row of tokenDayData) {
      t.expect(row.id).toBe(`${row.token_id}_${DAY_INDEX}`);
    }
    for (const row of tokenHourData) {
      t.expect(row.id).toBe(`${row.token_id}_${HOUR_INDEX}`);
    }

    // OHLC: open is the price at bucket creation, close the latest, and the
    // band must contain both.
    t.expect(day.high.gte(day.open)).toBe(true);
    t.expect(day.high.gte(day.close)).toBe(true);
    t.expect(day.low.lte(day.open)).toBe(true);
    t.expect(day.low.lte(day.close)).toBe(true);
    t.expect(day.close.toString()).toBe(hour.close.toString());

    // txCount accumulates across every event in the bucket; volume accumulates
    // from the swap only.
    t.expect(day.txCount).toBeGreaterThan(0n);
    t.expect(day.txCount).toBe(hour.txCount);
    t.expect(day.volumeToken0.gt(0)).toBe(true);
    t.expect(day.volumeToken1.gt(0)).toBe(true);

    // Snapshot columns mirror the post-event pool state rather than accumulating.
    t.expect(day.tick).toBe(hour.tick);
    t.expect(day.liquidity).toBe(hour.liquidity);
    t.expect(day.sqrtPrice).toBe(hour.sqrtPrice);
  });
});
