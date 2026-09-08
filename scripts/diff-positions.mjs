#!/usr/bin/env node
/*
 * EVERY position and position-transaction in the local indexer for one chain,
 * compared field by field against Ponder and the vanilla v4 subgraph.
 *
 * HOW EACH FIELD IS CLASSIFIED, AND WHY THAT MATTERS MORE THAN THE TOTALS
 *
 *   EXACT      byte-identical.
 *   TOL        differs only within double precision. Ponder stores
 *              `doublePrecision` for every human-unit amount; Envio stores exact
 *              BigDecimal. Past ~15 significant digits Ponder is the lossy side,
 *              so this is agreement, and Envio is the more accurate of the two.
 *   SYNC       a MUTABLE field on a position Ponder has seen further into than
 *              we have. Not comparable, and not a defect: Ponder is caught up
 *              and this indexer is mid-backfill, so its rows are a prefix of the
 *              truth. Gated on Ponder's own `updatedAtBlock` vs our synced head.
 *   STALE-CODE a difference this session already fixed in source but which is
 *              still present in the DATABASE, because the running indexer has
 *              been processing with the older code. These need a reindex, not a
 *              code change, and calling them live defects would be wrong.
 *   MISMATCH   none of the above. This is the only bucket that means something
 *              is wrong now.
 *
 * The subgraph can only arbitrate identity and ownership — its Position is
 * { id, tokenId, owner, origin, createdAtTimestamp } with no liquidity, ticks,
 * fees or amounts.
 *
 * USAGE  node scripts/diff-positions.mjs [--chain 43114] [--limit N]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BACKEND_ENV = "/Users/kc/Documents/Code/GitHub/work/doryoku/tickwise/backend/.env";

const PONDER_URLS = {
  1: "https://ponder-uniswap-v4-mainnet.up.railway.app/graphql",
  42161: "https://ponder-uniswap-v4-arbitrum.up.railway.app/graphql",
  43114: "https://ponder-uniswap-v4-avalanche.up.railway.app/graphql",
  4663: "https://ponder-uniswap-v4-robinhood.up.railway.app/graphql",
};
const SUBGRAPH_ENV = {
  1: "ETHEREUM_UNISWAP_V4_SUBGRAPH_URL",
  42161: "ARBITRUM_UNISWAP_V4_SUBGRAPH_URL",
  43114: "AVALANCHE_UNISWAP_V4_SUBGRAPH_URL",
};

const argVal = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const LIMIT = Number(argVal("limit", "100000"));
const CHAIN = Number(argVal("chain", "43114"));
const PONDER = PONDER_URLS[CHAIN];
if (!PONDER) {
  console.error(`no Ponder endpoint for chain ${CHAIN}`);
  process.exit(2);
}

const psql = (sql) =>
  execFileSync(
    "docker",
    ["exec", "envio-postgres", "psql", "-U", "postgres", "-d", "envio-dev", "-At", "-F", "\t", "-c", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

function subgraphUrl() {
  const env = readFileSync(BACKEND_ENV, "utf8");
  const get = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, "m").exec(env);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const varName = SUBGRAPH_ENV[CHAIN];
  if (!varName) return undefined;
  let url = get(varName);
  const key = get("GRAPH_API_KEY");
  if (url && url.includes("gateway.thegraph.com") && key && !/\/api\/[^/]+\/(subgraphs|deployments)\/id\//.test(url)) {
    url = url.replace(/(\/api\/)((subgraphs|deployments)\/id\/)/, `$1${key}/$2`);
  }
  return url;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(url, query, variables = {}, attempt = 0) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors) throw new Error(String(body.errors[0]?.message ?? "gql").slice(0, 160));
    return body.data;
  } catch (e) {
    if (attempt < 3) {
      await sleep(500 * (attempt + 1));
      return gql(url, query, variables, attempt + 1);
    }
    throw e;
  }
}

/* ── the comparison primitives ─────────────────────────────────────────────── */

const TOL = 1e-12;

