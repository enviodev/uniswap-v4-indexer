/*
 * How far behind the chain head the indexer currently is.
 *
 * WHY THIS EXISTS
 *
 * Ponder declares its fee sweep as `blocks: { FeeSync: { startBlock: "latest" } }`
 * — the sweep runs ONLY at the head and never during a historical backfill.
 * Envio has no equivalent: `indexer.onBlock`'s `where` predicate is evaluated
 * once per chain at REGISTRATION time, so it cannot express head-proximity, and
 * an `_every` stride matches historical blocks exactly as it matches live ones.
 *
 * The obvious substitute — compare the block's timestamp to the wall clock —
 * is not available either. Envio's runtime notes that "onBlock items build
 * their block from the handler's own block number, not from the stores"
 * (`ChainState.res`), so a block handler receives `{ number }` and nothing else;
 * `timestamp` is not among the selectable `block_fields` because no block is
 * fetched for these items at all.
 *
 * So the head is asked for directly. `eth_blockNumber` is the cheapest call an
 * RPC serves, and one per firing — throttled as below — replaces a chunked
 * multicall per firing, which is what a backfill-wide sweep was really costing.
 */

import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";

import { getRpcUrl } from "./rpc";

const clients: Record<number, PublicClient> = {};
function headClient(chainId: number): PublicClient {
  if (!clients[chainId]) {
    clients[chainId] = createPublicClient({ transport: http(getRpcUrl(chainId)) });
  }
  return clients[chainId];
}

/**
 * How long a fetched head number is reused.
 *
 * During a backfill the sweep's firings arrive in rapid succession — thousands
 * per minute — and they all get the same answer, so caching collapses tens of
 * thousands of calls into a handful. The staleness this admits is irrelevant to
 * the only question being asked, which is whether we are millions of blocks
 * behind or at the tip.
 *
 * Not an Envio effect: an effect's cache keys on its input, and any input that
 * distinguishes one firing from the next would never produce a hit, while an
 * input that did not would pin the first head number forever.
 */
const HEAD_TTL_MS = 30_000;

interface CachedHead {
  readonly block: bigint;
  readonly fetchedAtMs: number;
}
const heads: Record<number, CachedHead | undefined> = {};

/**
 * The chain's current head block, or `undefined` when it cannot be determined.
 *
 * `undefined` is NOT "zero" and callers must not treat it as either behind or
 * caught up — see `isAtChainHead`, which fails CLOSED so that an RPC outage
 * cannot start a full-history sweep.
 */
export async function chainHeadBlock(chainId: number): Promise<bigint | undefined> {
  const cached = heads[chainId];
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < HEAD_TTL_MS) return cached.block;

  try {
    const block = await headClient(chainId).getBlockNumber();
    heads[chainId] = { block, fetchedAtMs: now };
    return block;
  } catch {
    // Keep serving the last known head rather than nothing: a momentary RPC
    // blip should not suspend the sweep on a live chain.
    return cached?.block;
  }
}

/**
 * The chain's head ONCE, at process start, for use as an `onBlock` `_gte` floor.
 *
 * WHY A FLOOR BEATS A RUNTIME GATE
 *
 * `indexer.onBlock`'s `where` runs once per chain at registration, so it cannot
 * ask "are we at the head yet?" — but it CAN say "not below this block". Fetch
 * the head here, hand it to `where` as `_gte`, and Envio never generates a block
 * item for the historical range at all. The runtime gate only ever skipped work
 * AFTER the item existed and the handler had been invoked; this stops the
 * invocation. On a full Avalanche backfill that is ~32,000 handler calls and
 * their DB round trips that simply never happen.
 *
 * The semantics fall out for free: a fresh indexer starting at block 56M with
 * the chain at 94M gets a floor of 94M, so the sweep is silent for the whole
 * backfill and starts firing exactly when indexing reaches the tip. An indexer
 * restarting while already caught up gets a floor at roughly where it is, so it
 * resumes immediately.
 *
 * TIMEOUT AND FALLBACK ARE NOT OPTIONAL. This runs at module load, before the
 * indexer starts, so a hanging RPC would hang startup. On timeout or failure it
 * returns `undefined`, the caller omits `_gte`, and the runtime gate below is
 * what holds the line — slower, but never wrong and never fatal.
 */
