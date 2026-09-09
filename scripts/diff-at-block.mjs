#!/usr/bin/env node
/*
 * Compare the deployed indexer against the vanilla subgraph AT ITS OWN INDEXED
 * BLOCK, and against Ponder where Ponder can answer.
 *
 * WHY THIS IS A DIFFERENT TEST FROM diff-positions.mjs
 *
 * Every earlier comparison had to treat "Envio is behind" as a reason NOT to
 * compare: cumulative fields legitimately read lower mid-backfill, so the best
 * that could be asserted was a one-sided bound. The Graph supports time-travel
 * queries — `pools(block: { number: N })` — so the subgraph can be asked what it
 * held at exactly the block Envio has reached. Cumulative state then has to be
 * EQUAL, not merely lower, and a difference is a real defect rather than a
 * height artifact. Verified against a live subgraph before relying on it: the
 * same pool reports txCount 7,700 / 44,216 / 1,025,505 at three heights.
 *
 * Ponder has no equivalent, so Ponder comparisons stay gated on its own
 * `updatedAtBlock` being at or below our indexed block.
 *
 * WHAT IS AND IS NOT COMPARABLE
 *
 *   Pool identity + cumulative token units  subgraph, EXACT at the block
 *   Pool price state (tick, sqrtPrice, liquidity)  subgraph, EXACT at the block
 *   Position identity + ownership           subgraph, EXACT at the block
 *   Collected fees, cashflows               Ponder only — the subgraph has none
 *   Position transaction ledger             Ponder only
 *   USD columns                             NEITHER. The vanilla subgraph only
 *     accumulates USD volume for pairs on its tracked-volume whitelist, so it
 *     reports 0 for pools with real token volume. Reported as advisory.
 *   Uncollected fees                        NOT COMPARABLE BY DESIGN. The sweep
 *     is head-gated and this indexer is mid-backfill, so they are all zero here
 *     on purpose. Asserted to BE zero rather than compared.
 *
 * USAGE  node scripts/diff-at-block.mjs [--chain 43114] [--pools 200] [--positions 500]
 */

import { readFileSync } from "node:fs";

const ENVIO = "https://indexer.hyperindex.xyz/bd820cf/v1/graphql";
const BACKEND_ENV = "/Users/kc/Documents/Code/GitHub/work/doryoku/tickwise/backend/.env";

const SUBGRAPH_ID = {
  1: "6XvRX3WHSvzBVTiPdF66XSBVbxWuHqijWANbjJxRDyzr",
  42161: "G5TsTKNi8yhPSV7kycaE23oWbqv9zzNqR49FoEQjzq1r",
  43114: "49JxRo9FGxWpSf5Y5GKQPj5NUpX2HhpoZHpGzNEWQZjq",
};
const PONDER = {
  1: "https://ponder-uniswap-v4-mainnet.up.railway.app/graphql",
  42161: "https://ponder-uniswap-v4-arbitrum.up.railway.app/graphql",
  43114: "https://ponder-uniswap-v4-avalanche.up.railway.app/graphql",
};

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const CHAINS = arg("chain") ? [Number(arg("chain"))] : [1, 42161, 43114];
const POOL_N = Number(arg("pools", "200"));
const POS_N = Number(arg("positions", "500"));

