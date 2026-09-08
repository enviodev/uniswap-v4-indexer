/*
 * EXACT collected fees for a position, from debug_traceTransaction.
 *
 * A port of the Ponder indexer's `core/fees-trace.ts`, mechanism unchanged.
 *
 * WHY A TRACE IS UNAVOIDABLE
 *
 * `PoolManager.modifyLiquidity` returns `(BalanceDelta callerDelta, BalanceDelta
 * feesAccrued)`. `feesAccrued` IS the exact collected fee — in range or out,
 * ERC-20 or native — and it appears in NO event or log. v4 has no Collect event,
 * and `ModifyLiquidity` carries only `{id, sender, tickLower, tickUpper,
 * liquidityDelta, salt}`. So the call trace is the only foolproof source, which
 * is why Ponder reads it and why this port keeps doing so rather than deriving
 * an approximation.
 *
 * IT NEVER THROWS. Envio treats an exception out of an effect as a FATAL EXIT
 * (no retry, no skip — see the note on TRANSIENT_BACKOFF_MS below), so every
 * failure path here degrades to "no collected fee recorded" with a warning.
 *
 * WHAT THE EFFECT WRAPPER ADDS OVER PONDER
 *
 * Ponder caches the trace for the CURRENT transaction only, in a module-level
 * variable, so a batched multi-position transaction is traced once — but that
 * cache dies with the process and every rebuild re-traces the entire history.
 * Envio's effect cache is persisted and keyed on the input, so a SUCCESSFUL
 * trace is taken once EVER, across restarts and resyncs, and `rateLimit` bounds
 * the archive node natively. Degraded results opt out via `context.cache = false`
 * — caching one would make a transient provider failure a permanent zero. That makes the per-transaction cache redundant: it is
 * subsumed by returning every salt's fees for the whole transaction in one
 * cached call, which is exactly what this effect's output does.
 */

import { createEffect, S } from "envio";
import { createPublicClient, http, decodeFunctionData, toFunctionSelector } from "viem";
import type { PublicClient } from "viem";

import { absBig, decodeBalanceDelta } from "../utils/fees";
import { getRpcUrl } from "../utils/rpc";

const MODIFY_LIQ_ABI = [
  {
    type: "function",
    name: "modifyLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "liquidityDelta", type: "int256" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [
      { name: "callerDelta", type: "int256" },
      { name: "feesAccrued", type: "int256" },
    ],
  },
] as const;

const MODIFY_LIQ_SELECTOR = toFunctionSelector(MODIFY_LIQ_ABI[0]);

/**
 * Some providers return a NON-DETERMINISTIC trace: observed on Arbitrum, a
 * transaction that succeeded on-chain intermittently comes back "execution
 * reverted" with no BalanceDelta output, from flaky full-versus-archive routing.
 * Retry until a usable trace arrives. (An earlier version of this comment
 * claimed a retry "round-robins to a different node"; nothing here or in viem
 * guarantees that — whether a retry reaches a different backend is entirely up
 * to the provider's load balancer. The retry is worth making regardless, since
 * the observed failure is intermittent, but the mechanism is not ours to claim.)
 */
const TRACE_MAX_ATTEMPTS = 5;
const TRACE_RETRY_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * THIS EFFECT MUST NEVER THROW, and that is not a style preference.
 *
 * Envio 3.7.0 has NO retry and NO skip for an exception out of a handler or an
 * effect. `EventProcessing.res:65-74` wraps it as `ProcessingError`, and
 * `BatchProcessing.res:156` hands that straight to
 * `IndexerState.errorExit(state, errHandler)` — a fatal exit of the indexer.
 *
 * An earlier version of this file rethrew transient errors with the comment
 * "let the runtime's own retry handle it". There is no such retry. Under
 * `envio dev`, which restarts the process, that turned one flaky RPC response
 * into a crash-restart loop that re-processed the same batch, hit the same
 * transaction, and died again — a chain pinned at zero events indefinitely,
 * which is exactly what was observed on Ethereum.
 *
 * So transient failures are retried HERE, with backoff, and exhaustion degrades
 * the same way a capability gap does. That is also Ponder's tested decision: it
 * warns and records zero for the one event rather than taking down the chain,
 * and its comment says so explicitly — "Trading one event's exact fee for
 * liveness, per design call."
 */
const TRANSIENT_BACKOFF_MS = [250, 750, 2000, 5000];

