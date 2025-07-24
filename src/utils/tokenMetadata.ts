import { createPublicClient, http, getContract, type PublicClient } from "viem";
import { ADDRESS_ZERO } from "./constants";
import { getChainConfig } from "./chains";
import * as dotenv from "dotenv";
import { experimental_createEffect, S } from "envio";

dotenv.config();

const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "NAME",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "SYMBOL",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const TokenMetadata = S.schema({
  name: S.string,
  symbol: S.string,
  decimals: S.number,
});
type TokenMetadata = S.Output<typeof TokenMetadata>;

const getRpcUrl = (chainId: number): string => {
  switch (chainId) {
    case 1:
      return process.env.ENVIO_MAINNET_RPC_URL || "https://eth.drpc.org";
    case 42161:
      return process.env.ENVIO_ARBITRUM_RPC_URL || "https://arbitrum.drpc.org";
    case 10:
      return process.env.ENVIO_OPTIMISM_RPC_URL || "https://optimism.drpc.org";
    case 8453:
      return process.env.ENVIO_BASE_RPC_URL || "https://base.drpc.org";
    case 137:
      return process.env.ENVIO_POLYGON_RPC_URL || "https://polygon.drpc.org";
    case 43114:
      return (
        process.env.ENVIO_AVALANCHE_RPC_URL || "https://avalanche.drpc.org"
      );
    case 56:
      return process.env.ENVIO_BSC_RPC_URL || "https://bsc.drpc.org";
    case 81457:
      return process.env.ENVIO_BLAST_RPC_URL || "https://blast.drpc.org";
    case 7777777:
      return process.env.ENVIO_ZORA_RPC_URL || "https://zora.drpc.org";
    case 1868:
      return process.env.ENVIO_SONIEUM_RPC_URL || "https://sonieum.drpc.org";
    case 130:
      return process.env.ENVIO_UNICHAIN_RPC_URL || "https://unichain.drpc.org";
    case 57073:
      return process.env.ENVIO_INK_RPC_URL || "https://ink.drpc.org";
    case 480:
      return (
        process.env.ENVIO_WORLDCHAIN_RPC_URL || "https://worldchain.drpc.org"
      );
    // Add generic fallback for any chain
    default:
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
};

// Cache of clients per chainId
const clients: Record<number, PublicClient> = {};

// Get client for a specific chain
const getClient = (chainId: number): PublicClient => {
  if (!clients[chainId]) {
    try {
      // Create a simpler client configuration
      clients[chainId] = createPublicClient({
        transport: http(getRpcUrl(chainId), {
          batch: true,
        }),
      });
      console.log(`Created client for chain ${chainId}`);
    } catch (e) {
      console.error(`Error creating client for chain ${chainId}:`, e);
      throw e;
    }
  }
  return clients[chainId];
};

// Add this function to sanitize strings by removing null bytes and other problematic characters
function sanitizeString(str: string): string {
  if (!str) return "";

  // Remove null bytes and other control characters that might cause issues with PostgreSQL
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

export const getTokenMetadata = experimental_createEffect(
  {
    name: "getTokenMetadata",
    input: S.tuple((t) => ({
      address: t.item(0, S.string),
      chainId: t.item(1, S.number),
    })),
    output: TokenMetadata,
    cache: true,
  },
  async ({ context, input: { address, chainId } }) => {
    // Handle native token
    if (address.toLowerCase() === ADDRESS_ZERO.toLowerCase()) {
      const chainConfig = getChainConfig(chainId);
      return {
        name: chainConfig.nativeTokenDetails.name,
        symbol: chainConfig.nativeTokenDetails.symbol,
        decimals: Number(chainConfig.nativeTokenDetails.decimals),
      };
    }

    // Check for token overrides in chain config
    const chainConfig = getChainConfig(chainId);
    const tokenOverride = chainConfig.tokenOverrides.find(
      (t) => t.address.toLowerCase() === address.toLowerCase()
    );

    if (tokenOverride) {
      return {
        name: tokenOverride.name,
        symbol: tokenOverride.symbol,
        decimals: Number(tokenOverride.decimals),
      };
    }

    try {
      // Use the multicall implementation for efficiency
      return await fetchTokenMetadataMulticall(address, chainId);
    } catch (e) {
      context.log.error(
        `Error fetching metadata for ${address} on chain ${chainId}:`,
        e as Error
      );
      throw e;
    }
  }
);

// Update the fetchTokenMetadataMulticall function to sanitize name and symbol
async function fetchTokenMetadataMulticall(
  address: string,
  chainId: number
): Promise<TokenMetadata> {
  const client = getClient(chainId);
  const contract = getContract({
    address: address as `0x${string}`,
    abi: ERC20_ABI,
    client,
  });

  // Prepare promises but don't await them yet
  const namePromise = contract.read.name().catch(() => null);
  const nameBytes32Promise = contract.read.NAME().catch(() => null);
  const symbolPromise = contract.read.symbol().catch(() => null);
  const symbolBytes32Promise = contract.read.SYMBOL().catch(() => null);
  const decimalsPromise = contract.read.decimals().catch(() => 18); // Default to 18

  // Execute all promises in a single multicall batch
  const [
    nameResult,
    nameBytes32Result,
    symbolResult,
    symbolBytes32Result,
    decimalsResult,
  ] = await Promise.all([
    namePromise,
    nameBytes32Promise,
    symbolPromise,
    symbolBytes32Promise,
    decimalsPromise,
  ]);

  // Process name with fallbacks
  let name = "unknown";
  if (nameResult !== null) {
    name = sanitizeString(nameResult);
  } else if (nameBytes32Result !== null) {
    name = sanitizeString(
      new TextDecoder().decode(
        new Uint8Array(
          Buffer.from(nameBytes32Result.slice(2), "hex").filter((n) => n !== 0)
        )
      )
    );
  }

  // Process symbol with fallbacks
  let symbol = "UNKNOWN";
  if (symbolResult !== null) {
    symbol = sanitizeString(symbolResult);
  } else if (symbolBytes32Result !== null) {
    symbol = sanitizeString(
      new TextDecoder().decode(
        new Uint8Array(
          Buffer.from(symbolBytes32Result.slice(2), "hex").filter(
            (n) => n !== 0
          )
        )
      )
    );
  }

  return {
    name: name || "unknown",
    symbol: symbol || "UNKNOWN",
    decimals:
      typeof decimalsResult === "number" &&
      // There's a token on base with decimals ~= 9132491757359273498234t629765928734n
      // which literally crashes our indexer. To prevent it from happening
      // use 18 for all tokens with decimals > 50
      // This is the biggest decimals we've seen so far for other tokens.
      decimalsResult <= 50
        ? decimalsResult
        : 18,
  };
}
