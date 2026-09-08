#!/usr/bin/env node
/*
 * Differential test: Envio's EXACT collected fees against Ponder's.
 *
 * WHY PER-TRANSACTION AND NOT PER-POSITION
 *
 * The obvious test — compare `Position.totalFeesCollected0/1` between the two
 * indexers — is INVALID while they are at different heights. Those columns are
 * running sums over every event each indexer has processed, so a mid-backfill
 * Envio legitimately reports less than a caught-up Ponder, and the comparison
 * fails for a reason that has nothing to do with correctness.
 *
 * A `COLLECT_FEES` row is different: it records what one transaction settled,
 * which is a historical fact about the chain and does not change as either
 * indexer advances. So matching on (chainId, tokenId, txHash) and comparing
 * amounts is a valid test TODAY, mid-backfill, and it tests exactly the thing
 * that has to be exact — the `debug_traceTransaction` path that reads
 * `feesAccrued`, the return value of `PoolManager.modifyLiquidity` that appears
 * in no event.
 *
 * WHY A TOLERANCE, AND WHY IT IS NOT A FUDGE
 *
 * Ponder stores these as JS numbers: `toHuman(absBig(fa.amount0), dec0)` yields
 * a double. Envio stores an exact BigDecimal. For fee amounts with more than ~15
 * significant digits Ponder's stored value is therefore LOSSY, and Envio is
 * strictly the more accurate of the two. A difference within double precision is
 * agreement; a difference beyond it is a real disagreement and the whole point
 * of this script. Exact-match counts are reported separately so the distinction
 * stays visible rather than being absorbed by the tolerance.
 *
 * USAGE
 *   node scripts/diff-collected-fees.mjs [--chain 1] [--limit 500]
 *
 * Reads Envio from the local dev Postgres (docker container envio-postgres) and
 * Ponder from its public GraphQL endpoint. Exits non-zero if any disagreement
 * exceeds the tolerance, so it can gate a cutover.
 */

import { execFileSync } from "node:child_process";

const PONDER_URLS = {
  1: "https://ponder-uniswap-v4-mainnet.up.railway.app/graphql",
  42161: "https://ponder-uniswap-v4-arbitrum.up.railway.app/graphql",
  43114: "https://ponder-uniswap-v4-avalanche.up.railway.app/graphql",
  4663: "https://ponder-uniswap-v4-robinhood.up.railway.app/graphql",
};

/** Doubles carry ~15-16 significant decimal digits; allow one order of slack. */
const REL_TOLERANCE = 1e-13;

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const CHAINS = argVal("chain") ? [Number(argVal("chain"))] : [1, 43114];
const LIMIT = Number(argVal("limit", "500"));
/*
 * `txns`   — per-transaction COLLECT_FEES amounts (the default; see the header).
 * `totals` — Position.totalFeesCollected0/1 for CLOSED positions only.
 *
 * The `totals` mode exists because a mid-backfill Ponder cannot serve the `txns`
 * comparison at all on a busy chain: it builds its declared indexes only after a
 * backfill completes, so every filtered read of `position_transaction` is a full
 * table scan and mainnet answers 502. `position` is reachable by PRIMARY KEY,
 * which is always indexed, so this mode gets an answer where the other cannot.
 *
 * It is only valid for a position that BOTH indexers have finished with, which
 * is why it takes closed positions and additionally requires Ponder's own
 * `updatedAtBlock` to sit at or below our synced head. A position Ponder touched
 * later — a close followed by a reopen we have not reached — would otherwise
 * look like a disagreement when it is just a height difference.
 */
