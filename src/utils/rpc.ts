/*
 * RPC endpoint per chain, for the code paths that must talk to a node directly.
 *
 * Extracted from `tokenMetadata.ts`, where it was private, so that every effect
 * resolves its endpoint the same way. Two of them now need it: the token
 * metadata reads that were always here, and the position fee reads
 * (`getFeeGrowthInside` / `getPositionInfo` and `debug_traceTransaction`) ported
 * from Ponder.
 *
 * Note the fee paths have stricter requirements than metadata does. The traces
 * need an ARCHIVE node with the `debug` namespace, and a public fallback will
 * not serve them — a chain whose var is unset degrades to zero collected fees
 * rather than failing, which is deliberate but worth knowing when a chain's
 * numbers look low.
 */

export const getRpcUrl = (chainId: number): string => {
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
    case 143:
      return process.env.ENVIO_MONAD_RPC_URL || "https://monad.drpc.org";
    case 59144:
      return process.env.ENVIO_LINEA_RPC_URL || "https://linea.drpc.org";
    case 42220:
      return process.env.ENVIO_CELO_RPC_URL || "https://celo.drpc.org";
    case 4326:
      return process.env.ENVIO_MEGAETH_RPC_URL || "https://megaeth.drpc.org";
    case 4663:
      return (
        process.env.ENVIO_ROBINHOOD_RPC_URL ||
        "https://rpc.mainnet.chain.robinhood.com"
      );
    // Add generic fallback for any chain
    default:
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
};