export async function headAtStartup(
  chainIds: readonly number[],
  timeoutMs = 5000,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        const block = await Promise.race([
          headClient(chainId).getBlockNumber(),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
        ]);
        if (block !== undefined) {
          out.set(chainId, Number(block));
          // Seed the TTL cache too: the runtime gate's first call is then free.
          heads[chainId] = { block, fetchedAtMs: Date.now() };
        }
      } catch {
        // Deliberately silent per chain — the caller reports what it got, and a
        // missing entry is a documented, safe degradation rather than an error.
      }
    }),
  );
  return out;
}

/*
 * Once caught up, STAY caught up — the latch.
 *
 * Without this the gate flaps: a live indexer that drifts a few thousand blocks
 * behind during an RPC blip would switch the sweep off, then on, then off. The
 * user-visible rule we want is "after the initial backfill, keep refreshing
 * fees even if we lag a bit", and a plain distance test cannot express it
 * because it cannot tell "briefly behind" from "still backfilling".
 *
 * The latch is per chain, in memory, and NOT persisted on purpose: after a
 * restart the indexer really is behind again until it proves otherwise, and
 * re-earning the latch costs one `eth_blockNumber`.
 *
 * It un-latches on a LARGE regression. Falling this far behind means the work is
 * once again being overwritten before anyone can read it — an outage, or a deep
 * rollback — so the backfill reasoning applies again.
 */
const caughtUp = new Set<number>();

/**
 * How far behind, in the caller's own intervals, a latched chain may fall before
 * it counts as backfilling again.
 *
 * THREE, not fifty. The sweep intervals are all chosen to land near ONE HOUR,
 * so a multiple of the interval is a multiple of an hour — and the first version
 * of this used 50, which tolerated roughly fifty hours of lag while still
 * reporting "at the head". Flapping is a one-interval phenomenon: it happens
 * because the indexer is normally somewhere between 0 and `interval` blocks
 * behind between firings. Three gives that a 3x margin while bounding how stale
 * a "fresh" sweep can be to a few hours instead of a couple of days.
 */
const RELATCH_BEHIND_INTERVALS = 3n;

/**
 * Has this chain reached the head at least once this process?
 *
 * Exported for tests and for any caller that needs to distinguish "at the tip"
 * from "latched but lagging" — a distinction `isAtChainHead` deliberately hides
 * from its callers, since acting on it is the flapping this latch prevents.
 */
export function hasCaughtUp(chainId: number): boolean {
  return caughtUp.has(chainId);
}

/**
 * Is `blockNumber` close enough to the head for head-only work to be worth doing?
 *
 * `tolerance` is the caller's own cadence — a sweep that runs every N blocks is
 * legitimately up to N blocks behind the tip between firings, so measuring
 * against that same N is what distinguishes "normal live operation" from "still
 * replaying history" without a magic constant.
 *
 * Fails CLOSED. If the head is unknown the answer is `false`, because the cost
 * of wrongly answering `true` is a full historical sweep — tens of thousands of
 * firings of work that is overwritten and never observed — while the cost of
 * wrongly answering `false` is one skipped refresh cycle.
 */
export async function isAtChainHead(
  chainId: number,
  blockNumber: bigint,
  tolerance: bigint,
  log?: { info: (msg: string) => void },
): Promise<boolean> {
  const head = await chainHeadBlock(chainId);
  if (head === undefined) return false;

  // A block AHEAD of the cached head is normal: the cache is up to HEAD_TTL_MS
  // stale, and the indexer may have advanced past it.
  const behind = blockNumber >= head ? 0n : head - blockNumber;

  if (behind <= tolerance) {
    if (!caughtUp.has(chainId)) {
      caughtUp.add(chainId);
      log?.info(
        `chain ${chainId} reached the head at block ${blockNumber} — head-only work is now ON ` +
          `and stays on through normal lag`,
      );
    }
    return true;
  }

  if (caughtUp.has(chainId)) {
    // Latched: keep going through ordinary lag, but give up if the gap becomes
    // backfill-sized again.
    if (behind <= tolerance * RELATCH_BEHIND_INTERVALS) return true;
    caughtUp.delete(chainId);
    log?.info(
      `chain ${chainId} fell ${behind} blocks behind the head at block ${blockNumber} — ` +
        `head-only work is OFF until it catches up again`,
    );
  }
  return false;
}

/** Test seam. */
export function __resetChainHeadCache(): void {
  for (const k of Object.keys(heads)) delete heads[Number(k)];
  caughtUp.clear();
}
