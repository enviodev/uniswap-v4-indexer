/**
 * E2E Integration test for Uniswap V4 Indexer
 *
 * Tests all event handlers (Initialize, Swap, ModifyLiquidity) using real blockchain data
 * from the new HyperIndex v3 testing framework.
 */

import { describe, it, expect } from "vitest";
import { createTestIndexer } from "generated";

describe("Uniswap V4 Indexer", () => {
  it("Create Ticks even if we don't know about the pool", async () => {
    const indexer = createTestIndexer();

    expect(
      await indexer.process({
        chains: {
          1: {
            startBlock: 24240005,
            endBlock: 24240005,
          },
        },
      }),
      "Should create Ticks even if we don't know about the pool. No other changes"
    ).toMatchInlineSnapshot(`
      {
        "changes": [
          {
            "Tick": {
              "sets": [
                {
                  "chainId": 1n,
                  "createdAtBlockNumber": 24240005n,
                  "createdAtTimestamp": 1768478831n,
                  "id": "1_0x63bb22f47c7ede6578a25c873e77eb782ec8e4c19778e36ce64d37877b5bd1e7#-276328",
                  "liquidityGross": 116624695255452675093n,
                  "liquidityNet": 116624695255452675093n,
                  "pool_id": "1_0x63bb22f47c7ede6578a25c873e77eb782ec8e4c19778e36ce64d37877b5bd1e7",
                  "price0": "0.999200359880032992",
                  "price1": "1.000800280056007001",
                  "tickIdx": -276328n,
                },
                {
                  "chainId": 1n,
                  "createdAtBlockNumber": 24240005n,
                  "createdAtTimestamp": 1768478831n,
                  "id": "1_0x63bb22f47c7ede6578a25c873e77eb782ec8e4c19778e36ce64d37877b5bd1e7#-276319",
                  "liquidityGross": 116624695255452675093n,
                  "liquidityNet": -116624695255452675093n,
                  "pool_id": "1_0x63bb22f47c7ede6578a25c873e77eb782ec8e4c19778e36ce64d37877b5bd1e7",
                  "price0": "0.9999000099990001",
                  "price1": "1.0001",
                  "tickIdx": -276319n,
                },
                {
                  "chainId": 1n,
                  "createdAtBlockNumber": 24240005n,
                  "createdAtTimestamp": 1768478831n,
                  "id": "1_0x0d895a18090366bd7c47cb27a0dda14770721847e89935d6675dfcf085e016b7#123200",
                  "liquidityGross": 0n,
                  "liquidityNet": 0n,
                  "pool_id": "1_0x0d895a18090366bd7c47cb27a0dda14770721847e89935d6675dfcf085e016b7",
                  "price0": "1.00642020172761392",
                  "price1": "0.993620754316543879",
                  "tickIdx": 123200n,
                },
                {
                  "chainId": 1n,
                  "createdAtBlockNumber": 24240005n,
                  "createdAtTimestamp": 1768478831n,
                  "id": "1_0x0d895a18090366bd7c47cb27a0dda14770721847e89935d6675dfcf085e016b7#123800",
                  "liquidityGross": 0n,
                  "liquidityNet": 0n,
                  "pool_id": "1_0x0d895a18090366bd7c47cb27a0dda14770721847e89935d6675dfcf085e016b7",
                  "price0": "1.000800280056007001",
                  "price1": "0.999200359880032992",
                  "tickIdx": 123800n,
                },
              ],
            },
            "block": 24240005,
            "blockHash": "0xb4509edf1b6cc82e986fc20a352538ad363908f9a9e861f357862508407bbed1",
            "chainId": 1,
            "eventsProcessed": 10,
          },
        ],
      }
    `);
  });
});