/**
 * Is this a PERMANENT trace-capability gap rather than a transient blip?
 *
 * The distinction is load-bearing: a permanent gap must degrade to "no collected
 * fee recorded" and warn, because without that guard a single -32601 from one
 * chain's RPC halts that chain's entire backfill. Capability gaps are common
 * across load-balanced provider pools that mix full and archive nodes.
 *
 * DIVERGENCE FROM PONDER, DELIBERATE, AND MEASURED. Ponder's version also
 * matches `msg.includes("tracer")`, and viem embeds the full request body in the
 * error message — and every `debug_traceTransaction` body contains
 * `"tracer":"callTracer"`. So in Ponder EVERY error on this call is classified
 * permanent, transient ones included, and silently records 0 collected fees.
 * That is not hypothetical: on mainnet, tokenId 926 shows 0 collected fees in
 * Ponder where the trace decodes to 333387.830400084026115227, and 686 has two
 * collects of which Ponder captured only the second.
 *
 * That substring is removed here, and the remaining phrases are ANCHORED rather
 * than bare — see the note at the regexes below for why a bare "not supported"
 * repeats Ponder's mistake in a quieter form.
 */
export function isTraceCapabilityError(e: unknown): boolean {
  const err = e as { code?: number; cause?: { code?: number; message?: string }; message?: string; details?: string };
  const code = err?.code ?? err?.cause?.code;
  if (code === -32601 || code === -32004) return true;
  const msg = String(err?.message ?? err?.details ?? err?.cause?.message ?? "").toLowerCase();

  // Unambiguous phrases: these only ever describe a missing method.
  if (
    msg.includes("method not found") ||
    msg.includes("method not supported") ||
    msg.includes("method does not exist")
  ) {
    return true;
  }

  /*
   * "not supported" and "unsupported" must be ANCHORED to the method, never
   * matched bare.
   *
   * Bare substrings are how this misfires. viem composes its error message from
   * the URL and the full request body, so the text being searched contains
   * arbitrary provider prose plus our own payload, and plenty of NON-capability
   * failures carry those words: rate-limit and plan-tier notices, pruning
   * messages ("state at block N is not available"), and load-balancer HTML.
   * Classifying any of those as permanent records ZERO collected fees for a
   * transaction that really settled one — and unlike a crash, that is a number
   * nobody can tell is wrong.
   *
   * Anchoring is also the specific trap Ponder fell into from the other
   * direction: it matches `msg.includes("tracer")`, and every
   * debug_traceTransaction body contains `"tracer":"callTracer"`, so EVERY
   * error there is "permanent". Requiring the words to sit next to `method` or
   * the method name — within a short window, so a mention anywhere in a long
   * body does not count — keeps a genuine "debug_traceTransaction is not
   * supported on your plan" (a real capability gap for this key) while
   * rejecting prose that merely contains the words.
   */
  const ANCHORED = [
    /\b(?:method|debug_tracetransaction)\b[^\n]{0,60}?\b(?:not supported|unsupported|not available|not enabled)\b/,
    /\b(?:not supported|unsupported|not enabled)\b[^\n]{0,60}?\b(?:method|debug_tracetransaction)\b/,
  ];
  return ANCHORED.some((re) => re.test(msg));
}

interface TraceNode {
  to?: string;
  input?: string;
  output?: string;
  error?: string;
  calls?: TraceNode[];
}

/** Every PoolManager.modifyLiquidity frame with a complete BalanceDelta output. */
function collectModifyCalls(node: TraceNode | undefined, acc: TraceNode[], poolManager: string): void {
  if (
    node &&
    typeof node.to === "string" &&
    node.to.toLowerCase() === poolManager &&
    typeof node.input === "string" &&
    node.input.toLowerCase().startsWith(MODIFY_LIQ_SELECTOR) &&
    typeof node.output === "string" &&
    // two int256 words of return data
    node.output.length >= 2 + 128
  ) {
    acc.push(node);
  }
  for (const c of node?.calls ?? []) collectModifyCalls(c, acc, poolManager);
}

const clients: Record<number, PublicClient> = {};
function traceClient(chainId: number): PublicClient {
  if (!clients[chainId]) {
    clients[chainId] = createPublicClient({ transport: http(getRpcUrl(chainId)) });
  }
  return clients[chainId];
}

/**
 * Collected fees for EVERY position touched by one transaction, keyed by salt
 * (which is the NFT tokenId).
 *
 * Returns the whole transaction rather than one position, so a batched
 * multi-position transaction costs exactly one trace and one cache entry. An
 * empty array means either no usable trace after retries or a permanent
 * capability gap — the caller records no collected fee and must NOT throw.
 *
 * Amounts are MAGNITUDES: `feesAccrued` is signed, a collected fee is not.
 */
const FeesBySalt = S.array(
  S.schema({
    salt: S.string,
    amount0: S.bigint,
    amount1: S.bigint,
  }),
);

