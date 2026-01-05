import { BigDecimal, type EvmChainId } from "generated";

// Chain IDs
export enum ChainId {
  MAINNET = 1,
  ARBITRUM_ONE = 42161,
  OPTIMISM = 10,
  BASE = 8453,
  MATIC = 137,
  BSC = 56,
  AVALANCHE = 43114,
  BLAST = 81457,
  ZORA = 7777777,
  WORLD = 480,
  UNICHAIN = 130,
  SONEIUM = 1868,
  MONAD = 143,
}

// Native token details interface
export interface NativeTokenDetails {
  symbol: string;
  name: string;
  decimals: bigint;
}

// Configuration interface for each chain
export interface ChainConfig {
  poolManagerAddress: string;
  stablecoinWrappedNativePoolId: string;
  stablecoinIsToken0: boolean;
  wrappedNativeAddress: string;
  minimumNativeLocked: BigDecimal;
  stablecoinAddresses: string[];
  whitelistTokens: string[];
  tokenOverrides: StaticTokenDefinition[];
  poolsToSkip: string[];
  nativeTokenDetails: NativeTokenDetails;
}

// Static token definition interface
export interface StaticTokenDefinition {
  address: string;
  symbol: string;
  name: string;
  decimals: bigint;
}

// Chain-specific configurations
// Note: All token and pool addresses should be lowercase

