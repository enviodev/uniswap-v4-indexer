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
ENVIO_HASURA=false GRAPH_API_CHAIN_ID=1 pnpm dev --config config.ethereum.yaml
```

`pnpm dev` wraps `envio dev` via `scripts/dev.mjs`, which derives
`ENVIO_PG_SCHEMA` and `ENVIO_CLICKHOUSE_DATABASE` from the config filename —
`config.ethereum.yaml` gets the `ethereum` schema, plain `config.yaml` keeps
envio's `public` default. A single-chain config is a different dataset with a
different `name:`, so sharing storage with the multi-chain one trips envio's
incompatible-config guard. Setting either variable explicitly overrides the
derivation; `pnpm dev:raw` bypasses the wrapper entirely.

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
