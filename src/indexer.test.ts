/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/testing/SKILL.md for conventions.
 */

import { describe, it } from "vitest";
import { createTestIndexer } from "generated";

describe("Uniswap V4 Indexer", () => {
  it("Does not create Ticks for ModifyLiquidity on unknown pools", async (t) => {
    const indexer = createTestIndexer();

    t.expect(
      await indexer.process({
        chains: {
          1: { startBlock: 24240005, endBlock: 24240005 },
        },
      }),
      "ModifyLiquidity events whose pool is unknown (no prior Initialize) should be processed without writing Tick entities."
    ).toMatchInlineSnapshot(`
      {
        "changes": [
          {
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