export const CHAIN_CONFIGS: { [chainId in EvmChainId]: ChainConfig } = {
  [ChainId.MAINNET]: {
    poolManagerAddress: "0x000000000004444c5dc75cb358380d2e3de08a90",
    stablecoinWrappedNativePoolId:
      "0x4f88f7c99022eace4740c6898f59ce6a2e798a1e64ce54589720b7153eb224a7",
    stablecoinIsToken0: true,
    wrappedNativeAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      "0x0000000000085d4780b73119b644ae5ecd22b376", // TUSD
      "0x956f47f50a910163d8bf957cf5846d573e7f87ca", // FEI
    ],
    whitelistTokens: [
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
      "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
      "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
      "0x0000000000000000000000000000000000000000", // Native ETH
      // Add other mainnet whitelisted tokens as needed
    ],
    tokenOverrides: [
      {
        address: "0xe0b7927c4af23765cb51314a0e0521a9645f0e2a",
        symbol: "DGD",
        name: "DGD",
        decimals: BigInt(9),
      },
    ],
    poolsToSkip: [
      "0xdfd5c2e5eca762ad4839fe581de3afa0788a220220cf8741c845e2fc099a5996", // ETH/CLUSSY way inflated values
    ],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.ARBITRUM_ONE]: {
    poolManagerAddress: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    stablecoinWrappedNativePoolId:
      "0xfc7b3ad139daaf1e9c3637ed921c154d1b04286f8a82b805a6c352da57028653",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
    ],
    whitelistTokens: [
      "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.OPTIMISM]: {
    poolManagerAddress: "0x9a13f98cb987694c9f086b1f5eb990eea8264ec3",
    stablecoinWrappedNativePoolId:
      "0xedba0a2a9dc73acf4b130e07605cb4c212bbd98a31c9cd442cfb8cf5b4e093e7",
    stablecoinIsToken0: true,
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // USDC.e
      "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607", // USDC.e
      "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT
      "0x4200000000000000000000000000000042000000", // OP
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.BASE]: {
    poolManagerAddress: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    stablecoinWrappedNativePoolId:
      "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.MATIC]: {
    poolManagerAddress: "0x67366782805870060151383f4bbff9dab53e5cd6",
    stablecoinWrappedNativePoolId:
      "0x15484bc239f7554e7ead77c45834c722d3f74a9b20826fdf21bbb1b026444286",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
    minimumNativeLocked: new BigDecimal("20000"),
    stablecoinAddresses: [
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC.e
      "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
    ],
    whitelistTokens: [
      "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
      "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC.e
      "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC
      "0x0000000000000000000000000000000000000000", // Native MATIC
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "MATIC",
      name: "Polygon",
      decimals: BigInt(18),
    },
  },
  [ChainId.BSC]: {
    poolManagerAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    stablecoinWrappedNativePoolId:
      "0x4c9dff5169d88f7fbf5e43fc8e2eb56bf9791785729b9fc8c22064a47af12052",
    stablecoinIsToken0: true,
    wrappedNativeAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
    minimumNativeLocked: new BigDecimal("10"),
    stablecoinAddresses: [
      "0x55d398326f99059ff775485246999027b3197955", // USDT
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    ],
    whitelistTokens: [
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
      "0x55d398326f99059ff775485246999027b3197955", // USDT
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
      "0x0000000000000000000000000000000000000000", // Native BNB
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "BNB",
      name: "Binance Coin",
      decimals: BigInt(18),
    },
  },
  [ChainId.AVALANCHE]: {
    poolManagerAddress: "0x06380c0e0912312b5150364b9dc4542ba0dbbc85",
    stablecoinWrappedNativePoolId:
      "0xd7a8035ddd9ec1dba25e3b27b685927fe63d65281f21c1c1d21d122fc48caeb7",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
    minimumNativeLocked: new BigDecimal("100"),
    stablecoinAddresses: [
      "0xd586e7f844cea2f87f50152665bcbc2c279d8d70", // DAI.e
      "0xba7deebbfc5fa1100fb055a87773e1e99cd3507a", // DAI
      "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", // USDC.e
      "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
      "0xc7198437980c041c805a1edcba50c1ce5db95118", // USDT.e
      "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDT
    ],
    whitelistTokens: [
      "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
      "0xd586e7f844cea2f87f50152665bcbc2c279d8d70", // DAI.e
      "0xba7deebbfc5fa1100fb055a87773e1e99cd3507a", // DAI
      "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", // USDC.e
      "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC
      "0xc7198437980c041c805a1edcba50c1ce5db95118", // USDT.e
      "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDT
      "0x130966628846bfd36ff31a822705796e8cb8c18d", // MIM
      "0x0000000000000000000000000000000000000000", // Native AVAX
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "AVAX",
      name: "Avalanche",
      decimals: BigInt(18),
    },
  },
  [ChainId.BLAST]: {
    poolManagerAddress: "0x1631559198a9e474033433b2958dabc135ab6446",
    stablecoinWrappedNativePoolId:
      "0x83e7c9f12348a95a5fe02c8af7074dd52defd1e108e19e51234c49da56d7c635",
    stablecoinIsToken0: true,
    wrappedNativeAddress: "0x4300000000000000000000000000000000000004", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0x4300000000000000000000000000000000000003", // USDB
    ],
    whitelistTokens: [
      "0x4300000000000000000000000000000000000004", // WETH
      "0x4300000000000000000000000000000000000003", // USDB
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.ZORA]: {
    poolManagerAddress: "0x0575338e4c17006ae181b47900a84404247ca30f",
    stablecoinWrappedNativePoolId:
      "0x8362fda2356bf98851192da5b5b89553dd92ad73f8e8d6be97f154ce72b0adfe",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0xcccccccc7021b32ebb4e8c08314bd62f7c653ec4", // USDzC
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0xcccccccc7021b32ebb4e8c08314bd62f7c653ec4", // USDzC
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.WORLD]: {
    poolManagerAddress: "0xb1860d529182ac3bc1f51fa2abd56662b7d13f33",
    stablecoinWrappedNativePoolId:
      "0x45c70c27c25654e8c73bc0d63ba350144de8207a73c53d38409d3e127d993dc7",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006", // WETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0x79a02482a880bce3f13e09da970dc34db4cd24d1", // USDC.e
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x79a02482a880bce3f13e09da970dc34db4cd24d1", // USDC.e
      "0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3", // WBTC
      "0x2cfc85d8e48f8eab294be644d9e25c3030863003", // WLD
      "0x859dbe24b90c9f2f7742083d3cf59ca41f55be5d", // sDAI
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.UNICHAIN]: {
    poolManagerAddress: "0x1f98400000000000000000000000000000000004",
    stablecoinWrappedNativePoolId:
      "0x25939956ef14a098d95051d86c75890cfd623a9eeba055e46d8dd9135980b37c",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x0000000000000000000000000000000000000000", // Native ETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0x078d782b760474a361dda0af3839290b0ef57ad6", // USDC
      "0x20cab320a855b39f724131c69424240519573f81", // DAI
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x078d782b760474a361dda0af3839290b0ef57ad6", // USDC
      "0x20cab320a855b39f724131c69424240519573f81", // DAI
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: BigInt(18),
    },
  },
  [ChainId.SONEIUM]: {
    poolManagerAddress: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    stablecoinWrappedNativePoolId:
      "0x3d18457ff1dcfa8ffb14b162ae3def9eda618569ac4a6aadc827628f5981b515",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x0000000000000000000000000000000000000000", // Native ETH
    minimumNativeLocked: new BigDecimal("1"),
    stablecoinAddresses: [
      "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369", // USDC
    ],
    whitelistTokens: [
      "0x4200000000000000000000000000000000000006", // WETH
      "0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369", // USDC
      "0x0000000000000000000000000000000000000000", // Native ETH
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "ETH",
      name: "Ethereum",
      decimals: 18n,
    },
  },
  [ChainId.MONAD]: {
    poolManagerAddress: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
    stablecoinWrappedNativePoolId:
      "0x7d892749d0562b0f78a26cdec26e97ec9dc7f8d1997cb590643ab69f10a1da0e",
    stablecoinIsToken0: false,
    wrappedNativeAddress: "0x0000000000000000000000000000000000000000", // Native MON
    minimumNativeLocked: new BigDecimal("100000"),
    stablecoinAddresses: [
      "0x754704bc059f8c67012fed69bc8a327a5aafb603", // USDC
      "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", // AUSD
      "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", // USDT
    ],
    whitelistTokens: [
      "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", // WMON
      "0x754704bc059f8c67012fed69bc8a327a5aafb603", // USDC
      "0x00000000efe302beaa2b3e6e1b18d08d69a9012a", // AUSD
      "0x0000000000000000000000000000000000000000", // Native MON
      "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", // USDT
      "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242", // WETH
      "0xea17e5a9efebf1477db45082d67010e2245217f1", // WSOL
      "0x0555e30da8f98308edb960aa94c0db47230d2b9c", // WBTC
    ],
    tokenOverrides: [],
    poolsToSkip: [],
    nativeTokenDetails: {
      symbol: "MON",
      name: "MON",
      decimals: BigInt(18),
    },
  },
};

// Helper function to get config for a specific chain
export function getChainConfig(chainId: EvmChainId): ChainConfig {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
}