export const getFeesAccrued = createEffect(
  {
    name: "getFeesAccrued",
    input: S.schema({
      chainId: S.number,
      txHash: S.string,
      poolManager: S.string,
    }),
    output: FeesBySalt,
    // Archive nodes are the scarce resource here and debug_traceTransaction is
    // the most expensive call in the indexer. A cached result means a given
    // transaction is traced once ever, even across a full resync.
    cache: true,
    rateLimit: { calls: 20, per: "second" },
    // Per-CHAIN rate limiting and cache, not global. `crossChain` defaults to
    // TRUE, which puts every chain through ONE shared rate-limit window — so
    // two chains backfilling in parallel contend for the same allowance and the
    // busier one starves. These inputs already carry `chainId` and each chain
    // has its own endpoint and its own quota, so a shared window bought nothing
    // but contention.
    crossChain: false,
  },
  async ({ context, input: { chainId, txHash, poolManager } }) => {
    const pm = poolManager.toLowerCase();
    const client = traceClient(chainId);

    for (let attempt = 0; attempt < TRACE_MAX_ATTEMPTS; attempt++) {
      let trace: TraceNode;
      try {
        trace = (await client.request({
          method: "debug_traceTransaction",
          params: [txHash as `0x${string}`, { tracer: "callTracer" }],
        } as never)) as TraceNode;
      } catch (e) {
        if (isTraceCapabilityError(e)) {
          // DO NOT CACHE a degraded result. The cache is persisted and keyed on
          // the input, so caching this would make "no collected fee for this
          // transaction" permanent — surviving restarts and a full resync, and
          // indistinguishable from a genuine zero even after the RPC is fixed.
          // `context.cache = false` is the repo's existing idiom for exactly
          // this (src/utils/tokenMetadata.ts:131,207).
          context.cache = false;
          context.log.warn(
            `debug_traceTransaction/callTracer unsupported on chain ${chainId} — ` +
              `collected fees recorded as 0 for tx ${txHash}`,
          );
          return [];
        }
        // Transient. Retried HERE, never rethrown — see the note on
        // TRANSIENT_BACKOFF_MS: a throw is a fatal exit of the whole indexer.
        if (attempt < TRACE_MAX_ATTEMPTS - 1) {
          const waitMs = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)]!;
          context.log.warn(
            `Trace attempt ${attempt + 1}/${TRACE_MAX_ATTEMPTS} failed for tx ${txHash} on chain ` +
              `${chainId} (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — ` +
              `retrying in ${waitMs}ms`,
          );
          await sleep(waitMs);
          continue;
        }
        // Exhausted. Degrade rather than exit, and do not cache the zero.
        context.cache = false;
        context.log.error(
          `All ${TRACE_MAX_ATTEMPTS} trace attempts failed for tx ${txHash} on chain ${chainId}: ` +
            `${e instanceof Error ? e.message.split("\n")[0] : String(e)} — recording 0 collected ` +
            `fees for this transaction. Re-run once the RPC is healthy to pick it up.`,
        );
        return [];
      }

      const calls: TraceNode[] = [];
      collectModifyCalls(trace, calls, pm);

      // Usable = the top call did not revert AND at least one modifyLiquidity
      // frame decoded with a full BalanceDelta output.
      if (!trace?.error && calls.length > 0) {
        const out: Array<{ salt: string; amount0: bigint; amount1: bigint }> = [];
        for (const c of calls) {
          let salt: string;
          try {
            const args = decodeFunctionData({
              abi: MODIFY_LIQ_ABI,
              data: c.input as `0x${string}`,
            }).args as readonly [unknown, { salt: string }, unknown];
            salt = BigInt(args[1].salt).toString();
          } catch {
            continue;
          }
          // feesAccrued is the SECOND return word: chars 66..130 of the output.
          const delta = decodeBalanceDelta(BigInt("0x" + (c.output as string).slice(66, 130)));
          out.push({ salt, amount0: absBig(delta.amount0), amount1: absBig(delta.amount1) });
        }
        return out;
      }

      if (attempt < TRACE_MAX_ATTEMPTS - 1) await sleep(TRACE_RETRY_DELAY_MS);
    }

    // Same reasoning as the capability branch: an unusable trace is a statement
    // about the provider at this moment, not about the transaction, so it must
    // not be frozen into the cache as a measured zero.
    context.cache = false;
    context.log.warn(
      `No usable trace for tx ${txHash} on chain ${chainId} after ${TRACE_MAX_ATTEMPTS} ` +
        `attempts — collected fees recorded as 0`,
    );
    return [];
  },
);