const MODE = argVal("mode", "txns");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "envio-postgres", "psql", "-U", "postgres", "-d", "envio-dev", "-At", "-F", "\t", "-c", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Envio's COLLECT_FEES rows: what our trace path concluded each tx settled. */
function envioCollects(chainId, limit) {
  const out = psql(
    `select "txHash", "tokenId"::text, "amount0"::text, "amount1"::text, "blockNumber"::text
       from public."PositionTransaction"
      where "chainId" = ${chainId} and type = 'COLLECT_FEES'
      order by "blockNumber" desc
      limit ${limit};`,
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [txHash, tokenId, amount0, amount1, blockNumber] = l.split("\t");
      return { txHash, tokenId, amount0, amount1, blockNumber: Number(blockNumber) };
    });
}

/*
 * Ponder's rows for the same token ids.
 *
 * Queried by tokenId rather than txHash because `positionTransactionFilter`
 * indexes tokenId, and because a position's whole history is a handful of rows —
 * far fewer round trips than one query per transaction.
 */
const PONDER_QUERY = `
  query Txns($where: positionTransactionFilter, $limit: Int!, $after: String) {
    positionTransactions(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: $limit, after: $after) {
      items { txHash tokenId type amount0 amount1 }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const unavailable = [];

/*
 * Ponder's COLLECT_FEES rows over the BLOCK RANGE our own data covers.
 *
 * WHY A RANGE WALK AND NOT PER-POSITION LOOKUPS
 *
 * The first version asked Ponder for each position's rows via `tokenId_in`.
 * That is the natural shape, and on mainnet it is unusable: Ponder builds its
 * DECLARED indexes only after a backfill completes and drops them on every
 * crash-recovery start, so `position_transaction` there currently has nothing
 * but a primary key. Every filtered read is a full table scan, and N positions
 * means N scans — mainnet answered "canceling statement due to statement
 * timeout" and adaptive halving just bought N more scans.
 *
 * Paginating a block-bounded range instead amortises ONE scan across many
 * pages. The bound is our own data's extent, so nothing outside the comparable
 * window is fetched.
 */
const PONDER_RANGE_QUERY = `
  query Range($where: positionTransactionFilter, $limit: Int!, $after: String) {
    positionTransactions(where: $where, orderBy: "blockNumber", orderDirection: "asc", limit: $limit, after: $after) {
      items { txHash tokenId type amount0 amount1 blockNumber }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function ponderCollects(chainId, rows) {
  const url = PONDER_URLS[chainId];
  if (!url) throw new Error(`no Ponder endpoint for chain ${chainId}`);
  const minBlock = Math.min(...rows.map((r) => r.blockNumber));
  const maxBlock = Math.max(...rows.map((r) => r.blockNumber));
  const byKey = new Map();

  let after = null;
  let pages = 0;
  for (;;) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: PONDER_RANGE_QUERY,
        variables: {
          where: {
            chainId,
            type: "COLLECT_FEES",
            blockNumber_gte: String(minBlock),
            blockNumber_lte: String(maxBlock),
          },
          limit: 1000,
          after,
        },
      }),
    });
    if (!res.ok) throw new Error(`Ponder HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors) throw new Error(`Ponder GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
    const page = body.data?.positionTransactions;
    for (const r of page?.items ?? []) byKey.set(`${r.tokenId}:${r.txHash.toLowerCase()}`, r);
    pages += 1;
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
    if (pages > 200) {
      console.log("  (stopped after 200 pages — range wider than expected)");
      break;
    }
  }
  console.log(`  Ponder: walked blocks ${minBlock}..${maxBlock} in ${pages} page(s)`);
  return byKey;
}

/** Envio's synced head per chain, from its own progress table. */
function envioSyncedHead(chainId) {
  const out = psql(
    `select max("blockNumber")::text from public."PositionTransaction" where "chainId" = ${chainId};`,
  ).trim();
  return Number(out || 0);
}

