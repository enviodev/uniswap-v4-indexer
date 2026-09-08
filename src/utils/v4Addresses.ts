/*
 * StateView and PositionManager addresses, per chain.
 *
 * Copied verbatim from the Ponder indexer's `networks.json`
 * (`chains.<name>.protocols.v4.addresses`), which is the tested source — every
 * one of these has been serving live fee reads on that indexer.
 *
 * WHY THESE TWO CONTRACTS
 *
 * `StateView` is v4's read-only companion to PoolManager, and the only way to
 * ask for `feeGrowthInside` and a position's stored fee-growth baseline.
 *
 * `PositionManager` is the OWNER argument to `getPositionInfo`, not the end
 * user: in v4 the PositionManager holds the pool position on the NFT holder's
 * behalf, and the NFT tokenId is the `salt`. Passing the wallet address instead
 * returns an empty position, which reads as zero fees rather than an error —
 * the kind of mistake that produces plausible wrong numbers.
 *
 * A chain absent here cannot have its fees swept. That is deliberate and it
 * fails loudly at the call site rather than silently reading address zero.
 */

/**
 * Multicall3, at the address it is deployed to on every chain that matters here.
 *
 * This is a CONSTANT rather than a viem chain lookup on purpose. viem 2.21.0 (the
 * pinned version) ships no chain definition for several chains this indexer
 * configures — 4663 (Robinhood) among them — so resolving multicall3 through
 * `client.chain` would fix most chains and silently leave those throwing. The
 * deployment is deterministic-address, so the constant is correct wherever
 * Multicall3 exists at all, and a chain that deviates can override it in the
 * table below alongside its other addresses.
 */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export interface V4Addresses {
  readonly stateView: string;
  readonly positionManager: string;
  /**
   * Multicall3 for this chain. Defaults to the canonical address; present as a
   * field so a chain that deployed it elsewhere is a one-line table edit rather
   * than a special case at the call site.
   */
  readonly multicall3: string;
}

const V4_ADDRESSES: Readonly<Record<number, V4Addresses>> = {
  // mainnet
  1: {
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    multicall3: MULTICALL3,
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
  },
  // optimism
  10: {
    stateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
    multicall3: MULTICALL3,
    positionManager: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017",
  },
  // arbitrum one
  42161: {
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    multicall3: MULTICALL3,
    positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
  },
  // avalanche
  43114: {
    stateView: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
    multicall3: MULTICALL3,
    positionManager: "0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd",
  },
  // robinhood chain
  4663: {
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    multicall3: MULTICALL3,
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  },
};

/**
 * Addresses for a chain, or `undefined` when the fee sweep is not configured
 * for it.
 *
 * Envio's `config.yaml` covers considerably more chains than Ponder's
 * `networks.json` does, so most chains legitimately have no entry — the sweep
 * skips them rather than guessing.
 */
export function v4AddressesFor(chainId: number): V4Addresses | undefined {
  return V4_ADDRESSES[chainId];
}

/** Chains the fee sweep can run on. */
export function feeSweepChainIds(): number[] {
  return Object.keys(V4_ADDRESSES).map(Number);
}

/**
 * The canonical PositionManager per chain, lowercased — the ONLY caller of
 * `PoolManager.modifyLiquidity` whose `salt` is an NFT tokenId.
 *
 * WHY THIS IS A SEPARATE TABLE FROM `V4_ADDRESSES`
 *
 * `v4AddressesFor` gates the fee sweep (`feeSync-block.ts:97`), so a chain only
 * belongs there once its `stateView` is known. Position ATTRIBUTION needs
 * nothing but the PositionManager, and it must work on every chain `config.yaml`
 * indexes — otherwise turning on a chain silently produces no positions. Two
 * tables, two questions.
 *
 * SOURCE, AND THE ONE MAINTENANCE RULE
 *
 * Every value below is the `PositionManager` address of the same chain's block
 * in `config.yaml`, lowercased — the same address the indexer subscribes to for
 * `Transfer`, i.e. already this repo's definition of "the PositionManager" on
 * that chain. Keeping them equal is what guarantees that every NFT whose
 * ownership is tracked also has its liquidity attributed. THEY ARE TWO COPIES:
 * adding or changing a chain in `config.yaml` must change this table in the same
 * edit. The five chains that also appear in `V4_ADDRESSES` agree with it.
 */
const POSITION_MANAGERS: Readonly<Record<number, string>> = {
  1: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", // ethereum
  10: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017", // optimism
  56: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b", // bnb chain
  130: "0x4529a01c7a0410167c5740c487a8de60232617bf", // unichain
  137: "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9", // polygon
  143: "0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016", // monad
  480: "0xc585e0f504613b5fbf874f21af14c65260fb41fa", // world chain
  1868: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566", // soneium
  4326: "0x9ae0921e981aaa7308f176f8d4f9129b9247c89d", // (config.yaml labels this one "?")
  4663: "0x58daec3116aae6d93017baaea7749052e8a04fa7", // robinhood chain
  7777777: "0xf66c7b99e2040f0d9b326b3b7c152e9663543d63", // zora
  8453: "0x7c5f5a4bbd8fd63184577525326123b519429bdc", // base
  42161: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869", // arbitrum one
  42220: "0xf7965f3981e4d5bc383bfbcb61501763e9068ca9", // celo
  43114: "0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd", // avalanche
  57073: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566", // ink
  59144: "0xddcad5775b2816a87495f207731b3571d7ee3c76", // linea
  81457: "0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad", // blast
};

/**
 * The PositionManager for a chain (lowercase), or `undefined` when this chain
 * has no entry — in which case NO ModifyLiquidity on it can be attributed to an
 * NFT position, because there is nothing to check `sender` against.
 */
export function positionManagerFor(chainId: number): string | undefined {
  return POSITION_MANAGERS[chainId];
}