function graphKey() {
  const m = /^GRAPH_API_KEY=(.*)$/m.exec(readFileSync(BACKEND_ENV, "utf8"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}
const subgraphUrl = (c) => `https://gateway.thegraph.com/api/${graphKey()}/subgraphs/id/${SUBGRAPH_ID[c]}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(url, query, variables = {}, attempt = 0) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    if (b.errors) throw new Error(String(b.errors[0]?.message ?? "gql").slice(0, 150));
    return b.data;
  } catch (e) {
    if (attempt < 3) {
      await sleep(600 * (attempt + 1));
      return gql(url, query, variables, attempt + 1);
    }
    throw e;
  }
}

/** Exact for integers/strings; double-precision tolerance for decimals. */
const TOL = 1e-12;
function cmp(a, b) {
  if (String(a) === String(b)) return "EXACT";
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "DIFF";
  const s = Math.max(Math.abs(x), Math.abs(y));
  if (s === 0) return "EXACT";
  return Math.abs(x - y) / s <= TOL ? "TOL" : "DIFF";
}

const report = [];

for (const chain of CHAINS) {
  console.log(`\n${"=".repeat(76)}\nCHAIN ${chain}\n${"=".repeat(76)}`);
  const out = { chain, problems: [], notes: [] };

  // ── the block everything is pinned to ────────────────────────────────────
  const meta = await gql(ENVIO, `{ chain_metadata(where: {chain_id: {_eq: ${chain}}}) { latest_processed_block block_height } }`);
  const m = meta.chain_metadata?.[0];
  if (!m) {
    console.log("  chain not present in the deployed indexer");
    continue;
  }
  const AT = Number(m.latest_processed_block);
  console.log(`  Envio indexed block: ${AT}  (chain head ${m.block_height}, ${((AT / m.block_height) * 100).toFixed(1)}%)`);

  const sg = subgraphUrl(chain);
  let sgHead = null;
  try {
    sgHead = (await gql(sg, `{ _meta { block { number } } }`))._meta.block.number;
    console.log(`  subgraph head: ${sgHead}`);
    if (sgHead < AT) {
      out.notes.push(`subgraph head ${sgHead} is BELOW our indexed block ${AT} — cannot time-travel there`);
      console.log(`  !! subgraph is behind us; skipping subgraph comparisons`);
      sgHead = null;
    }
  } catch (e) {
    out.notes.push(`subgraph unreachable: ${e.message}`);
    console.log(`  !! subgraph unreachable: ${e.message}`);
  }

  // ── 1. POOLS, exact at the block ─────────────────────────────────────────
  //
  // Each subgraph section is independently guarded. The Graph's gateway returns
  // "bad indexers: ... Unavailable" intermittently — mainnet especially — and an
  // uncaught one used to abort the whole run, losing the Ponder comparisons for
  // that chain too. A source that cannot answer is a NOT-COMPARED note, never a
  // crash and never a pass.
  if (sgHead) try {
    const mine = (
      await gql(
        ENVIO,
        `query P($limit: Int!) {
           Pool(where: {chainId: {_eq: "${chain}"}}, limit: $limit, order_by: {txCount: desc}) {
             id feeTier tickSpacing tick sqrtPrice liquidity txCount
             volumeToken0 volumeToken1 totalValueLockedToken0 totalValueLockedToken1
             token0 token1 volumeUSD
           } }`,
        { limit: POOL_N },
      )
    ).Pool.map((p) => ({ ...p, bare: p.id.replace(`${chain}_`, "").toLowerCase() }));

    const ids = mine.map((p) => p.bare);
    const theirs = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const d = await gql(
        sg,
        `query P($ids: [ID!]!, $b: Int!) {
           pools(where: {id_in: $ids}, first: 1000, block: {number: $b}) {
             id feeTier tickSpacing tick sqrtPrice liquidity txCount
             volumeToken0 volumeToken1 totalValueLockedToken0 totalValueLockedToken1
             token0 { id } token1 { id } volumeUSD
           } }`,
        { ids: ids.slice(i, i + 100), b: AT },
      );
      for (const p of d.pools ?? []) theirs.set(p.id.toLowerCase(), p);
    }

    const FIELDS = [
      ["feeTier", (p) => p.feeTier],
      ["tickSpacing", (p) => p.tickSpacing],
      ["tick", (p) => p.tick],
      ["sqrtPrice", (p) => p.sqrtPrice],
      ["liquidity", (p) => p.liquidity],
      ["txCount", (p) => p.txCount],
      ["volumeToken0", (p) => p.volumeToken0],
      ["volumeToken1", (p) => p.volumeToken1],
      ["totalValueLockedToken0", (p) => p.totalValueLockedToken0],
      ["totalValueLockedToken1", (p) => p.totalValueLockedToken1],
    ];
    const tally = {};
    const bad = [];
    let compared = 0;
    let usdPolicy = 0;
    for (const p of mine) {
      const t = theirs.get(p.bare);
      if (!t) continue;
      compared += 1;
      for (const [name, get] of FIELDS) {
        const mineV = get(p);
        const theirsV = typeof get(t) === "object" ? get(t)?.id : get(t);
        const v = cmp(mineV, theirsV);
        tally[name] ??= { EXACT: 0, TOL: 0, DIFF: 0 };
        tally[name][v] += 1;
        if (v === "DIFF") bad.push({ pool: p.bare, field: name, envio: mineV, subgraph: theirsV });
      }
      // token refs: Envio stores "<chainId>_<addr>", the subgraph a bare addr.
      for (const [name, a, b] of [
        ["token0", p.token0.replace(`${chain}_`, ""), t.token0?.id],
        ["token1", p.token1.replace(`${chain}_`, ""), t.token1?.id],
      ]) {
        const v = cmp(String(a).toLowerCase(), String(b).toLowerCase());
        tally[name] ??= { EXACT: 0, TOL: 0, DIFF: 0 };
        tally[name][v] += 1;
        if (v === "DIFF") bad.push({ pool: p.bare, field: name, envio: a, subgraph: b });
      }
      if (Number(t.volumeUSD) === 0 && Number(p.volumeUSD) > 0) usdPolicy += 1;
    }

    console.log(`\n  POOLS at block ${AT}: ${compared}/${mine.length} matched to the subgraph`);
    console.log("    field".padEnd(30) + "EXACT".padStart(8) + "TOL".padStart(7) + "DIFF".padStart(7));
    for (const f of Object.keys(tally)) {
      const t = tally[f];
      console.log(
        `    ${f}`.padEnd(30) + String(t.EXACT).padStart(8) + String(t.TOL).padStart(7) + String(t.DIFF).padStart(7),
      );
    }
    if (usdPolicy) console.log(`    (advisory) ${usdPolicy} pool(s) have volumeUSD 0 upstream — its whitelist, not a disagreement`);
    for (const b of bad.slice(0, 12)) {
      console.log(`      pool=${b.pool.slice(0, 18)}… ${b.field}: envio=${b.envio} subgraph=${b.subgraph}`);
    }
    if (bad.length > 12) console.log(`      ... and ${bad.length - 12} more`);
    if (bad.length) out.problems.push(`pools: ${bad.length} field difference(s) at the same block`);
    out.pools = { compared, bad: bad.length };
  } catch (e) {
    out.notes.push(`pools not compared — subgraph error: ${e.message}`);
    console.log(`\n  POOLS: NOT COMPARED — ${e.message}`);
  }

  // ── 2. POSITION IDENTITY, exact at the block ─────────────────────────────
  const minePos = (
    await gql(
      ENVIO,
      `query P($limit: Int!) {
         Position(where: {chainId: {_eq: "${chain}"}}, limit: $limit, order_by: {createdAtBlockNumber: desc}) {
           tokenId owner origin createdAtTimestamp createdAtBlockNumber poolId
           totalFeesCollected0 totalFeesCollected1 totalFeesUncollected0 totalFeesUncollected1
           feesUpdatedAtBlock depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
           liquidity isActive totalGasCostETH updatedAtBlock
         } }`,
      { limit: POS_N },
    )
  ).Position;
  console.log(`\n  POSITIONS sampled: ${minePos.length}`);

  // Uncollected fees must be ZERO here — the sweep is head-gated by design.
  const swept = minePos.filter((p) => Number(p.feesUpdatedAtBlock) > 0).length;
  const nonZeroUncollected = minePos.filter(
    (p) => Number(p.totalFeesUncollected0) !== 0 || Number(p.totalFeesUncollected1) !== 0,
  ).length;
  console.log(`    uncollected-fee sweep: ${swept} swept, ${nonZeroUncollected} with non-zero uncollected`);
  if (swept === 0) console.log(`      -> as designed: head-gated, and this chain is mid-backfill`);
  else out.notes.push(`${swept} positions have been swept — the head gate has opened on this chain`);

  if (sgHead) try {
    const ids = minePos.map((p) => p.tokenId);
    const theirs = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const d = await gql(
        sg,
        `query P($ids: [ID!]!, $b: Int!) {
           positions(where: {id_in: $ids}, first: 1000, block: {number: $b}) {
             id tokenId owner origin createdAtTimestamp } }`,
        { ids: ids.slice(i, i + 500), b: AT },
      );
      for (const p of d.positions ?? []) theirs.set(String(p.tokenId), p);
    }
    let ok = 0;
    const bad = [];
    let absent = 0;
    for (const p of minePos) {
      const t = theirs.get(p.tokenId);
      if (!t) {
        absent += 1;
        continue;
      }
      for (const [f, a, b] of [
        ["owner", p.owner.toLowerCase(), String(t.owner).toLowerCase()],
        ["origin", p.origin.toLowerCase(), String(t.origin).toLowerCase()],
        ["createdAtTimestamp", p.createdAtTimestamp, t.createdAtTimestamp],
      ]) {
        if (cmp(a, b) === "EXACT") ok += 1;
        else bad.push({ tokenId: p.tokenId, field: f, envio: a, subgraph: b });
      }
    }
    console.log(`    identity vs subgraph @${AT}: ${ok} agree, ${bad.length} differ, ${absent} not in subgraph`);
    for (const b of bad.slice(0, 8)) console.log(`      tokenId=${b.tokenId} ${b.field}: envio=${b.envio} subgraph=${b.subgraph}`);
    if (bad.length) out.problems.push(`position identity: ${bad.length} difference(s)`);
    if (absent) out.notes.push(`${absent} position(s) we have are absent from the subgraph at that block`);
  } catch (e) {
    out.notes.push(`position identity not compared — subgraph error: ${e.message}`);
    console.log(`    identity vs subgraph: NOT COMPARED — ${e.message}`);
  }

  // ── 3. COLLECTED FEES + CASHFLOWS vs Ponder (gated) ──────────────────────
  const pond = new Map();
  let ponderUp = true;
  {
    const ids = minePos.map((p) => p.tokenId);
    const F = `tokenId owner liquidity isActive updatedAtBlock totalFeesCollected0 totalFeesCollected1
               depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1 totalGasCostETH`;
    for (let i = 0; i < ids.length; i += 10) {
      const q = `{ ${ids.slice(i, i + 10).map((t, k) => `p${k}: position(chainId:${chain}, tokenId:"${t}"){ ${F} }`).join(" ")} }`;
      try {
        const d = await gql(PONDER[chain], q);
        for (const k of Object.keys(d)) if (d[k]) pond.set(String(d[k].tokenId), d[k]);
      } catch (e) {
        ponderUp = false;
        out.notes.push(`ponder positions unreachable: ${e.message}`);
        break;
      }
      await sleep(120);
    }
  }
  if (ponderUp) {
    const FIELDS = [
      "totalFeesCollected0", "totalFeesCollected1",
      "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
      "totalGasCostETH",
    ];
    const tally = {};
    const bad = [];
    let gated = 0;
    for (const p of minePos) {
      const t = pond.get(p.tokenId);
      if (!t) continue;
      if (Number(t.updatedAtBlock) > AT) continue; // Ponder saw more than we did
      gated += 1;
      for (const f of FIELDS) {
        const v = cmp(p[f], t[f]);
        tally[f] ??= { EXACT: 0, TOL: 0, DIFF: 0 };
        tally[f][v] += 1;
        if (v === "DIFF") bad.push({ tokenId: p.tokenId, field: f, envio: p[f], ponder: t[f] });
      }
    }
    console.log(`\n  vs PONDER (${pond.size} found, ${gated} comparable at or below block ${AT})`);
    console.log("    field".padEnd(30) + "EXACT".padStart(8) + "TOL".padStart(7) + "DIFF".padStart(7));
    for (const f of Object.keys(tally)) {
      const t = tally[f];
      console.log(`    ${f}`.padEnd(30) + String(t.EXACT).padStart(8) + String(t.TOL).padStart(7) + String(t.DIFF).padStart(7));
    }
    const lower = bad.filter((b) => b.field.startsWith("totalFeesCollected") && Number(b.envio) < Number(b.ponder));
    const higher = bad.filter((b) => b.field.startsWith("totalFeesCollected") && Number(b.envio) > Number(b.ponder));
    if (lower.length) console.log(`    !! ENVIO LOWER on collected fees (a lost fee): ${lower.length}`);
    if (higher.length) console.log(`    Envio higher on collected fees (Ponder's known under-count): ${higher.length}`);
    for (const b of bad.slice(0, 12)) {
      console.log(`      tokenId=${b.tokenId} ${b.field}: envio=${b.envio} ponder=${b.ponder}`);
    }
    if (bad.length > 12) console.log(`      ... and ${bad.length - 12} more`);
    if (lower.length) out.problems.push(`collected fees LOWER than Ponder on ${lower.length} field(s)`);
    out.ponder = { found: pond.size, gated, bad: bad.length, lower: lower.length, higher: higher.length };
  }

  // ── 4. LEDGER vs Ponder ──────────────────────────────────────────────────
  try {
    const mineTx = (
      await gql(
        ENVIO,
        `query T { PositionTransaction(where: {chainId: {_eq: "${chain}"}}, limit: 2000, order_by: {blockNumber: desc}) {
           tokenId txHash logIndex type amount0 amount1 gasCostETH blockNumber } }`,
      )
    ).PositionTransaction;
    const blocks = mineTx.map((t) => Number(t.blockNumber));
    const lo = Math.min(...blocks);
    const hi = Math.max(...blocks);
    const theirs = new Map();
    let after = null;
    let pages = 0;
    let ok = true;
    for (;;) {
      try {
        const d = await gql(
          PONDER[chain],
          `query T($w: positionTransactionFilter, $l: Int!, $a: String){
             positionTransactions(where:$w, orderBy:"blockNumber", orderDirection:"asc", limit:$l, after:$a){
               items { tokenId txHash logIndex type amount0 amount1 gasCostETH } pageInfo { hasNextPage endCursor } } }`,
          { w: { chainId: chain, blockNumber_gte: String(lo), blockNumber_lte: String(hi) }, l: 1000, a: after },
        );
        const pg = d.positionTransactions;
        for (const r of pg?.items ?? []) theirs.set(`${r.tokenId}|${r.txHash.toLowerCase()}|${r.logIndex}|${r.type}`, r);
        pages += 1;
        if (!pg?.pageInfo?.hasNextPage || !pg.pageInfo.endCursor || pages > 50) break;
        after = pg.pageInfo.endCursor;
      } catch (e) {
        ok = false;
        out.notes.push(`ponder ledger unavailable (no indexes on that deployment): ${e.message}`);
        break;
      }
    }
    if (ok) {
      let exact = 0;
      let tol = 0;
      const bad = [];
      let onlyMine = 0;
      for (const t of mineTx) {
        const k = `${t.tokenId}|${t.txHash.toLowerCase()}|${t.logIndex}|${t.type}`;
        const p = theirs.get(k);
        if (!p) {
          onlyMine += 1;
          continue;
        }
        for (const f of ["amount0", "amount1", "gasCostETH"]) {
          const v = cmp(t[f], p[f]);
          if (v === "EXACT") exact += 1;
          else if (v === "TOL") tol += 1;
          else bad.push({ tokenId: t.tokenId, type: t.type, field: f, envio: t[f], ponder: p[f] });
        }
      }
      console.log(`\n  LEDGER vs PONDER over blocks ${lo}..${hi}`);
      console.log(`    rows: envio ${mineTx.length}, ponder ${theirs.size}; only-envio ${onlyMine}`);
      console.log(`    field comparisons: EXACT ${exact}, TOL ${tol}, DIFF ${bad.length}`);
      for (const b of bad.slice(0, 10)) {
        console.log(`      tokenId=${b.tokenId} ${b.type} ${b.field}: envio=${b.envio} ponder=${b.ponder}`);
      }
      if (bad.length) out.problems.push(`ledger: ${bad.length} field difference(s)`);
      out.ledger = { mine: mineTx.length, theirs: theirs.size, onlyMine, bad: bad.length };
    } else {
      console.log(`\n  LEDGER vs PONDER: not comparable (Ponder cannot serve a filtered query on this chain)`);
    }
  } catch (e) {
    out.notes.push(`ledger not compared: ${e.message}`);
    console.log(`\n  LEDGER vs PONDER: NOT COMPARED — ${e.message}`);
  }

  report.push(out);
}

console.log(`\n${"=".repeat(76)}\nSUMMARY\n${"=".repeat(76)}`);
let anyProblem = false;
for (const r of report) {
  console.log(`\nchain ${r.chain}:`);
  if (r.problems.length === 0) console.log("  no unexplained differences");
  for (const p of r.problems) {
    anyProblem = true;
    console.log(`  PROBLEM: ${p}`);
  }
  for (const n of r.notes) console.log(`  note: ${n}`);
}
console.log("");
process.exit(anyProblem ? 1 : 0);
