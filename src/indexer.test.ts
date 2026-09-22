/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/testing/SKILL.md for conventions.
 */

import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

describe("Uniswap V4 Indexer", () => {
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
                  "createdAtTimestamp": 1768478831n,
                  "id": "1_133850",
                  "origin": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "owner": "0x16a4eC779ec71F9019fF79CbdD082a078C9eA06A",
                  "tokenId": 133850n,
                },
              ],
            },
            "Transfer": {
              "sets": [
                {
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
            "eventsProcessed": 11,
          },
        ],
      }
    `);
  });
  it("Keeps the pricing whitelist off Token", async (t) => {
    // Block 21688545 initializes the first mainnet pool, ETH/USDC. Both sides
    // are whitelist tokens, so each gains the pool as a pricing route. The
    // route must land in TokenWhitelistPools, never on Token (see schema).
    const indexer = createTestIndexer();
    const result = await indexer.process({
      chains: { 1: { startBlock: 21688545, endBlock: 21688545 } },
    });
    const change = result.changes[0]!;
    const pool =
      "1_0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27";

    t.expect(change.TokenWhitelistPools?.sets).toHaveLength(2);
    t.expect(change.TokenWhitelistPools?.sets).toEqual(
      t.expect.arrayContaining([
        { id: "1_0x0000000000000000000000000000000000000000", pools: [pool] },
        { id: "1_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", pools: [pool] },
      ])
    );
    t.expect(change.Token?.sets).toHaveLength(2);
    for (const token of change.Token?.sets ?? []) {
      t.expect(token).not.toHaveProperty("whitelistPools");
    }
  });
});