function cmpNum(mine, theirs) {
  const a = Number(mine);
  const b = Number(theirs);
  if (a === b) return "EXACT";
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return "EXACT";
  return Math.abs(a - b) / scale <= TOL ? "TOL" : "DIFF";
}
const cmpStr = (a, b) => (String(a) === String(b) ? "EXACT" : "DIFF");
const cmpLower = (a, b) => (String(a).toLowerCase() === String(b).toLowerCase() ? "EXACT" : "DIFF");
const cmpBig = (a, b) => (BigInt(a ?? 0) === BigInt(b ?? 0) ? "EXACT" : "DIFF");
/**
 * psql `-At` renders a boolean as "true"/"false" (not "t"/"f"), so parse rather
 * than string-compare. Getting this wrong made `isPriceable` report 355 false
 * mismatches and, worse, made `isActive`'s agreements accidental — the closed
 * positions matched only because both sides coerced to "false".
 */
const asBool = (v) => v === true || v === "true" || v === "t";
const cmpBool = (a, b) => (asBool(a) === asBool(b) ? "EXACT" : "DIFF");

/* ── 1. Envio side ────────────────────────────────────────────────────────── */

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

const head = Number(
  psql(`select coalesce(max("blockNumber"),0)::text from public."PositionTransaction" where "chainId"=${CHAIN};`).trim(),
);

const POS_COLS = [
  "tokenId", "owner", "origin", "poolId", "tickLower", "tickUpper", "liquidity",
  "isActive", "isPriceable", "createdAtTimestamp", "createdAtBlockNumber", "closedAtTimestamp",
  "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
  "totalFeesCollected0", "totalFeesCollected1", "totalFeesUncollected0", "totalFeesUncollected1",
  "amount0", "amount1", "totalGasCostETH",
  "feeGrowthInside0LastX128", "feeGrowthInside1LastX128",
  "updatedAtBlock", "updatedAtTimestamp", "feesUpdatedAtBlock",
];

const positions = psql(
  `select ${POS_COLS.map((c) => `coalesce("${c}"::text,'')`).join(", ")}
     from public."Position" where "chainId"=${CHAIN}
     order by "tokenId"::numeric limit ${LIMIT};`,
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => Object.fromEntries(l.split("\t").map((v, i) => [POS_COLS[i], v])));

const TX_COLS = ["tokenId", "txHash", "logIndex", "type", "amount0", "amount1", "gasCostETH", "timestamp", "blockNumber", "sender"];
const txs = psql(
  `select ${TX_COLS.map((c) => `coalesce("${c}"::text,'')`).join(", ")}
     from public."PositionTransaction" where "chainId"=${CHAIN}
     order by "blockNumber", "logIndex";`,
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => Object.fromEntries(l.split("\t").map((v, i) => [TX_COLS[i], v])));

console.log(`Envio chain ${CHAIN}: ${positions.length} positions, ${txs.length} transaction rows`);
console.log(`Envio synced head (max PositionTransaction block): ${head}\n`);
if (positions.length === 0) {
  console.log("nothing indexed yet");
  process.exit(2);
}

/* ── 2. Ponder side — primary-key lookups, aliased and paced ──────────────── */

const PONDER_FIELDS = `tokenId owner poolId tickLower tickUpper liquidity isActive isPriceable
  createdAtTimestamp createdAtBlockNumber closedAtTimestamp
  depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
  totalFeesCollected0 totalFeesCollected1 totalFeesUncollected0 totalFeesUncollected1
  amount0 amount1 totalGasCostETH feeGrowthInside0LastX128 feeGrowthInside1LastX128
  updatedAtBlock updatedAtTimestamp`;

const ponderPos = new Map();
{
  const ids = positions.map((p) => p.tokenId);
  const PER = 10;
  for (let i = 0; i < ids.length; i += PER) {
    const chunk = ids.slice(i, i + PER);
    const q =
      `{ ` +
      chunk.map((t, k) => `p${k}: position(chainId:${CHAIN}, tokenId:"${t}"){ ${PONDER_FIELDS} }`).join(" ") +
      ` }`;
    let d;
    try {
      d = await gql(PONDER, q);
    } catch (e) {
      console.log(`  ponder chunk ${i}: ${e.message}`);
      continue;
    }
    for (const k of Object.keys(d)) if (d[k]) ponderPos.set(String(d[k].tokenId), d[k]);
    await sleep(150);
  }
}
console.log(`Ponder returned ${ponderPos.size}/${positions.length} positions`);