/** Closed Envio positions carrying collected fees — totals are final for these. */
function envioClosedTotals(chainId, limit) {
  const out = psql(
    `select "tokenId"::text, "totalFeesCollected0"::text, "totalFeesCollected1"::text,
            "updatedAtBlock"::text
       from public."Position"
      where "chainId" = ${chainId}
        and not "isActive"
        and ("totalFeesCollected0" <> 0 or "totalFeesCollected1" <> 0)
      order by "updatedAtBlock" desc
      limit ${limit};`,
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [tokenId, c0, c1, updatedAtBlock] = l.split("\t");
      return { tokenId, c0, c1, updatedAtBlock: Number(updatedAtBlock) };
    });
}

async function ponderPosition(chainId, tokenId) {
  const url = PONDER_URLS[chainId];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query P($tokenId: String!) {
        position(chainId: ${chainId}, tokenId: $tokenId) {
          tokenId isActive liquidity totalFeesCollected0 totalFeesCollected1 updatedAtBlock
        }
      }`,
      variables: { tokenId },
    }),
  });
  if (!res.ok) throw new Error(`Ponder HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(`Ponder GraphQL: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data?.position ?? null;
}

async function runTotalsMode(chainId) {
  const mine = envioClosedTotals(chainId, LIMIT);
  if (mine.length === 0) {
    console.log("  NOT COMPARED — no closed positions with collected fees yet");
    skipped.push({ chainId, reason: "no closed positions with fees yet" });
    return;
  }
  const head = envioSyncedHead(chainId);
  console.log(`  Envio: ${mine.length} closed positions with fees (synced head ~${head})`);

  let exact = 0;
  let withinTol = 0;
  let absent = 0;
  let ahead = 0;
  const mismatches = [];
  const ponderLow = [];

  for (const row of mine) {
    let p;
    try {
      p = await ponderPosition(chainId, row.tokenId);
    } catch (e) {
      console.log(`  NOT COMPARED — Ponder unreachable: ${e.message}`);
      skipped.push({ chainId, reason: e.message });
      return;
    }
    if (!p) {
      absent += 1;
      continue;
    }
    // Ponder saw events we have not: not comparable, and not a disagreement.
    if (Number(p.updatedAtBlock) > head) {
      ahead += 1;
      continue;
    }
    const d0 = relDiff(row.c0, p.totalFeesCollected0);
    const d1 = relDiff(row.c1, p.totalFeesCollected1);
    const worst = Math.max(d0, d1);
    if (worst === 0) exact += 1;
    else if (worst <= REL_TOLERANCE) withinTol += 1;
    else if (
      explainedByPonderUndercount(row.c0, p.totalFeesCollected0, row.c1, p.totalFeesCollected1)
    ) {
      ponderLow.push({ ...row, theirs: p, d0, d1 });
    } else mismatches.push({ ...row, theirs: p, d0, d1 });
  }

  console.log(`  exact:          ${exact}`);
  console.log(`  within tol:     ${withinTol}   (Ponder stores doubles; Envio is exact)`);
  console.log(`  not in Ponder:  ${absent}`);
  console.log(`  Ponder ahead:   ${ahead}   (skipped — it has events we have not reached)`);
  console.log(
    `  Ponder LOW:     ${ponderLow.length}   (Envio higher — Ponder's known missed-trace under-count)`,
  );
  console.log(`  MISMATCHED:     ${mismatches.length}   (unexplained — these fail the gate)`);
  for (const m of ponderLow.slice(0, 10)) {
    console.log(
      `    [ponder-low] tokenId=${m.tokenId} envio=(${m.c0}, ${m.c1}) ` +
        `ponder=(${m.theirs.totalFeesCollected0}, ${m.theirs.totalFeesCollected1})`,
    );
  }
  for (const m of mismatches.slice(0, 15)) {
    console.log(
      `    tokenId=${m.tokenId}\n` +
        `      envio  collected0=${m.c0} collected1=${m.c1}\n` +
        `      ponder collected0=${m.theirs.totalFeesCollected0} collected1=${m.theirs.totalFeesCollected1}\n` +
        `      relDiff0=${m.d0.toExponential(3)} relDiff1=${m.d1.toExponential(3)}`,
    );
  }
  if (mismatches.length > 15) console.log(`    ... and ${mismatches.length - 15} more`);
  if (mismatches.length > 0) hadFailure = true;
  if (exact + withinTol + ponderLow.length === 0 && mismatches.length === 0) {
    console.log("  NOT COMPARED — every candidate was absent or ahead in Ponder");
    skipped.push({ chainId, reason: "no comparable closed positions" });
  }
}

/*
 * Is a disagreement explained by Ponder's KNOWN under-count?
 *
 * Ponder's `isTraceCapabilityError` (core/fees-trace.ts) matches
 * `msg.includes("tracer")`, and viem embeds the full request body — which always
 * contains `"tracer":"callTracer"` — in every error message. So in Ponder EVERY
 * trace error, transient ones included, is classified as a permanent capability
 * gap and records ZERO collected fees for that event. Its own comment accepts
 * the consequence: "we just under-count this one collect until a re-sync."
 * Removing that substring is the port's one deliberate divergence.
 *
 * The asymmetry is therefore principled, not a convenience: Ponder's defect can
 * only ever make it record LESS than the chain says, never more. So
 * `envio > ponder` is explainable and is reported separately, while
 * `envio < ponder` means WE lost a fee and always fails.
 *
 * Verified on three mainnet positions by tracing the transactions directly and
 * decoding `feesAccrued`: tokenId 926 (Ponder 0 vs a real 333387.830400084026115227),
 * 686 (Ponder captured the second of two collects and missed the first), and
 * 706 (Ponder 0 vs a real 0.000000164039415489). In all three Envio matched the
 * chain byte for byte.
 */
function explainedByPonderUndercount(mine0, theirs0, mine1, theirs1) {
  const a0 = Number(mine0);
  const b0 = Number(theirs0);
  const a1 = Number(mine1);
  const b1 = Number(theirs1);
  // Never LOWER on either leg, and strictly higher on at least one. Requiring
  // both legs to be strictly higher was wrong: a single-sided collect leaves the
  // other leg equal at zero in both indexers, which is the common case — it is
  // what tokenId 926 looks like.
  const neverLower = a0 >= b0 && a1 >= b1;
  const someHigher = a0 > b0 || a1 > b1;
  return neverLower && someHigher;
}

/** Relative difference, treating an exact-zero pair as agreement. */
function relDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (x === 0 && y === 0) return 0;
  const scale = Math.max(Math.abs(x), Math.abs(y));
  if (scale === 0) return 0;
  return Math.abs(x - y) / scale;
}

