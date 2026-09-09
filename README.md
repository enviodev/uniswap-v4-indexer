# Uniswap V4 Indexer

[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-7289da?logo=discord&logoColor=white)](https://discord.com/invite/envio)

A public, open-source multichain Uniswap V4 indexer built with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview). Powers [v4.xyz](https://v4.xyz), the hub for Uniswap V4 data and hooks analytics.

Open to contributions.


![v4.xyz Dashboard](./v4.gif)

## What This Indexes

This indexer tracks all key events from Uniswap V4 `PoolManager` and `PositionManager` contracts across multiple chains:

**Events indexed:**
- `Initialize` - pool creation with fee, tick spacing, and hooks
- `Swap` - all swaps with amounts, price, liquidity, and transaction details
- `ModifyLiquidity` - liquidity additions and removals
- `Donate` - donations to pools
- `Transfer` / `Approval` - ERC-6909 token transfers and approvals

**Chains:**
Ethereum, Optimism, Base, Arbitrum, Polygon, Blast, Zora, Avalanche, BNB Chain, Unichain, World Chain, Soneium, Ink, Linea, Celo

## What's Indexed

The GraphQL API exposes pool statistics, swap history, liquidity positions, and ERC-6909 token data across all supported chains. You can use this to power analytics dashboards, trading interfaces, liquidity trackers, hook monitors, and cross-chain Uniswap V4 data aggregations.


## Prerequisites

- [Node.js](https://nodejs.org/en/download/current) v24 or newer
- [pnpm](https://pnpm.io/installation) v8 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick Start


```bash
# Install dependencies
pnpm i

# Run locally (starts indexer + GraphQL API at http://localhost:8080)
pnpm envio dev
```

The Hasura console is available at [http://localhost:8080](http://localhost:8080) where you can explore and query indexed data using GraphQL.

## Serving the subgraph dialect (`src/graph-api/`)

This indexer answers **The Graph's query dialect** directly, so a consumer
written against a Uniswap v4 subgraph can point at it without changing a single
query — useful on chains where The Graph publishes no subgraph service at all.

The server runs **inside the indexer process**. envio auto-imports every
`src/handlers/**/*.ts` (`HandlerLoader.res.mjs:41`), so `src/handlers/graph-api.ts`
starts an HTTP server on import and reads Postgres directly. No Hasura, no
sidecar, no second process.

```bash
ENVIO_HASURA=false GRAPH_API_CHAIN_ID=1 pnpm dev
```

`pnpm dev` wraps `envio dev` via `scripts/dev.mjs`, which derives
`ENVIO_PG_SCHEMA` and `ENVIO_CLICKHOUSE_DATABASE` from the config filename. There
is now only `config.yaml`, so that resolves to envio's `public` default; the
derivation remains for a one-off `config.<slug>.yaml`, which would get the
`<slug>` schema. Setting either variable explicitly overrides it; `pnpm dev:raw`
bypasses the wrapper entirely.

| Env | Default | Meaning |
|---|---|---|
| `GRAPH_API_CHAIN_ID` | *unset* | The one chain to serve. **Unset = server does not start.** |
| `GRAPH_API_PORT` | `4350` | |
| `GRAPH_API_PG_MAX` | `4` | Its own pool, separate from the indexer's writer pool |

Connection settings come from envio's own `ENVIO_PG_*` variables, so it reads
the same database the indexer writes. `GET /health` returns liveness; queries are
`POST /`, like any subgraph endpoint.

### ClickHouse

Storage is Postgres only. ClickHouse was removed because nothing in this repo
reads it — the Graph-dialect API goes straight to Postgres — and because Envio
Cloud rejects `storage.clickhouse` unless the indexer is entitled for it,
reporting "ClickHouse mismatch" on every commit and blocking the deploy. That is
not a plan-tier limit: it was still rejected on Production Small.

`storage:` in the config and the `@storage` directives in `schema.graphql` must
agree, or envio refuses to start — so both were changed together.

`pnpm clickhouse:allow-host` and the auto-heal in `scripts/dev.mjs` are kept but
now inert: the heal is gated on the active config actually enabling ClickHouse.
They exist for anyone who re-enables it, since the local container restricts
`default` to localhost and envio connects from the host.

### When it does and does not start

`src/handlers/graph-api.ts` is the only file under `src/handlers/` that is not an
event handler, and it binds a port only when there is a live persistence layer:

| Context | Loads handlers? | Starts server? |
|---|---|---|
| `envio dev` / `envio start` | yes — `Main.res.mjs:494` | **yes** (`:492` sets `EnvioGlobal.value.persistence` first) |
| `createTestIndexer` | yes — `TestIndexer.res.mjs:420` | no — never touches `EnvioGlobal` |
| `envio codegen` | no | n/a |

A failure to start is logged and swallowed: the indexer keeps indexing. That
matters because HandlerLoader aborts startup if any handler import rejects.

### Translation

Root fields, filter suffixes, ordering and pagination are mapped to SQL;
`src/graph-api/schema-map.ts` is the single source of truth. Envio's `<chainId>_`
id prefix is stripped on the way out and restored on the way in, so callers only
ever see bare subgraph ids. The transform preserves relative byte ordering, which
a cursor walk on `orderBy: id` + `id_gt` depends on to terminate.

`Pool.token0`/`token1` are plain `String` columns here rather than relations, so a
nested `token0 { symbol decimals }` is resolved by one batched `Token` lookup and
stitched.

`Token.decimalsResolved` is deliberately NOT in `ENTITIES` — this layer answers in
the vanilla subgraph's dialect and the vanilla schema has no such field, so no
caller speaking it can ask. Exposing it means two edits, not one: the field spec
in `schema-map.ts` AND the hard-coded column list in `db.loadTokens`, which backs
the stitch above and would otherwise return the field as null on any
`pool { token0 { … } }` selection. Read it from the Envio/Hasura surface, where
the schema generates it.

Nested `@derivedFrom` lists (`poolDayData(first: 7)`) become **one windowed
follow-up query** for the whole page rather than a LATERAL per row. envio does not
create the declared `@index` directives until `finalizeBackfill`, so during a
backfill every strategy is a sequential scan — one scan for the page beats one per
parent. Measured on a 100-pool page mid-backfill: **59 ms**, against ~1.9 s for the
LATERAL form.

`_meta` is synthesized: `block.number` from `progressBlock`, and `block.timestamp`
from the newest indexed event, because envio's `_meta` view has no block-timestamp
column at all. For a cursor ceiling that is strictly safer than a true block
timestamp — it can never advance past data the indexer holds.

### Error policy

A failed request never returns a well-formed empty `data` — that is
indistinguishable from a healthy end-of-walk, and would let an outage look like a
completed sync. Unsupported constructs return `200` with `errors[]` and no `data`;
database failures return `502`. Proxy-generated messages are asserted never to
match a consumer's transient-gateway retry heuristic, so a permanent bug fails
fast instead of being retried.

### Limits

- No time-travel (`block: { number: }`) — entity history is not exposed.
- Only the root fields in `ROOT_FIELDS`. Anything else is a loud error.
- Reference fields support `{ id }` only; other subfields are rejected rather
  than silently dropped.

## Regenerate Files

If you modify `config.yaml` or `schema.graphql`:

```bash
pnpm codegen
```

## RPC Configuration

RPC endpoints for each chain can be customized via environment variables prefixed with `ENVIO_`. See `.env.example` for the full list:

```bash
ENVIO_MAINNET_RPC_URL=https://your-mainnet-node
ENVIO_ARBITRUM_RPC_URL=https://your-arbitrum-node
```

## Querying the Data

Once running, query the GraphQL API to explore pool and swap data:

```graphql
{
  Pool(limit: 10, order_by: {volumeUSD: desc}) {
    id
    token0 { symbol }
    token1 { symbol }
    volumeUSD
    totalValueLockedUSD
  }
}
```

## Built With

- [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) - multichain indexing framework
- [HyperSync](https://docs.envio.dev/docs/HyperSync/overview) - high-performance blockchain data retrieval
- Based on the [Uniswap V4 Subgraph](https://github.com/Uniswap/v4-subgraph) schema (pricing and core entity logic)

## Documentation

- [HyperIndex Docs](https://docs.envio.dev/docs/HyperIndex/overview)
- [Uniswap V4 Multichain Indexer Reference](https://docs.envio.dev/docs/HyperIndex/example-uniswap-v4-multi-chain-indexer)
- [Uniswap V4 Docs](https://docs.uniswap.org/contracts/v4/overview)

## Contributing

This indexer is open to contributions. Open an issue or pull request on [GitHub](https://github.com/enviodev/uniswap-v4-indexer).

## Support

- [Discord community](https://discord.com/invite/envio)
- [Envio Docs](https://docs.envio.dev)

## Position indexing (ported from the Ponder indexer)

This fork now carries the Uniswap v4 **position** surface that previously lived only in
`copypools-subgraph/ponder`. The port is mechanism-for-mechanism deliberate: that logic is already
tested against live data on four chains, so the arithmetic, the guards and the RPC strategy are
unchanged and only the runtime differs.

| Concern | Where | Cost |
| --- | --- | --- |
| Position identity, ticks, liquidity, cashflows | `src/handlers/modifyLiquidity-handler.ts` | zero RPC |
| Current pooled `amount0`/`amount1` | `src/utils/positions.ts` | zero RPC |
| DEPOSIT / WITHDRAW transaction rows | `src/handlers/modifyLiquidity-handler.ts` | zero RPC |
| Uncollected fees | `src/handlers/feeSync-block.ts` + `src/effects/positionState.ts` | one multicall per 400-position chunk, HEAD ONLY |
| Collected fees + COLLECT_FEES rows | `src/effects/feesAccrued.ts` | one `debug_traceTransaction` per SETTLING tx |
| Serving the backend | the backend's own converter (`backend/src/subgraph/hyperindex/`) | — |

### Three things that are load-bearing

**`ModifyLiquidity.salt` IS the NFT tokenId.** Without reading it the event is position-blind and
none of this can exist. The field was always delivered and never read.

**`amount0`/`amount1` need no `eth_call`.** They are pure math over
`(ticks, pool.tick, liquidity, pool.sqrtPrice)`, and the tick comes from `Initialize`/`Swap` — in
v4 only a swap moves it, so the event-tracked value equals on-chain slot0. Ponder spends a
`getSlot0` per refresh cycle on this. It also means the in-range set is known for free, so the fee
sweep reads only positions that can actually have accrued.

**`updatedAtBlock` and `feesUpdatedAtBlock` are separate on purpose.** Ponder has one column for
both, and because the backend watches it as a change feed, every fee sweep there presents the whole
active set as changed and triggers thousands of pointless refreshes. The fee sweep here writes only
the fee watermark.

### Choosing which chains run

**One `config.yaml`, chains as commentable blocks.** Every uncommented entry under `chains:` is
indexed, and envio runs them all in parallel in one process, so enabling a chain is uncommenting
its block and disabling one is commenting it out again. All 18 are present with their addresses
and, where known, their real v4 PoolManager deploy block from the Ponder indexer's
`networks.json`. Which ones are live is whatever the file currently has uncommented — read it
rather than a list here, since any list here goes stale the first time someone enables a chain.

The key is `chains:`, not `networks:` — envio v3 renamed it, and code that reads the file has to
match. `activeChainIds` in `src/utils/chains.ts` looked for `networks:` at first and silently
returned an empty set, which disabled the startup floor described below on every chain.

This replaces the previous `config.ethereum.yaml` / `config.robinhood.yaml` files, which existed
only to run one chain at a time and whose filenames drove a separate Postgres schema. One config
means one dataset, which is what you want when the point is to serve several chains from one
endpoint.

Two things to know before editing it:

- **`start_block: 0` on a chain with a real deploy block costs a full pre-contract scan** — on a
  fast chain that is the difference between minutes and days. Blocks left at 0 are marked as
  unverified in the file; set one before using that chain for anything past a smoke test.
- **Do not map over `EvmChainId`.** That type is GENERATED from the currently-active chains, so any
  `{ [chainId in EvmChainId]: ... }` map fails to compile the moment a chain is commented out.
  `src/utils/chains.ts` keys on `number` for exactly this reason.

After changing the file, run `pnpm codegen`.

### Reading positions from the backend

The backend does not need a new endpoint. `PonderCompatibleAdapter.positionSource` reads positions
from `integration.subgraphUrl` when that chain sets
`<CHAIN>_UNISWAP_V4_POSITIONS_FROM_SUBGRAPH=true` and has no `PONDER_URL`, translating through the
converter that already serves pools, tokens and the interval snapshots (`dialect: 'hyperindex'`
against the raw endpoint). See `backend/AGENTS.md` §8B — including the two fields that are named
differently here and are aliased back, and `Token.verified`, which this indexer deliberately does
not have.

### Four things the port got wrong, and what they cost

Recorded because each was a defect that produced a plausible number rather than an
error, and each is a shape worth recognising again.

**Deferring head-only work until the head, in two layers.** This is what keeps the sweep's RPC
from competing with the backfill for the node.

The first layer is a `_gte` floor: `headAtStartup` reads each active chain's head once at module
load and `where` passes it as `_gte` alongside `_every`, so Envio never *generates* a block item
below it. A fresh indexer starting at 56M with the chain at 94M is silent for the entire backfill
and starts firing exactly when indexing reaches the tip — not one no-op handler call per stride,
zero. It uses top-level await because `where` is synchronous and runs at registration; the fetch
is bounded by a timeout and degrades to no floor, so a sick RPC costs startup that timeout at
worst and can never hang or fail the indexer. Only chains `config.yaml` has UNCOMMENTED are asked
(`activeChainIds`), since the address table is a superset and the rest would hit public fallback
endpoints for chains this process never indexes.

The second layer is the runtime gate, for what a fixed floor cannot cover: a startup where the
head was unreadable, and an indexer that LOSES the head later. It **latches** — once a chain
reaches the tip it stays enabled through ordinary lag, and only disables again on a
backfill-sized regression (50 intervals). Without the latch a live indexer drifting a few hundred
blocks behind between firings would switch the sweep off and on repeatedly; with it, "after the
initial backfill, keep refreshing fees even if we lag a bit" is expressible, which a plain
distance test cannot say because it cannot tell "briefly behind" from "still backfilling".

Note what is NOT deferred, and why. Collected fees come from `debug_traceTransaction` and are a
HISTORICAL fact per transaction, so they must be computed during the backfill or lost — they are
what the trace-skip gate exists to make affordable. Only uncollected fees are current-state, and
only current-state work can be deferred to the head at all.

**The fee sweep ran across the whole backfill.** Ponder registers it as
`blocks: { FeeSync: { startBlock: "latest" } }` — head-only, never historical. Envio's
`indexer.onBlock` `where` predicate is evaluated once per chain at REGISTRATION time, so it
cannot express head-proximity, and an `_every` stride matches history exactly as it matches
the tip. On the two enabled chains that was ~14,100 firings on Ethereum and ~32,150 on
Avalanche, all of it producing values the next firing overwrote — uncollected fees are a
current-state quantity. A block handler also has no block timestamp (Envio builds its block
"from the handler's own block number, not from the stores"), so the gate asks the node for
the head instead: `src/utils/chainHead.ts`, TTL-cached, and failing CLOSED so an RPC outage
cannot start a full-history sweep.

**The fee-growth multicall could never succeed.** The client was built without a `chain`,
copying `tokenMetadata.ts`, and viem then throws `client chain not configured.
multicallAddress is required.` at the top of the multicall action — before any RPC. Every
uncollected-fee read returned the all-zero failure sentinel, so `totalFeesUncollected0/1`
was served as a measured zero for every in-range position on every chain. The fix passes
`multicallAddress` explicitly rather than a viem chain object, because viem ships no chain
definition for several chains this indexer configures (4663 among them) and resolving through
`client.chain` would have fixed most chains and left those silently throwing.

**Every ModifyLiquidity was traced.** Ponder gates the trace on a three-way AND —
`existing && prevLiquidity > 0n && feeGrowthChanged` — where the last conjunct compares the
pool's current `feeGrowthInside` against the baseline stored at the position's last settle.
Equal means no fee accrued, so `feesAccrued` is provably zero and the trace would learn
nothing. The port had this as an OR of two weaker conditions, which traced essentially
everything: one `debug_traceTransaction`, the most expensive call here, per event. It now
trades that for one cheap cached `getFeeGrowthInside`. Exactness is untouched — the skip only
ever fires on provably-zero cases, and an out-of-range position's fee growth still changes,
so it is still traced.

**Failures were cached, and failed reads never advanced the watermark.** A degraded trace
returned `[]` under `cache: true`, freezing "no collected fee for this transaction" into the
persisted cache permanently; the failure paths now opt out with `context.cache = false`, the
idiom already in `tokenMetadata.ts`. And the sweep's `continue` on a failed read skipped the
write that advances `feesUpdatedAtBlock`, so those rows stayed below the cutoff and were
re-selected on every firing forever — the stale set could only grow. Ponder's per-position
write is unconditional for this reason, and so is this one now.

**An effect that threw took down the whole indexer.** Envio 3.7.0 has no retry and no skip for an
exception out of a handler or an effect: `EventProcessing.res:65` wraps it as `ProcessingError`
and `BatchProcessing.res:156` hands that to `IndexerState.errorExit`. The trace effect rethrew
transient errors with the comment "let the runtime's own retry handle it" — there is no such
retry. Under `envio dev`, which restarts the process, one flaky RPC response became a
crash-restart loop that re-processed the same batch and died on the same transaction, which is why
Ethereum sat at zero events. Transient failures are now retried in the effect with backoff, and
exhaustion degrades to "no collected fee recorded" — Ponder's own tested trade ("Trading one
event's exact fee for liveness, per design call").

**The PositionManager sender filter was missing.** Ponder's first line is
`if (sender.toLowerCase() !== POSITION_MANAGER_ADDRESS) return;` (apps/v4/src/index.ts:165),
because `salt` is only an NFT tokenId when PositionManager is the caller — any contract may call
`modifyLiquidity` with an arbitrary salt. Positions are keyed `<chainId>_<tokenId>`, so a salt
equal to a live NFT id addresses THAT NFT's row, and small salts are both what a hook naturally
picks and what v4 issued first. Without the filter that is a corrupted real position, not just a
junk row. `POSITION_MANAGERS` covers all 18 chains `config.yaml` declares, and a test asserts the
two stay equal — a wrong address there means zero positions on that chain, silently.

**A transient `decimals()` failure cached a guessed 18 forever.** `getTokenMetadata` gated its
cache opt-out on a three-way AND — `nameFailed && symbolFailed && decimalsFailed` — so a blip on
`decimals()` alone, with name and symbol succeeding, WAS cached, with 18 substituted. The effect
cache is persisted and keyed on the input, so that 18 survived restarts and a full resync and
mis-scaled every amount for the token by 10^(18 - real): a factor of 10^12 for USDC. The
asymmetry the old gate missed is that a fallback name or symbol is cosmetic while a fallback
`decimals` silently rescales real money. `decimals` now opts out on its own; name/symbol keep the
looser rule deliberately, since a token may genuinely implement neither.

`decimalsResolved` is added alongside it, mirroring Ponder's `core/token-meta.ts` — and because it
is a REQUIRED output field, every row already cached without it fails `S.parseOrThrow` on load and
re-runs. That is what covers the git-tracked `.envio/cache/getTokenMetadata.tsv`, which is 86 MB
and would otherwise re-import the stale values on the next clean initialize. The refill is lazy,
so nothing needs rewriting, but that file is still dead weight in git history and worth pruning.

**`decimalsResolved` was computed and thrown away.** It lived only on the effect's output schema:
`schema.graphql` had no such field and `initialize-handler.ts` wrote `decimals` alone, so the live
API answered `field 'decimalsResolved' not found in type: 'Token'` and no consumer could tell a
guessed 18 from a real one. It is now `decimalsResolved: Boolean!` on `Token`, written at both
creation sites.

Two adjacent limitations are deliberately NOT fixed. Both were implemented and then removed,
so they are written down here to stop the next person re-attempting them.

- **The row is written once and never refreshed.** `initialize-handler.ts` creates a `Token` on
  the first Initialize naming it and only bumps `poolCount` afterwards, so a `decimals()` read
  that failed that one time pins the 18 fallback onto the entity for the rest of the run —
  `decimalsResolved: false` is how a consumer detects it. Upgrading the row in place on a later
  Initialize was built and reverted: it cannot repair the amounts already derived from the guess
  (`totalFeesCollected0` among them, via `convertTokenToDecimal` in `modifyLiquidity-handler.ts`),
  and because the upgrade lands whenever RPC health happens to allow it, two runs over the same
  block range produce different entity values at the same block — precisely what
  `scripts/diff-at-block.mjs` assumes cannot happen. The remedy is a resync once the RPC is
  healthy: `context.cache = false` keeps the unresolved read out of the effect cache, so the next
  run genuinely re-asks.
- **A permanent failure is still retried, on purpose.** v4 permits initializing a pool against an
  address with no code — `PoolManager.initialize` validates only tickSpacing bounds,
  `currency0 < currency1` and the hook address, never `extcodesize` — and caching that verdict
  was tried and rejected on two counts. First, `eth_getCode` with no block tag answers at
  `latest`, and a replica behind head or a load balancer routing to an unsynced node returns `0x`
  for a live contract WITHOUT throwing, so the probe cannot fail safe and the failure is
  correlated with the outage that triggered it. Second, "no code" is not a permanent fact.
  `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` is the motivating address and it is not junk: it is
  Circle's **EURC on Base, decimals 6**, used on Arbitrum by mistake, and on Arbitrum it is the
  nonce-1 CREATE address of an EOA whose Arbitrum nonce is still 0 — two ordinary transactions and
  real code lands there. This repo's own `.envio/cache/getTokenMetadata.tsv` already holds both
  rows side by side (`,42161]` → 18, `,8453]` → EURC 6). Caching the codeless verdict would make
  that 18 permanent against a real 6, mis-scaling every derived amount by `10^12`. The cost of not
  caching is one guaranteed-useless `eth_call` per run for ~14 of Arbitrum's 15,384 pools (0.09%),
  which is the cheaper side of the trade. Note the asymmetry if this is ever revisited: post-EIP-6780
  "has code" IS effectively monotone and safe to cache; "has no code" is not.

Measured state at the time of writing: 208/208 cached Avalanche tokens and 35/35 live `Token`
rows agree with the vanilla subgraph on `decimals`, with 48 distinct non-18 values resolved
correctly (USDC 6, WBTC.e 8, SOL 9, wSAC 7 among them) — so no poisoned row is currently being
served on that chain. The fix closes the latent path, it is not repairing observed damage.

Two more, found by reading Envio's own runtime rather than the handlers: **the sweep ran twice
per firing**, because `Block(...)` items get a preload pass (`EventProcessing.res`) — writes are
discarded there (`set` is `noopSet`), so nothing double-counted, but the uncached multicall was
issued, thrown away and issued again; and **the rate limits were global**, because `crossChain`
defaults to `true` and only `false` isolates "the cache and rate limiting" per chain, so two
chains backfilling in parallel contended for one 20/sec allowance despite having separate
endpoints and separate quotas.

**WITHDRAW rows carried the signed amount, not the magnitude.** Ponder writes
`toHuman(isAdd ? eventAmt0 : -eventAmt0, dec0)`, so a withdraw's row amounts are POSITIVE there;
this port passed through the event amounts, which are signed by `liquidityDelta` and negative on a
withdraw. Identical magnitudes, opposite sign, on 164 of 164 Avalanche rows. The backend serves
this column to the customer with the sign intact, so it would have flipped every withdraw amount
negative at cutover.

**Gas was charged for events that write no ledger row.** Ponder computes gas inside
`if (willWriteRow)`, where `willWriteRow = liquidityDelta !== 0n || settled0 > 0 || settled1 > 0`.
A zero-delta ModifyLiquidity that settles nothing — a collect on a position with nothing accrued —
gets no row and no gas there. This port charged it anyway, inflating `totalGasCostETH` by a whole
transaction's gas with no row to account for it: 4-31% over on 5 of 223 Avalanche positions, and
it broke the invariant that the aggregate equals the sum of the position's own rows.

**The sweep never wrote `liquidity` back.** Ponder writes the on-chain value every cycle
(apps/v4/src/index.ts:452-459) so a missed or out-of-order event heals instead of drifting
forever; the port used the on-chain value for the fee math and then discarded it. Now written,
along with `isActive` and the close/reopen handling — but only for IN-RANGE positions, because
those are the only ones this sweep reads. Ponder pays an RPC per active position to cover both;
that trade is deliberate and is stated at the write site rather than left implicit.

Smaller parity gaps closed at the same time: transaction gas is charged once per transaction
rather than to every position it touches; negative running liquidity is clamped and warned
rather than stored; `closedAtTimestamp` is stamped on the first close and preserved; the
degenerate-pool guard (`isDegenerate`) zeroes amounts and clears `isPriceable` instead of
publishing edge-of-domain artifacts; `feeGrowthInside0/1LastX128` are actually maintained;
`feesUpdatedAtTimestamp` is a real clock rather than a copy of its own previous value; the
stale-set query uses `_lte` so the real cadence matches the configured interval; and the
sweep sorts by watermark, since `getWhere` has no ordering and the documented
"oldest fee-read first" rotation was otherwise fiction.

### Validating against Ponder and the subgraph

Ponder is the tested reference, so the cutover gate is agreement with it, not passing tests.
Three scripts, with no overlap:

```bash
# Every position + transaction field, one chain, vs Ponder AND the subgraph.
node scripts/diff-positions.mjs --chain 43114

# Collected fees only — works where the other cannot, see below.
node scripts/diff-collected-fees.mjs --chain 1 --limit 400
node scripts/diff-collected-fees.mjs --mode totals --chain 1

# The DEPLOYED indexer vs the subgraph AT OUR OWN INDEXED BLOCK, and vs Ponder.
node scripts/diff-at-block.mjs                      # all three chains
node scripts/diff-at-block.mjs --chain 43114 --pools 60 --positions 120
```

`diff-positions.mjs` is the broad one: it pulls every `Position` and
`PositionTransaction` row for a chain and compares each field, classifying every
difference as EXACT, within-double-precision, not-comparable-by-sync-height, or a real
mismatch — plus position identity and unit-free pool counters against the subgraph.

`diff-collected-fees.mjs` stays separate because it reaches sources the other one cannot:
its `txns` mode walks a bounded block range instead of doing per-position lookups, which
is the only shape a mid-backfill Ponder can serve on a busy chain, and its `totals` mode
uses primary-key lookups, which work when nothing else does.

`diff-at-block.mjs` reads the HOSTED deployment rather than the local Postgres, and it is
the only one that pins the comparison to a block. The Graph supports time-travel queries
(`pools(block: { number: N })`), so the subgraph can be asked what it held at exactly the
block Envio has reached — cumulative state then has to be EQUAL, not merely lower, and a
difference is a defect rather than a height artifact. Ponder has no equivalent, so its
comparisons stay gated on its own `updatedAtBlock` being at or below that block. It covers
four dimensions: pool identity/price/cumulative units and position identity against the
subgraph, and collected fees, cashflows and the transaction ledger against Ponder.
Uncollected fees have no external reference — neither the subgraph nor Ponder holds them at
our block — so they are checked against our OWN data instead. The sweep is the only writer of
both `totalFeesUncollected*` and `feesUpdatedAtBlock`, so a readable non-zero uncollected figure
against a readable zero sweep block is a self-contradiction and FAILS. A value that will not
parse as a number is *not measured* (exit 2), not a disagreement — unless the contradiction is
already proven by the two legs that DO parse, in which case the unreadable third leg cannot
un-prove it and it still fails.

**`totalValueLockedToken0/1` are NOT COMPARED against the subgraph at all** — not tolerated, not
advisory, not compared. The deployed subgraph is pre-#20 (upstream `05558b0`, 2025-02-11) and
computes them through the old `getAmount0`/`getAmount1`; this fork is post-#20. The two sides are
not computing the same quantity, so there is nothing to compare. The error is bounded by RANGE
width, not tick width, so on tickSpacing-1 pools it reaches 100% and no percentage threshold
helps. Every run prints the skipped count twice — a `NOT COMPARED` line in the pool section and a
top-level `EXCLUDED: N field comparison(s) were NOT MADE` line directly above `RESULT`. **A pass
from this script says nothing whatsoever about TVL.** The exclusion is scoped to those two fields
only; `depositedToken0/1`, `withdrawnToken0/1` and the ledger's `amount0/amount1` also flow
through `getAmount0/1` but are compared against PONDER, which is not a pre-#20 deployment, so they
keep being asserted.

**Ledger block range.** The Envio `PositionTransaction` read is capped server-side at 1000 rows
regardless of the requested limit and is ordered `blockNumber desc`, so the lowest block in the
fetched window is a partial tie group. The script COMPLETES that block with a second query pinned
to it and merges by entity id, then joins over the full span. Excluding the block instead — the
first attempt — left the lost-fee gate blind at exactly one block and made a single-block chain
permanently inconclusive. If the pinned query returns at the cap, or returns fewer rows than the
window already holds at that block, completeness is unprovable and the ledger is recorded as not
compared. Ponder's `blockNumber_gte`/`_lte` bounds are sent as strings but were verified to
compare NUMERICALLY (`_gte: "9999999"` returns 8-digit blocks), so the range is sound.

**Exit codes.** `diff-collected-fees.mjs` and `diff-at-block.mjs` are three-state: **1 on a
measured disagreement, 2 when something was never measured** — a source unreachable, a chain
skipped, a requested `--chain` that produced no report, or a dimension whose join left zero
comparisons — and **0 when every dimension ran and every difference it measured either agrees or
is explained**. Silence must not read as success, so `diff-at-block.mjs` records each skip as a
structured `{ site, reason }` entry rather than as prose, and the summary prints one
`not compared: <site> — <reason>` line per skip above its `RESULT:` verdict.

Two things a `0` does not mean. Value comparisons use a **1e-12 relative** floor, forced by
Ponder typing `amount0`, `amount1`, `gasCostETH`, `totalFeesCollected*`, `deposited*`,
`withdrawn*` and `totalGasCostETH` as GraphQL `Float` — anything wider than ~15 significant digits
is rounded in transit and can never reach EXACT however correct it is. That floor is applied
uniformly, so it also touches the wide subgraph integers: a ~1e16-unit drift on a 29-digit
`sqrtPrice` is ~1e-13 relative and lands in TOL. Read TOL as "agrees to 12 significant digits",
not "identical". And row-set coverage is gated in ONE place only — the Ponder ledger, where both
directions fail: rows we hold that Ponder lacks, and rows Ponder holds inside our compared range
that we lack (a potentially lost fee). The subgraph comparisons are value checks over the
intersection.

**What a green run looks like today.** Chain 43114 passes. Chain 42161 still FAILS, and not on
TVL: `txCount` and `volumeToken0/1` disagree on ~108 of 200 pools (ours strictly higher, never
lower, up to 2.66%) plus one dynamic-fee pool's `feeTier` (we resolve 400, the subgraph keeps the
`0x800000` sentinel). Those are pre-existing, unexplained, and deliberately still failing. Chain 1
is usually inconclusive — the Graph gateway is frequently `Unavailable` for it, and Ponder mainnet
times out on the ledger for want of the SQL indexes in `sql/`. A full three-chain pass is not
currently achievable and the script should not be expected to produce one.

`diff-positions.mjs` does **not** yet have that third state end to end. It exits 2 on
pre-flight failures only (no Ponder endpoint for the chain, no local `envio-postgres`
container, nothing indexed yet); a subgraph or Ponder source that dies *mid-run* is logged
and skipped, and the run can still exit 0. Read its "not compared" lines before treating a
zero from it as a pass.

**It compares per-TRANSACTION collected fees, not position totals**, and that choice is what
makes it usable mid-backfill. `Position.totalFeesCollected0/1` are running sums over whatever
each indexer has processed, so a half-synced Envio legitimately reports less than a caught-up
Ponder and the comparison fails for a reason unrelated to correctness. A `COLLECT_FEES` row
records what one transaction settled — a fact about the chain that does not move as either
indexer advances — so matching on `(chainId, tokenId, txHash)` is valid today and tests exactly
the `debug_traceTransaction` path that has to be exact.

**The tolerance is not a fudge.** Ponder stores these as JS numbers (`toHuman(...)` returns a
double); Envio stores exact BigDecimals. Past ~15 significant digits Ponder's stored value is
lossy and Envio is the more accurate of the two, so a difference within double precision is
agreement. Exact-match counts are printed separately so that distinction stays visible.

**It walks a bounded block range rather than looking positions up individually.** Ponder builds
its declared indexes only after a backfill completes and drops them on every crash-recovery
start, so `position_transaction` on a mid-backfill deployment has nothing but a primary key.
Per-position lookups are then one full table scan each, and mainnet answers `canceling statement
due to statement timeout`. One range walk amortises a single scan across many pages. If a chain
still times out, that deployment needs
`copypools-subgraph/ponder/sql/2026-09-07-position-query-indexes.sql` — index 3 of 3 there is
exactly this query shape.

### What the first validation run found

Per-transaction mode, Avalanche: **34/34 rows agree, zero mismatches** (14 exact, 20 within double
precision).

Totals mode over 250 closed positions per chain: Avalanche **23/23 agree**. Mainnet **244/247
agree** — and the three that did not are Ponder being wrong, verified by tracing the
transactions directly and decoding `feesAccrued`:

| tokenId | Envio | Ponder | chain says |
| --- | --- | --- | --- |
| 926 | 333387.830400084026115227 | **0** | `333387830400084026115227` raw → Envio, exactly |
| 686 | 0.007791580127644008 | 0.00249974636142716 | two collects; Ponder has only the second |
| 706 | 0.000000164039415489 | **0** | `164039415489` raw → Envio, exactly |

The mechanism is Ponder's own classifier. `isTraceCapabilityError` matches
`msg.includes("tracer")`, and viem embeds the full request body — which always contains
`"tracer":"callTracer"` — in every error message. So in Ponder EVERY trace error, transient ones
included, is treated as a permanent capability gap and records ZERO collected fees; its comment
accepts the consequence ("we just under-count this one collect until a re-sync"). Dropping that
substring is this port's one deliberate divergence from the reference, and these three positions
are it paying off: 333,387 OSAK of real collected fees that Ponder lost.

That asymmetry is why the gate classifies `envio > ponder` as **Ponder LOW** and reports it
separately, while `envio < ponder` always fails. Ponder's defect can only make it record less
than the chain says, never more.

### Requirements the fee paths add

`src/effects/feesAccrued.ts` needs an **archive node with the `debug` namespace** on every chain
you want exact collected fees for; there is no event-only alternative, because `feesAccrued` is a
return value of `PoolManager.modifyLiquidity` and v4 has no Collect event. A chain whose RPC lacks
it degrades to zero collected fees with a warning rather than halting. Endpoints resolve through
`src/utils/rpc.ts`; contract addresses live in `src/utils/v4Addresses.ts`.