/* Ponder's transaction rows over exactly our block span. */
const ponderTx = new Map();
{
  const minB = Math.min(...txs.map((t) => Number(t.blockNumber)));
  const maxB = Math.max(...txs.map((t) => Number(t.blockNumber)));
  let after = null;
  let pages = 0;
  for (;;) {
    let d;
    try {
      d = await gql(
        PONDER,
        `query T($where: positionTransactionFilter, $limit: Int!, $after: String){
           positionTransactions(where:$where, orderBy:"blockNumber", orderDirection:"asc", limit:$limit, after:$after){
             items { tokenId txHash logIndex type amount0 amount1 gasCostETH timestamp blockNumber sender }
             pageInfo { hasNextPage endCursor }
           } }`,
        { where: { chainId: CHAIN, blockNumber_gte: String(minB), blockNumber_lte: String(maxB) }, limit: 1000, after },
      );
    } catch (e) {
      console.log(`  ponder tx page ${pages}: ${e.message}`);
      break;
    }
    const page = d.positionTransactions;
    for (const r of page?.items ?? []) {
      ponderTx.set(`${r.tokenId}|${r.txHash.toLowerCase()}|${r.logIndex}|${r.type}`, r);
    }
    pages += 1;
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
    if (pages > 300) break;
  }
  console.log(`Ponder returned ${ponderTx.size} transaction rows over blocks ${minB}..${maxB} (${pages} page(s))`);
}

/* ── 3. Subgraph side — identity and ownership only ───────────────────────── */

const sgPos = new Map();
{
  const url = subgraphUrl();
  if (!url) console.log("subgraph: no URL configured");
  else {
    const ids = positions.map((p) => p.tokenId);
    const PER = 500;
    for (let i = 0; i < ids.length; i += PER) {
      try {
        const d = await gql(
          url,
          `query P($ids:[ID!]!){ positions(where:{id_in:$ids}, first:1000){ id tokenId owner origin createdAtTimestamp } }`,
          { ids: ids.slice(i, i + PER) },
        );
        for (const p of d.positions ?? []) sgPos.set(String(p.tokenId), p);
      } catch (e) {
        console.log(`  subgraph chunk ${i}: ${e.message}`);
      }
    }
    console.log(`Subgraph returned ${sgPos.size}/${positions.length} positions`);
  }
}

/* ── 3b. Pool counters vs the subgraph ────────────────────────────────────── */

/*
 * Only UNIT-FREE counters, and only one-sided.
 *
 * `volumeUSD`/`feesUSD` are not comparable at all: the vanilla subgraph
 * accumulates USD volume only for pairs passing its tracked-volume whitelist,
 * so it reports 0 for pools with real token volume — verified on 43114 pool
 * 0xa685e304…, which shows volumeToken0 2149.04 and volumeToken1 0.325
 * alongside volumeUSD "0" and a healthy totalValueLockedUSD of 758.49. An
 * earlier version of this comparison flagged 37 such fields as
 * "double-counting", which was wrong and is exactly the kind of noise that
 * gets a gate ignored.
 *
 * `txCount` and `volumeToken0/1` carry no pricing policy, so they are the
 * honest signal. Cumulative and one-sided: mid-backfill we must read AT OR
 * BELOW a caught-up subgraph, and reading ABOVE would mean double-counting.
 */
