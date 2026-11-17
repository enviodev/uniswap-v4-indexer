import hooklist from "../../hooklist.json";

// Uniswap v4 encodes a hook's permissions in the low 14 bits of its address
// (Hooks.sol: the deployer mines a CREATE2 salt until the address carries the
// right bits). That makes every flag below derivable from the address alone,
// for any hook the indexer ever sees — listed in hooklist.json or not.
//
// Bit 13 is the first flag, bit 0 the last.
export const HOOK_FLAG_NAMES = [
  "beforeInitialize",
  "afterInitialize",
  "beforeAddLiquidity",
  "afterAddLiquidity",
  "beforeRemoveLiquidity",
  "afterRemoveLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeDonate",
  "afterDonate",
  "beforeSwapReturnsDelta",
  "afterSwapReturnsDelta",
  "afterAddLiquidityReturnsDelta",
  "afterRemoveLiquidityReturnsDelta",
] as const;

export type HookFlagName = (typeof HOOK_FLAG_NAMES)[number];
export type HookFlags = { [K in HookFlagName]: boolean };

const PERMISSION_MASK = 0x3fff;

/** The 14-bit permission mask carried in the hook address. */
export function hookPermissions(address: string): number {
  return parseInt(address.slice(-4), 16) & PERMISSION_MASK;
}

/** Every permission flag, decoded from the address. */
export function hookFlags(address: string): HookFlags {
  const mask = hookPermissions(address);
  const bit = (i: number) => ((mask >> (13 - i)) & 1) === 1;
  return {
    beforeInitialize: bit(0),
    afterInitialize: bit(1),
    beforeAddLiquidity: bit(2),
    afterAddLiquidity: bit(3),
    beforeRemoveLiquidity: bit(4),
    afterRemoveLiquidity: bit(5),
    beforeSwap: bit(6),
    afterSwap: bit(7),
    beforeDonate: bit(8),
    afterDonate: bit(9),
    beforeSwapReturnsDelta: bit(10),
    afterSwapReturnsDelta: bit(11),
    afterAddLiquidityReturnsDelta: bit(12),
    afterRemoveLiquidityReturnsDelta: bit(13),
  };
}

// Curated metadata from github.com/Uniswap/hooklist (hooklist.json, vendored
// at the repo root and refreshed weekly by CI). Nothing here is on-chain, which
// is the whole reason to carry the file. Fields are optional because the list's
// entries are not uniform — `deployer` is missing on some.
export interface HooklistEntry {
  hook: {
    address: string;
    chainId: number;
    name: string;
    description?: string;
    deployer?: string;
    verifiedSource?: boolean;
    auditUrl?: string;
  };
  properties: {
    dynamicFee?: boolean;
    upgradeable?: boolean;
    vanillaSwap?: boolean;
    // One of: none | other | temporal | governance | allowlist
    swapAccess?: string;
  };
}

const byChainAndAddress = new Map<string, HooklistEntry>();
for (const entry of hooklist as HooklistEntry[]) {
  byChainAndAddress.set(
    `${entry.hook.chainId}_${entry.hook.address.toLowerCase()}`,
    entry
  );
}

/** Curated entry for a hook, or undefined when it isn't in the list. */
export function lookupHook(
  chainId: number,
  address: string
): HooklistEntry | undefined {
  return byChainAndAddress.get(`${chainId}_${address.toLowerCase()}`);
}

/** The list stores absent text as "", which should read as null downstream. */
const orNull = (s: string | undefined) => (s ? s : undefined);

/** Everything HookStats learns about a hook the first time it is seen. */
export function hookMetadata(chainId: number, address: string) {
  const listed = lookupHook(chainId, address);
  return {
    permissions: hookPermissions(address),
    ...hookFlags(address),
    isListed: listed !== undefined,
    name: listed?.hook.name,
    description: orNull(listed?.hook.description),
    deployer: orNull(listed?.hook.deployer),
    verifiedSource: listed?.hook.verifiedSource,
    auditUrl: orNull(listed?.hook.auditUrl),
    dynamicFee: listed?.properties.dynamicFee,
    upgradeable: listed?.properties.upgradeable,
    vanillaSwap: listed?.properties.vanillaSwap,
    swapAccess: listed?.properties.swapAccess,
  };
}
