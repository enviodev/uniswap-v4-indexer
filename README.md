# Uniswap v4 Indexer

A public Uniswap v4 indexer built with [Envio](https://envio.dev) that can be used by any developer to power their infrastructure.

_Please refer to the [documentation website](https://docs.envio.dev) for a thorough guide on all [Envio](https://envio.dev) indexer features_

Please note this Indexer is being bootstrapped as a multichain indexer based off this Uniswap V4 Indexer: https://github.com/Uniswap/v4-subgraph
Pricing (especially!!) and many other features are thanks to the team who built the above mentioned Indexer.

**Note:** This indexer currently powers [v4.xyz](https://v4.xyz), the hub for Uniswap data and hooks.

![v4.xyz Dashboard](./v4.gif)

## Overview

This indexer is currently a WIP that tracks key metrics and events from Uniswap v4 pools and can be used to:

- Track pool statistics (volume, TVL, fees, etc.)
- Monitor swaps and liquidity changes
- Power analytics dashboards and trading interfaces
- Build custom notifications and alerts

We are also in the process of including Hook features.

## Getting Started

### Prerequisites

Before running the indexer, ensure you have the following installed:

- Node.js (v24 or newer is recommended)
- pnpm (v8 or newer)
- Docker Desktop

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   pnpm i
   ```

### Running the Indexer

Start the indexer with:

```
pnpm envio dev
```

This command will:

- Start all required services using Docker
- Initialize and run the indexer

### Accessing Data

Once the indexer is running, you can view and query all indexed data at:

```
http://localhost:8080
```

This will open the Hasura console where you can explore and query the indexed data using GraphQL.

### RPC Configuration

RPC endpoints for each chain can be customized through environment variables prefixed with `ENVIO_`.
For example:

```
ENVIO_MAINNET_RPC_URL=https://your-mainnet-node
ENVIO_ARBITRUM_RPC_URL=https://your-arbitrum-node
```

See `.env.example` for the complete list of variables you can set.

## Usage

You can use this indexer to power your own Uniswap v4 applications and infrastructure. The indexed data is accessible via GraphQL API.

## Contributing

Contributions are welcome! Feel free to:

- Open issues for bugs or feature requests
- Submit pull requests to improve the indexer
- Add documentation or examples
- Share your use cases and feedback