/**
 * A clear message when the local indexer is not up.
 *
 * `envio dev` removes its containers on shutdown, so the failure mode is a
 * missing container rather than a refused connection — and `execFileSync`
 * surfaces that as a raw stack trace, which reads like a bug in this script.
 */
function requireLocalDb() {
  try {
    execFileSync("docker", ["inspect", "envio-postgres"], { stdio: "ignore" });
  } catch {
    console.error(
      "Local indexer database not found (docker container `envio-postgres`).\n" +
        "Start the indexer first — `pnpm dev` — and let it index far enough to\n" +
        "cover the positions you want to compare.",
    );
    process.exit(2);
  }
}
requireLocalDb();

let hadFailure = false;
/*
 * A chain we could not compare is NOT a pass.
 *
 * The first version of this script printed "no disagreement" and exited 0 when
 * Ponder was unreachable, which is the failure mode this whole exercise keeps
 * running into: silence reading as success. A gate that reports OK when it never
 * ran is worse than no gate, so an unusable chain is now its own exit status.
 */
const skipped = [];

for (const chainId of CHAINS) {
  console.log(`\n=== chain ${chainId} (mode: ${MODE}) ===`);
  if (MODE === "totals") {
    await runTotalsMode(chainId);
    continue;
  }
  const mine = envioCollects(chainId, LIMIT);
  if (mine.length === 0) {
    console.log("  NOT COMPARED — no COLLECT_FEES rows indexed yet");
    skipped.push({ chainId, reason: "no Envio COLLECT_FEES rows yet" });
    continue;
  }
  const tokenIds = [...new Set(mine.map((r) => r.tokenId))];
  console.log(`  Envio: ${mine.length} COLLECT_FEES rows across ${tokenIds.length} positions`);

  let theirs;
  unavailable.length = 0;
  try {
    theirs = await ponderCollects(chainId, mine);
  } catch (e) {
    console.log(`  NOT COMPARED — Ponder unreachable: ${e.message}`);
    skipped.push({ chainId, reason: e.message });
    continue;
  }
  console.log(`  Ponder: ${theirs.size} matching COLLECT_FEES rows`);

  let exact = 0;
  let withinTol = 0;
  let missing = 0;
  const mismatches = [];

  for (const row of mine) {
    const key = `${row.tokenId}:${row.txHash.toLowerCase()}`;
    const p = theirs.get(key);
    if (!p) {
      // Not a failure on its own: Ponder may not have indexed this position, or
      // its own trace may have degraded to zero (it records 0 and warns, and
      // three of its four chains were running without the position-query
      // indexes). Counted and reported, never silently dropped.
      missing += 1;
      continue;
    }
    const d0 = relDiff(row.amount0, p.amount0);
    const d1 = relDiff(row.amount1, p.amount1);
    const worst = Math.max(d0, d1);
    if (worst === 0) exact += 1;
    else if (worst <= REL_TOLERANCE) withinTol += 1;
    else mismatches.push({ ...row, theirs: p, d0, d1 });
  }

  console.log(`  exact:        ${exact}`);
  console.log(`  within tol:   ${withinTol}   (Ponder stores doubles; Envio is exact)`);
  console.log(`  not in Ponder:${missing}`);
  if (unavailable.length > 0) {
    console.log(
      `  UNSERVABLE:   ${unavailable.length} positions Ponder could not answer for at all ` +
        `(statement timeout — it needs sql/2026-09-07-position-query-indexes.sql)`,
    );
  }
  console.log(`  MISMATCHED:   ${mismatches.length}`);

  for (const m of mismatches.slice(0, 15)) {
    console.log(
      `    tokenId=${m.tokenId} tx=${m.txHash}\n` +
        `      envio  amount0=${m.amount0} amount1=${m.amount1}\n` +
        `      ponder amount0=${m.theirs.amount0} amount1=${m.theirs.amount1}\n` +
        `      relDiff0=${m.d0.toExponential(3)} relDiff1=${m.d1.toExponential(3)}`,
    );
  }
  if (mismatches.length > 15) console.log(`    ... and ${mismatches.length - 15} more`);
  if (mismatches.length > 0) hadFailure = true;
}

const compared = CHAINS.length - skipped.length;

console.log("");
if (hadFailure) {
  console.log("RESULT: DISAGREEMENT — do not cut over until explained.");
} else if (compared === 0) {
  console.log("RESULT: INCONCLUSIVE — no chain could be compared. This is NOT a pass.");
} else if (skipped.length > 0) {
  console.log(
    `RESULT: PARTIAL — ${compared}/${CHAINS.length} chain(s) agree; ` +
      `${skipped.length} could not be compared. This is NOT a full pass.`,
  );
} else {
  console.log(`RESULT: PASS — all ${compared} chain(s) agree beyond double precision.`);
}
for (const s of skipped) console.log(`  not compared: chain ${s.chainId} — ${s.reason}`);
console.log("");

// Exit 1 on disagreement, 2 when a chain could not be compared at all. A
// deploy gate must not read an unusable comparison as a green light.
process.exit(hadFailure ? 1 : skipped.length > 0 ? 2 : 0);