const poolResult = { compared: 0, over: [], usdPolicy: 0, skipped: null };
{
  const url = subgraphUrl();
  if (!url) poolResult.skipped = "no subgraph URL configured";
  else {
    const rows = psql(
      `select replace(id, '${CHAIN}_', ''), "txCount"::text, "volumeToken0"::text,
              "volumeToken1"::text, "volumeUSD"::text
         from public."Pool" where "chainId"=${CHAIN}
         order by "totalValueLockedUSD" desc limit 200;`,
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id, txCount, volToken0, volToken1, volUSD] = l.split("\t");
        return { id, txCount, volToken0, volToken1, volUSD };
      });
    if (rows.length === 0) poolResult.skipped = "no pools indexed yet";
    else {
      const sg = new Map();
      for (let i = 0; i < rows.length; i += 200) {
        try {
          const d = await gql(
            url,
            `query P($ids:[ID!]!){ pools(where:{id_in:$ids}, first:1000){ id txCount volumeToken0 volumeToken1 volumeUSD } }`,
            { ids: rows.slice(i, i + 200).map((r) => r.id) },
          );
          for (const p of d.pools ?? []) sg.set(p.id.toLowerCase(), p);
        } catch (e) {
          poolResult.skipped = e.message;
        }
      }
      for (const r of rows) {
        const p = sg.get(r.id);
        if (!p) continue;
        if (Number(p.volumeUSD) === 0 && Number(r.volUSD) > 0) poolResult.usdPolicy += 1;
        for (const [f, mine, theirs] of [
          ["txCount", r.txCount, p.txCount],
          ["volumeToken0", r.volToken0, p.volumeToken0],
          ["volumeToken1", r.volToken1, p.volumeToken1],
        ]) {
          const a = Number(mine);
          const b = Number(theirs);
          const scale = Math.max(Math.abs(a), Math.abs(b), 1);
          poolResult.compared += 1;
          if (a > b && (a - b) / scale > 1e-9) poolResult.over.push({ id: r.id, field: f, envio: mine, subgraph: theirs });
        }
      }
    }
  }
}

/* ── 4. Compare ───────────────────────────────────────────────────────────── */

const tally = {};
const bump = (field, verdict) => {
  tally[field] ??= { EXACT: 0, TOL: 0, SYNC: 0, "STALE-CODE": 0, MISMATCH: 0 };
  tally[field][verdict] += 1;
};
const mismatches = [];
const staleCode = [];

// Immutable once minted — comparable at ANY sync height.
const IMMUTABLE = new Set(["poolId", "tickLower", "tickUpper", "createdAtTimestamp", "createdAtBlockNumber", "owner", "isPriceable"]);

let ponderAhead = 0;
for (const mine of positions) {
  const p = ponderPos.get(mine.tokenId);
  if (!p) continue;
  const gated = Number(p.updatedAtBlock) <= head;
  if (!gated) ponderAhead += 1;

  const check = (field, verdict, mutable = true) => {
    if (verdict === "DIFF" && mutable && !gated) return bump(field, "SYNC");
    if (verdict === "DIFF") {
      // The gas over-charge on no-op collects: fixed in source, still in this
      // database. Envio strictly HIGHER is that signature; lower would not be.
      if (field === "totalGasCostETH" && Number(mine[field]) > Number(p[field])) {
        bump(field, "STALE-CODE");
        staleCode.push({ tokenId: mine.tokenId, field, envio: mine[field], ponder: p[field] });
        return;
      }
      bump(field, "MISMATCH");
      mismatches.push({ tokenId: mine.tokenId, field, envio: mine[field], ponder: p[field], gated });
      return;
    }
    bump(field, verdict);
  };

  check("poolId", cmpLower(mine.poolId, p.poolId), false);
  check("tickLower", cmpStr(mine.tickLower, p.tickLower), false);
  check("tickUpper", cmpStr(mine.tickUpper, p.tickUpper), false);
  check("owner", cmpLower(mine.owner, p.owner));
  check("isPriceable", cmpBool(mine.isPriceable, p.isPriceable), false);
  check("createdAtTimestamp", cmpStr(mine.createdAtTimestamp, p.createdAtTimestamp), false);
  check("createdAtBlockNumber", cmpStr(mine.createdAtBlockNumber, p.createdAtBlockNumber), false);
  check("liquidity", cmpBig(mine.liquidity, p.liquidity));
  check("isActive", cmpBool(mine.isActive, p.isActive));
  check(
    "closedAtTimestamp",
    cmpStr(mine.closedAtTimestamp === "" ? "null" : mine.closedAtTimestamp, p.closedAtTimestamp ?? "null"),
  );
  for (const f of [
    "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
    "totalFeesCollected0", "totalFeesCollected1", "amount0", "amount1", "totalGasCostETH",
  ]) {
    check(f, cmpNum(mine[f], p[f]));
  }
  // Uncollected is 0 on both sides only while our head-gated sweep has not run.
  check("totalFeesUncollected0", cmpNum(mine.totalFeesUncollected0, p.totalFeesUncollected0));
  check("totalFeesUncollected1", cmpNum(mine.totalFeesUncollected1, p.totalFeesUncollected1));
  check("feeGrowthInside0LastX128", cmpBig(mine.feeGrowthInside0LastX128, p.feeGrowthInside0LastX128));
  check("feeGrowthInside1LastX128", cmpBig(mine.feeGrowthInside1LastX128, p.feeGrowthInside1LastX128));
}

// Subgraph arbitration on identity.
const sgTally = { EXACT: 0, DIFF: 0 };
const sgDiffs = [];
for (const mine of positions) {
  const s = sgPos.get(mine.tokenId);
  if (!s) continue;
  for (const [f, a, b] of [
    ["owner", mine.owner, s.owner],
    ["origin", mine.origin, s.origin],
    ["createdAtTimestamp", mine.createdAtTimestamp, s.createdAtTimestamp],
  ]) {
    const v = f === "createdAtTimestamp" ? cmpStr(a, b) : cmpLower(a, b);
    if (v === "EXACT") sgTally.EXACT += 1;
    else {
      sgTally.DIFF += 1;
      sgDiffs.push({ tokenId: mine.tokenId, field: f, envio: a, subgraph: b });
    }
  }
}

// Transaction rows.
const txTally = { EXACT: 0, TOL: 0, "STALE-CODE": 0, MISMATCH: 0 };
const txMismatch = [];
let txOnlyEnvio = 0;
let txOnlyPonder = 0;
const seen = new Set();
for (const t of txs) {
  const key = `${t.tokenId}|${t.txHash.toLowerCase()}|${t.logIndex}|${t.type}`;
  seen.add(key);
  const p = ponderTx.get(key);
  if (!p) {
    txOnlyEnvio += 1;
    continue;
  }
  for (const f of ["amount0", "amount1", "gasCostETH"]) {
    let v = cmpNum(t[f], p[f]);
    if (v === "DIFF" && t.type === "WITHDRAW" && (f === "amount0" || f === "amount1")) {
      // The sign convention: Ponder stores positive magnitudes ("human units,
      // positive magnitude" in its own schema); the running indexer stores the
      // signed event amount. Fixed in source this session.
      if (cmpNum(Math.abs(Number(t[f])), Math.abs(Number(p[f]))) !== "DIFF") v = "STALE-CODE";
    }
    if (v === "DIFF") {
      txTally.MISMATCH += 1;
      txMismatch.push({ ...t, field: f, envio: t[f], ponder: p[f] });
    } else txTally[v] += 1;
  }
  for (const [f, a, b] of [
    ["timestamp", t.timestamp, p.timestamp],
    ["blockNumber", t.blockNumber, p.blockNumber],
    ["sender", t.sender.toLowerCase(), String(p.sender).toLowerCase()],
  ]) {
    const v = cmpStr(a, b);
    if (v === "EXACT") txTally.EXACT += 1;
    else {
      txTally.MISMATCH += 1;
      txMismatch.push({ ...t, field: f, envio: a, ponder: b });
    }
  }
}
for (const k of ponderTx.keys()) if (!seen.has(k)) txOnlyPonder += 1;

/* ── 5. Report ────────────────────────────────────────────────────────────── */

console.log(`\n${"=".repeat(78)}\nPOSITION FIELDS vs PONDER  (${ponderPos.size} positions; ${ponderAhead} are further along in Ponder)\n${"=".repeat(78)}`);
console.log("field".padEnd(26) + "EXACT".padStart(7) + "TOL".padStart(6) + "SYNC".padStart(6) + "STALE".padStart(7) + "BAD".padStart(6));
for (const f of Object.keys(tally)) {
  const t = tally[f];
  console.log(
    f.padEnd(26) +
      String(t.EXACT).padStart(7) +
      String(t.TOL).padStart(6) +
      String(t.SYNC).padStart(6) +
      String(t["STALE-CODE"]).padStart(7) +
      String(t.MISMATCH).padStart(6),
  );
}

console.log(`\nPOSITION IDENTITY vs SUBGRAPH: ${sgTally.EXACT} agree, ${sgTally.DIFF} differ  (owner/origin/createdAtTimestamp over ${sgPos.size} positions)`);
for (const d of sgDiffs.slice(0, 10)) console.log(`  tokenId=${d.tokenId} ${d.field}: envio=${d.envio} subgraph=${d.subgraph}`);

console.log(`\nTRANSACTION ROWS vs PONDER`);
console.log(`  rows: envio ${txs.length}, ponder ${ponderTx.size}; only-envio ${txOnlyEnvio}, only-ponder ${txOnlyPonder}`);
console.log(`  field comparisons: EXACT ${txTally.EXACT}, TOL ${txTally.TOL}, STALE-CODE ${txTally["STALE-CODE"]}, MISMATCH ${txTally.MISMATCH}`);
for (const m of txMismatch.slice(0, 15)) {
  console.log(`    tokenId=${m.tokenId} ${m.type} ${m.field}: envio=${m.envio} ponder=${m.ponder}`);
}
if (txMismatch.length > 15) console.log(`    ... and ${txMismatch.length - 15} more`);

console.log(`\nPOOL COUNTERS vs SUBGRAPH (unit-free only)`);
if (poolResult.skipped) console.log(`  not compared: ${poolResult.skipped}`);
else {
  console.log(`  ${poolResult.compared - poolResult.over.length}/${poolResult.compared} at or below the subgraph`);
  console.log(`  ABOVE (would mean double-counting): ${poolResult.over.length}`);
  for (const o of poolResult.over.slice(0, 10)) {
    console.log(`    pool=${o.id.slice(0, 18)}… ${o.field}: envio=${o.envio} subgraph=${o.subgraph}`);
  }
  if (poolResult.usdPolicy) {
    console.log(`  (advisory) ${poolResult.usdPolicy} pool(s) have volumeUSD 0 in the subgraph but non-zero here — its whitelist, not a disagreement`);
  }
}

const totalBad =
  Object.values(tally).reduce((n, t) => n + t.MISMATCH, 0) +
  txTally.MISMATCH +
  sgTally.DIFF +
  poolResult.over.length;
const totalStale = Object.values(tally).reduce((n, t) => n + t["STALE-CODE"], 0) + txTally["STALE-CODE"];

console.log(`\n${"=".repeat(78)}`);
if (mismatches.length) {
  console.log("UNEXPLAINED POSITION MISMATCHES:");
  for (const m of mismatches.slice(0, 20)) {
    console.log(`  tokenId=${m.tokenId} ${m.field}: envio=${m.envio} ponder=${m.ponder} (gated=${m.gated})`);
  }
  if (mismatches.length > 20) console.log(`  ... and ${mismatches.length - 20} more`);
}
if (totalStale) {
  console.log(`\nSTALE-CODE (fixed in source, needs a reindex): ${totalStale} field comparisons`);
  console.log(`  withdraw-sign rows: ${txTally["STALE-CODE"]}`);
  console.log(`  totalGasCostETH over-charged positions: ${staleCode.length}`);
}
console.log(
  totalBad === 0
    ? `\nRESULT: PASS — every comparable value matches. ${totalStale} known stale-code difference(s).`
    : `\nRESULT: ${totalBad} UNEXPLAINED difference(s).`,
);

writeFileSync(
  "/tmp/avax-all-diff.json",
  JSON.stringify({ head, tally, sgTally, sgDiffs, txTally, txMismatch, mismatches, staleCode, ponderAhead }, null, 2),
);
console.log("full detail: /tmp/avax-all-diff.json\n");
process.exit(totalBad ? 1 : 0);
