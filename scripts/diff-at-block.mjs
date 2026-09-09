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
 *   Pool identity, price state, volume      subgraph, at the block
 *     (feeTier, tickSpacing, tick, sqrtPrice, liquidity, txCount, volumeToken0/1,
 *     token refs) — a difference in ANY of these is a defect and FAILS, subject
 *     to `cmp`'s 1e-12 RELATIVE floor. That floor is not free on the wide
 *     integers: sqrtPrice is a uint160 and liquidity a uint128, so a drift of
 *     ~1e16 units on a 29-digit sqrtPrice is ~1e-13 relative and lands in TOL,
 *     not DIFF. The floor exists because Ponder types its numerics as `Float`
 *     (see `cmp`), and it is applied uniformly rather than per-source. Read TOL
 *     on these two fields as "agrees to 12 significant digits", not "identical".
 *   Position identity + ownership           subgraph, EXACT at the block
 *   Collected fees, cashflows               Ponder only — the subgraph has none
 *   Position transaction ledger             Ponder only
 *   totalValueLockedToken0/1                NOT COMPARED, at all. The deployed
 *     subgraph predates v4-subgraph #20 (05558b0) and computes these through the
 *     OLD getAmount0/getAmount1; this fork is post-#20. The two sides are not
 *     computing the same quantity, so there is nothing to compare — see
 *     `PRE20_FIELDS`. The skipped count is printed every run.
 *   USD columns                             NEITHER. The vanilla subgraph only
 *     accumulates USD volume for pairs on its tracked-volume whitelist, so it
 *     reports 0 for pools with real token volume. Reported as advisory.
 *   Uncollected fees                        NOT COMPARABLE against an external
 *     reference — neither the subgraph nor Ponder holds them at our block — but
 *     GATED INTERNALLY, against our own data. The sweep is the ONLY writer of
 *     both `totalFeesUncollected*` and `feesUpdatedAtBlock`, so one cannot exist
 *     without the other: a readable NON-ZERO uncollected figure on a position
 *     whose readable `feesUpdatedAtBlock` is 0 is a self-contradiction and FAILS
 *     (exit 1). A value that will not parse as a number is a MISSING
 *     MEASUREMENT, not a disagreement, and records a 2 — the same call the
 *     Ponder height gate makes for an unpositionable reference read.
 *
 * EXIT CODES — the same tri-state diff-collected-fees.mjs uses
 *
 *   0  PASS          every dimension ran, and every difference it measured
 *                    agrees or is explained
 *   1  FAIL          a real disagreement was measured
 *   2  INCONCLUSIVE  a source was unreachable, a chain was skipped, or a
 *                    dimension had zero comparisons — nothing was measured
 *
 * WHAT A 0 DOES AND DOES NOT COVER — read this before treating one as a
 * cut-over signal. Row-set coverage is gated in ONE place only: the Ponder
 * ledger, where BOTH directions (rows only we hold, rows only Ponder holds
 * inside our own compared block range) fail the run, over the full block span
 * of the rows we fetched — the lowest block included, because it is completed
 * by a second pinned query rather than skipped. The subgraph joins are
 * value comparisons over the intersection: pools we hold that the subgraph
 * lacks at that block are skipped, positions absent upstream are a note, and
 * neither side is asked for rows the other never mentioned. Uncollected fees
 * are gated against our own sweep invariant, not against a reference, and a
 * position whose sweep fields cannot be READ is a 2, not a 1 — nothing was
 * measured there. `totalValueLockedToken0/1` are NOT COMPARED AT ALL against
 * this subgraph deployment (see `PRE20_FIELDS`); a 0 says nothing whatever
 * about them, which is why the skipped count prints on its own line above the
 * RESULT. Value comparisons carry a 1e-12 RELATIVE floor forced by Ponder's
 * Float typing — see `cmp`. So a 0 means "every dimension ran and the values it
 * could line up agree to within that floor", not "the two datasets are proven
 * identical".
 *
 * The 2 exists because the first version of this script could not express it.
 * Every skip pushed a sentence into `notes`, only `problems` fed the exit code,
 * and `notes` was consumed by nothing but a console.log — so with EVERY
 * external reference dead the run printed "no unexplained differences" and
 * exited 0. A gate that reports OK when it never ran is worse than no gate.
 *
 * Skips are therefore recorded as STRUCTURED entries — `cannotCompare(site,
 * reason)` appends `{ site, reason }` to `out.inconclusive` — and never as free
 * text to be matched later. A regex over prose downgrades a run to PASS the
 * first time someone rewords a note, which is the same silent-success failure
 * in a new costume. `notes` now carries only advisories that are NOT skips.
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

/*
 * A NUMBER, OR NOTHING — never a laundered zero.
 *
 * `Number(null)`, `Number("")`, `Number("   ")`, `Number(false)` and
 * `Number([])` are ALL 0. Every one of those is a read that returned NO VALUE,
 * and any place that asks `Number(x) === 0` is therefore also asking "did this
 * read fail?" and answering "no, it's a zero".
 *
 * That is not academic. The Ponder triage below excuses exactly one shape —
 * `ponder === 0` while we hold a fee — because Ponder's `isTraceCapabilityError`
 * misclassification makes it record a genuine numeric ZERO. A null is a BROKEN
 * READ, and the excuse does not cover it. Coercing one into the other moved a
 * failure into the excused bucket and passed the run.
 *
 * `numOrNull` returns a finite number or `null`, and callers must handle the
 * `null` explicitly. Use it for any value whose ZERO carries meaning.
 *
 * It is declared HERE, above `cmp`, because `cmp` is one of those callers — see
 * the note there. It used to sit below `cmp`, which is precisely how the one
 * `Number(x) === 0` that mattered most escaped the sweep.
 */
function numOrNull(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null; // null, undefined, boolean, object, array
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/*
 * A READ THAT RETURNED NOTHING, as opposed to a value that is not a number.
 *
 * `numOrNull` collapses two different things into `null`: a no-value read
 * (`null`, `undefined`, `false`, `[]`, `""`, `"   "`, `NaN`) and a real STRING
 * value that simply is not numeric. The second is a legitimate value that
 * compares by text — a token address, an enum — and must still be able to come
 * back EXACT. Only the first is a broken read.
 */
const isNoValue = (v) => numOrNull(v) === null && !(typeof v === "string" && v.trim() !== "");

/*
 * Exact for integers/strings; double-precision tolerance for decimals.
 *
 * A NO-VALUE ON EITHER SIDE CAN NEVER BE "EXACT", AND THAT CHECK IS FIRST.
 * `s === 0` below is the single most dangerous `Number(x) === 0` in this file,
 * because `cmp` sits UPSTREAM of every `numOrNull` triage there is: a value only
 * reaches the triage once `cmp` has already said DIFF. So a broken read paired
 * with a legitimate zero — envio `0` against ponder `null` — gave
 * `Math.max(Number(0), Number(null)) === 0`, returned EXACT, and the triage
 * added to protect against exactly that never saw the row. The comparison
 * printed `totalFeesCollected0  EXACT 1` and the run exited 0.
 *
 * A no-value therefore short-circuits to DIFF, ahead of the textual equality
 * check as well — `String(null) === String(null)` would otherwise hand back
 * EXACT for a field NEITHER side could read, which is two broken reads agreeing
 * about nothing. Two GENUINE numeric zeros (`0` vs `"0.0"`, say) still compare
 * EXACT, which is the whole distinction being drawn.
 *
 * WHAT THE TOLERANCE COSTS, STATED HONESTLY. `TOL` is RELATIVE, so this does
 * NOT catch every difference — it catches every difference larger than 1e-12 of
 * the larger operand. On a wei-scale integer that is a real blind spot: envio
 * 12345678901234567890 against ponder 12345678901234567891 is a relative
 * difference of ~8e-20 and lands in TOL, not DIFF.
 *
 * That floor is FORCED, not chosen. Ponder's GraphQL types `amount0`,
 * `amount1`, `gasCostETH`, `totalFeesCollected*`, `deposited*`, `withdrawn*`
 * and `totalGasCostETH` as `Float` (verified by introspecting the deployment:
 * every one of those fields comes back `SCALAR Float`). A JSON double carries
 * ~15-17 significant digits, so ANY value above that width is already rounded
 * in transit and can never compare EXACT no matter how correct both sides are.
 * A tolerance tight enough to fail the example above would fail every large,
 * correct value too, and the gate would be useless.
 *
 * So the accurate claim — and the one made everywhere below — is: a difference
 * that exceeds 1e-12 RELATIVE fails. A lost fee is a whole fee, not one wei:
 * `envio 0 vs ponder 4.2` is a relative difference of 1, twelve orders of
 * magnitude clear of the floor. What this cannot see is a sub-1e-12 relative
 * perturbation, which no fee-accounting defect this project has produced looks
 * like. Do not read "no DIFF" as "bit-identical".
 */
const TOL = 1e-12;
function cmp(a, b) {
  // FIRST, before textual equality and before any coercion: a read that
  // returned nothing is not a value and cannot agree with one.
  if (isNoValue(a) || isNoValue(b)) return "DIFF";
  if (String(a) === String(b)) return "EXACT";
  const x = numOrNull(a);
  const y = numOrNull(b);
  // Non-numeric text that did not match above (two different addresses, say).
  if (x === null || y === null) return "DIFF";
  const s = Math.max(Math.abs(x), Math.abs(y));
  if (s === 0) return "EXACT"; // two GENUINE zeros — no-values were rejected above
  return Math.abs(x - y) / s <= TOL ? "TOL" : "DIFF";
}

/*
 * FIELDS THE DEPLOYED SUBGRAPH CANNOT BE COMPARED AGAINST AT ALL.
 *
 * This is NOT a tolerance, a threshold, or a "known noisy field" bucket. It is
 * a statement that the reference computes a different quantity from the one we
 * compute, so there is no comparison to make and no percentage that would make
 * one appear.
 *
 * Upstream v4-subgraph commit 05558b0 "improvements (#20)" (2025-02-11) changed
 * `getAmount0`/`getAmount1` in two ways: they now take the pool's REAL
 * `sqrtPriceX96` instead of `TickMath.getSqrtRatioAtTick(currTick)`, and they
 * round with `roundUp = amount > 0` instead of unconditional `true`. This fork
 * implements the post-#20 form (src/utils/liquidityMath/liquidityAmounts.ts —
 * `currSqrtPriceX96`, `const roundUp = amount > 0n`). The DEPLOYED subgraph we
 * time-travel against runs the PRE-#20 form. Exact 30-decimal replay reproduced
 * the difference to the last decimal on five pools, and the fork is the more
 * correct side.
 *
 * The error is bounded by the RANGE width, not the tick width, so on
 * tickSpacing-1 pools it reaches 100% of the value — no percentage threshold
 * survives that, which is why this is an exclusion and not a tolerance.
 *
 * SCOPE, DELIBERATELY NARROW. `totalValueLockedToken0/1` are the only fields in
 * the POOL comparison whose value flows through `getAmount0`/`getAmount1`
 * (modifyLiquidity-handler.ts:144-173 accumulates them from those two
 * functions; the swap handler adds raw swap deltas, which are event data). Every
 * other pool field — tick, sqrtPrice, liquidity, txCount, feeTier, tickSpacing,
 * volumeToken0/1, the token refs — is untouched by #20 and STILL FAILS on a
 * difference, to the limit of `cmp`'s 1e-12 relative floor (which on a uint160
 * sqrtPrice or a uint128 liquidity is a real absolute width — see the header).
 * It is the reference that is unusable for these two fields, not
 * the fields that are excused: `depositedToken0/1`, `withdrawnToken0/1` and the
 * ledger's `amount0/amount1` also flow through `getAmount0/1`, and they keep
 * being asserted because they are compared against PONDER, which is not a
 * pre-#20 deployment. Do not add a field here for any other reason.
 */
const PRE20_FIELDS = new Set(["totalValueLockedToken0", "totalValueLockedToken1"]);
const PRE20_WHY =
  "computed through getAmount0/getAmount1, which upstream commit 05558b0 (v4-subgraph #20, 2025-02-11) " +
  "changed to use the pool's real sqrtPriceX96 and roundUp = amount > 0; this fork is post-#20 and the " +
  "deployed subgraph is pre-#20, so the two sides compute different quantities and cannot be compared";

const report = [];

for (const chain of CHAINS) {
  console.log(`\n${"=".repeat(76)}\nCHAIN ${chain}\n${"=".repeat(76)}`);
  const out = { chain, problems: [], notes: [], inconclusive: [], excluded: [] };
  /**
   * Record a dimension that was NOT measured. `site` names the dimension so the
   * summary can say what is missing without parsing the reason text.
   */
  const cannotCompare = (site, reason) =>
    out.inconclusive.push({ site, reason: String(reason).slice(0, 200) });

  // ── the block everything is pinned to ────────────────────────────────────
  //
  // The indexer is the source UNDER TEST, but it being unreachable still means
  // nothing was measured, so it is a 2 like any other dead source — not the 1
  // an unhandled rejection used to produce, and certainly not the 0 a dead
  // REFERENCE source produced. Severity now tracks "did we measure anything",
  // not "which side fell over".
  let m;
  try {
    const meta = await gql(
      ENVIO,
      `{ chain_metadata(where: {chain_id: {_eq: ${chain}}}) { latest_processed_block block_height } }`,
    );
    m = meta.chain_metadata?.[0];
  } catch (e) {
    console.log(`  !! indexer unreachable: ${e.message}`);
    cannotCompare("chain", `indexer unreachable: ${e.message}`);
    report.push(out);
    continue;
  }
  if (!m) {
    // A `continue` here used to fire BEFORE report.push(out), so
    // `--chain <not-in-indexer>` printed an empty SUMMARY and exited 0.
    console.log("  chain not present in the deployed indexer");
    cannotCompare("chain", "not present in the deployed indexer");
    report.push(out);
    continue;
  }
  // `Number(null)` is 0, and a 0 here is not a harmless default: it would be
  // sent to the subgraph as `block: { number: 0 }` and used as the Ponder gate,
  // silently "comparing" everything at genesis. No usable height, no run.
  const AT = numOrNull(m.latest_processed_block);
  if (AT === null || AT <= 0) {
    const why = `the indexer reported no usable latest_processed_block (got ${JSON.stringify(m.latest_processed_block)})`;
    console.log(`  !! ${why}`);
    cannotCompare("chain", why);
    report.push(out);
    continue;
  }
  const head = numOrNull(m.block_height);
  const headPct = head !== null && head > 0 ? `${((AT / head) * 100).toFixed(1)}%` : "unknown %";
  console.log(`  Envio indexed block: ${AT}  (chain head ${m.block_height}, ${headPct})`);

  // `subgraphUrl` reads the gateway key off disk, so it can throw before any
  // request is made; that is still "the reference could not be reached".
  let sg = null;
  let sgHead = null;
  let sgReason = null;
  try {
    if (!SUBGRAPH_ID[chain]) throw new Error(`no subgraph configured for chain ${chain}`);
    sg = subgraphUrl(chain);
    sgHead = (await gql(sg, `{ _meta { block { number } } }`))._meta.block.number;
    console.log(`  subgraph head: ${sgHead}`);
    if (sgHead < AT) {
      sgReason = `subgraph head ${sgHead} is BELOW our indexed block ${AT} — cannot time-travel there`;
      console.log(`  !! subgraph is behind us; skipping subgraph comparisons`);
      sgHead = null;
    }
  } catch (e) {
    sgReason = `subgraph unreachable: ${e.message}`;
    console.log(`  !! subgraph unreachable: ${e.message}`);
  }

  // ── 1. POOLS, exact at the block ─────────────────────────────────────────
  //
  // Each subgraph section is independently guarded. The Graph's gateway returns
  // "bad indexers: ... Unavailable" intermittently — mainnet especially — and an
  // uncaught one used to abort the whole run, losing the Ponder comparisons for
  // that chain too. A source that cannot answer records a structured
  // `cannotCompare` entry — never a crash, and never a pass.
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
    let tvlSkipped = 0;
    for (const p of mine) {
      const t = theirs.get(p.bare);
      if (!t) continue;
      compared += 1;
      for (const [name, get] of FIELDS) {
        const mineV = get(p);
        const theirsV = typeof get(t) === "object" ? get(t)?.id : get(t);
        tally[name] ??= { EXACT: 0, TOL: 0, DIFF: 0, SKIP: 0 };
        // NOT COMPARABLE against this deployment at all — see PRE20_FIELDS.
        // Counted, shown in its own column, and never scored as agreement.
        if (PRE20_FIELDS.has(name)) {
          tally[name].SKIP += 1;
          tvlSkipped += 1;
          continue;
        }
        const v = cmp(mineV, theirsV);
        tally[name][v] += 1;
        if (v === "DIFF") bad.push({ pool: p.bare, field: name, envio: mineV, subgraph: theirsV });
      }
      // token refs: Envio stores "<chainId>_<addr>", the subgraph a bare addr.
      for (const [name, a, b] of [
        ["token0", p.token0.replace(`${chain}_`, ""), t.token0?.id],
        ["token1", p.token1.replace(`${chain}_`, ""), t.token1?.id],
      ]) {
        const v = cmp(String(a).toLowerCase(), String(b).toLowerCase());
        tally[name] ??= { EXACT: 0, TOL: 0, DIFF: 0, SKIP: 0 };
        tally[name][v] += 1;
        if (v === "DIFF") bad.push({ pool: p.bare, field: name, envio: a, subgraph: b });
      }
      // An ACTUAL upstream zero, not a volumeUSD the subgraph omitted: this
      // advisory exists to say "their whitelist reports 0", and a null says
      // nothing of the kind.
      if (numOrNull(t.volumeUSD) === 0 && (numOrNull(p.volumeUSD) ?? 0) > 0) usdPolicy += 1;
    }

    console.log(`\n  POOLS at block ${AT}: ${compared}/${mine.length} matched to the subgraph`);
    // Zero comparisons is not "0 DIFFs". An empty join — no pool we hold exists
    // in the subgraph at that block — printed a table of zeroes and passed.
    if (compared === 0) {
      const why =
        mine.length === 0
          ? `the indexer returned no pools for this chain (--pools ${POOL_N})`
          : `none of the ${mine.length} pool(s) we hold were returned by the subgraph at block ${AT}`;
      console.log(`    NOT COMPARED — ${why}`);
      cannotCompare("pools", why);
    } else {
      console.log(
        "    field".padEnd(30) + "EXACT".padStart(8) + "TOL".padStart(7) + "DIFF".padStart(7) + "SKIP".padStart(7),
      );
      for (const f of Object.keys(tally)) {
        const t = tally[f];
        console.log(
          `    ${f}`.padEnd(30) +
            String(t.EXACT).padStart(8) +
            String(t.TOL).padStart(7) +
            String(t.DIFF).padStart(7) +
            String(t.SKIP).padStart(7),
        );
      }
      // Never silent: the exclusion is printed with its count every run.
      if (tvlSkipped) {
        console.log(
          `    NOT COMPARED — ${tvlSkipped} comparison(s) skipped across ${[...PRE20_FIELDS].join("/")}: ${PRE20_WHY}`,
        );
        out.excluded.push({
          site: "pools",
          fields: [...PRE20_FIELDS].join("/"),
          skipped: tvlSkipped,
          reason: PRE20_WHY,
        });
      }
      if (usdPolicy) console.log(`    (advisory) ${usdPolicy} pool(s) have volumeUSD 0 upstream — its whitelist, not a disagreement`);
      for (const b of bad.slice(0, 12)) {
        console.log(`      pool=${b.pool.slice(0, 18)}… ${b.field}: envio=${b.envio} subgraph=${b.subgraph}`);
      }
      if (bad.length > 12) console.log(`      ... and ${bad.length - 12} more`);
      if (bad.length) out.problems.push(`pools: ${bad.length} field difference(s) at the same block`);
      out.pools = { compared, bad: bad.length, tvlSkipped };
    }
  } catch (e) {
    // Either side can raise here (the indexer read is in the same try), so the
    // message does not claim which one did.
    cannotCompare("pools", `not compared: ${e.message}`);
    console.log(`\n  POOLS: NOT COMPARED — ${e.message}`);
  }
  else cannotCompare("pools", sgReason ?? "subgraph not usable at this block");

  // ── 2. POSITION IDENTITY, exact at the block ─────────────────────────────
  let minePos = [];
  let posReason = null;
  try {
    minePos =
      (
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
      ).Position ?? [];
  } catch (e) {
    posReason = `indexer position read failed: ${e.message}`;
  }
  if (!posReason && minePos.length === 0) posReason = "no positions indexed yet on this chain";
  if (!posReason) console.log(`\n  POSITIONS sampled: ${minePos.length}`);

  /*
   * UNCOLLECTED FEES ARE GATED AGAINST OUR OWN DATA.
   *
   * This block used to compute `nonZeroUncollected`, print it, and gate NOTHING
   * — and it printed the reassurance "as designed: head-gated, and this chain is
   * mid-backfill" on the `swept === 0` branch, i.e. on EXACTLY the branch where
   * a non-zero uncollected figure is impossible. A position carrying
   * `totalFeesUncollected0 = 123456` with `feesUpdatedAtBlock = 0` printed the
   * contradiction and the reassurance on adjacent lines and exited 0.
   *
   * The invariant is structural, not stylistic: the fee sweep is the ONLY writer
   * of `totalFeesUncollected0/1` AND the only writer of `feesUpdatedAtBlock`
   * (`modifyLiquidity-handler.ts` explicitly leaves `feesUpdatedAtBlock`
   * untouched — "only the fee sweep owns it"). So the two are written together
   * or not at all, and an uncollected balance with no sweep block behind it is a
   * write nobody in the pipeline can produce. That is a defect in our data, and
   * a defect is a 1.
   *
   * AN UNREADABLE VALUE IS NOT A DISAGREEMENT — IT IS A MISSING MEASUREMENT.
   *
   * This block previously ran the invariant on coerced values, so a position
   * whose `feesUpdatedAtBlock` AND both uncollected legs were ALL unreadable
   * satisfied `unswept` (`(null ?? 0) <= 0`) and `notProvenZero`
   * (`null !== 0`), and got pushed as a problem worded "...while
   * feesUpdatedAtBlock is 0". It was not 0. It was unreadable, and NOTHING was
   * measured — the message described a state the run never found.
   *
   * That also took the opposite severity call from this file's own sibling at
   * the Ponder height gate, where a Ponder row with no readable
   * `updatedAtBlock` is `cannotCompare` (exit 2) on the stated rationale that a
   * reference read we cannot position is a missing measurement, not a
   * disagreement. The same rationale applies to our own rows: if a field the
   * invariant needs cannot be read, the invariant was not evaluated, so it is a 2.
   *
   * With one carve-out, because "not evaluated" has to mean actually not
   * evaluated. A readable zero `feesUpdatedAtBlock` plus a readable non-zero
   * figure in EITHER leg already violates the invariant on its own, so an
   * unreadable OTHER leg cannot un-prove it. Those rows stay a FAIL. Demanding
   * all three legs first would turn a proven contradiction into a 2 over a value
   * the proof never reads — and a half-written sweep row is exactly the shape
   * this check exists to catch.
   *
   * A GENUINELY non-zero uncollected figure against a GENUINELY zero
   * `feesUpdatedAtBlock` is untouched by this and still FAILS (exit 1). That
   * self-contradiction is real: the sweep is the only writer of both.
   */
  if (posReason) {
    console.log(`\n  POSITIONS: NOT COMPARED — ${posReason}`);
  } else {
    /*
     * A PROVEN contradiction outranks an unreadable neighbour. The invariant is
     * "the sweep is the only writer of both", so it is already violated once we
     * can read a zero `feesUpdatedAtBlock` AND a non-zero figure in EITHER leg —
     * whatever the other leg says cannot rescue it. Requiring all three legs to
     * parse before evaluating would downgrade a fully-proven FAIL to a 2 because
     * of a third value the proof never touches, which is the most realistic
     * shape of the defect this check exists to catch (a half-written sweep row).
     */
    const provenUnswept = (p) => {
      const b = numOrNull(p.feesUpdatedAtBlock);
      return b !== null && b <= 0;
    };
    const provenNonZero = (p) =>
      [p.totalFeesUncollected0, p.totalFeesUncollected1].some((v) => {
        const n = numOrNull(v);
        return n !== null && n !== 0;
      });
    const contradictory = minePos.filter((p) => provenUnswept(p) && provenNonZero(p));
    const proven = new Set(contradictory);

    // Everything not already proven needs all three legs readable to be judged.
    const readable = (p) =>
      numOrNull(p.feesUpdatedAtBlock) !== null &&
      numOrNull(p.totalFeesUncollected0) !== null &&
      numOrNull(p.totalFeesUncollected1) !== null;

    const unreadable = minePos.filter((p) => !proven.has(p) && !readable(p));
    const measurable = minePos.filter((p) => proven.has(p) || readable(p));

    const unswept = (p) => provenUnswept(p);
    const nonZero = (p) => provenNonZero(p);

    const swept = measurable.filter((p) => !unswept(p)).length;
    const nonZeroUncollected = measurable.filter(nonZero).length;

    console.log(
      `    uncollected-fee sweep: ${swept} swept, ${nonZeroUncollected} with non-zero uncollected` +
        `${unreadable.length ? `, ${unreadable.length} NOT MEASURABLE (unreadable field)` : ""}`,
    );
    if (unreadable.length) {
      for (const p of unreadable.slice(0, 8)) {
        console.log(
          `      ?? tokenId=${p.tokenId} NOT MEASURABLE — uncollected0=${JSON.stringify(p.totalFeesUncollected0)} ` +
            `uncollected1=${JSON.stringify(p.totalFeesUncollected1)} ` +
            `feesUpdatedAtBlock=${JSON.stringify(p.feesUpdatedAtBlock)}`,
        );
      }
      if (unreadable.length > 8) console.log(`      ... and ${unreadable.length - 8} more`);
      cannotCompare(
        "uncollected fees",
        `${unreadable.length} of ${minePos.length} position(s) returned an unreadable ` +
          `feesUpdatedAtBlock or totalFeesUncollected0/1, so the sweep invariant could not be evaluated on them`,
      );
    }
    if (contradictory.length) {
      for (const p of contradictory.slice(0, 8)) {
        console.log(
          `      !! tokenId=${p.tokenId} uncollected0=${p.totalFeesUncollected0} ` +
            `uncollected1=${p.totalFeesUncollected1} feesUpdatedAtBlock=${p.feesUpdatedAtBlock}`,
        );
      }
      if (contradictory.length > 8) console.log(`      ... and ${contradictory.length - 8} more`);
      out.problems.push(
        `uncollected fees: ${contradictory.length} position(s) carry a readable NON-ZERO ` +
          `totalFeesUncollected while a readable feesUpdatedAtBlock is 0 — the sweep is the only writer ` +
          `of both, so neither can exist without the other`,
      );
    } else if (measurable.length === 0 && minePos.length > 0) {
      // Nothing measurable at all: the `swept 0, non-zero 0` line above would
      // otherwise read as a clean bill of health for an unmeasured set.
      console.log(`      -> nothing measurable on this chain`);
    } else if (swept === 0 && nonZeroUncollected === 0) {
      // Printed ONLY when it is true: nothing swept AND nothing to explain.
      console.log(`      -> as designed: head-gated, and this chain is mid-backfill`);
    }
    if (swept > 0) out.notes.push(`${swept} positions have been swept — the head gate has opened on this chain`);
  }

  if (posReason) cannotCompare("position identity", posReason);
  else if (!sgHead) cannotCompare("position identity", sgReason ?? "subgraph not usable at this block");
  else try {
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
    // Every sampled position absent upstream means the join produced nothing:
    // "0 differ" there is the absence of a test, not the result of one.
    if (ok + bad.length === 0) {
      const why = `every one of the ${minePos.length} sampled position(s) was absent from the subgraph at block ${AT}`;
      console.log(`    NOT COMPARED — ${why}`);
      cannotCompare("position identity", why);
    }
  } catch (e) {
    cannotCompare("position identity", `not compared: ${e.message}`);
    console.log(`    identity vs subgraph: NOT COMPARED — ${e.message}`);
  }

  // ── 3. COLLECTED FEES + CASHFLOWS vs Ponder (gated) ──────────────────────
  const pond = new Map();
  let ponderUp = !posReason;
  let ponderReason = posReason;
  if (!PONDER[chain]) {
    ponderUp = false;
    ponderReason = `no Ponder endpoint configured for chain ${chain}`;
  }
  if (ponderUp) {
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
        ponderReason = `ponder positions unreachable: ${e.message}`;
        console.log(`\n  vs PONDER: NOT COMPARED — ${e.message}`);
        break;
      }
      await sleep(120);
    }
  } else {
    console.log(`\n  vs PONDER: NOT COMPARED — ${ponderReason}`);
  }
  if (!ponderUp) cannotCompare("ponder positions", ponderReason);
  else {
    const FIELDS = [
      "totalFeesCollected0", "totalFeesCollected1",
      "depositedToken0", "depositedToken1", "withdrawnToken0", "withdrawnToken1",
      "totalGasCostETH",
    ];
    const tally = {};
    const bad = [];
    let gated = 0;
    let ungatable = 0;
    for (const p of minePos) {
      const t = pond.get(p.tokenId);
      if (!t) continue;
      // The height gate is the whole basis for comparing Ponder at all, so it
      // needs a real height. `Number(null)` is 0, which reads as "Ponder is at
      // genesis, definitely behind us" and waves the row through ungated.
      const theirBlock = numOrNull(t.updatedAtBlock);
      if (theirBlock === null) {
        ungatable += 1;
        continue;
      }
      if (theirBlock > AT) continue; // Ponder saw more than we did
      gated += 1;
      for (const f of FIELDS) {
        const v = cmp(p[f], t[f]);
        tally[f] ??= { EXACT: 0, TOL: 0, DIFF: 0 };
        tally[f][v] += 1;
        if (v === "DIFF") bad.push({ tokenId: p.tokenId, field: f, envio: p[f], ponder: t[f] });
      }
    }
    console.log(
      `\n  vs PONDER (${pond.size} found, ${gated} comparable at or below block ${AT}` +
        `${ungatable ? `, ${ungatable} with no readable updatedAtBlock` : ""})`,
    );
    // A Ponder row with no readable height is not a disagreement between the two
    // datasets — it is a reference read we cannot position in time — so it is a
    // missing measurement (2), not a failure (1).
    if (ungatable) {
      cannotCompare(
        "ponder positions",
        `${ungatable} Ponder position(s) returned no readable updatedAtBlock, so they could not be height-gated`,
      );
    }
    // Ponder ahead of us on every sampled position, or holding none of them,
    // leaves nothing gated — and an all-zero tally is not agreement.
    if (gated === 0) {
      const why = `0 of ${minePos.length} sampled position(s) were comparable at or below block ${AT} (Ponder returned ${pond.size})`;
      console.log(`    NOT COMPARED — ${why}`);
      cannotCompare("ponder positions", why);
    } else {
      console.log("    field".padEnd(30) + "EXACT".padStart(8) + "TOL".padStart(7) + "DIFF".padStart(7));
      for (const f of Object.keys(tally)) {
        const t = tally[f];
        console.log(`    ${f}`.padEnd(30) + String(t.EXACT).padStart(8) + String(t.TOL).padStart(7) + String(t.DIFF).padStart(7));
      }
      /*
       * TRIAGE IS A PARTITION, NOT A SET OF INDEPENDENT FILTERS.
       *
       * Every element of `bad` is assigned to exactly one bucket in a single
       * pass, and the buckets are then asserted to sum back to `bad.length`.
       * The previous four `filter` calls left a hole between them: `cmp`
       * deliberately returns DIFF when either side is non-finite, but a
       * `totalFeesCollected*` DIFF whose `Number()` is NaN matched neither the
       * numeric `lower`/`higher` filters nor the
       * `!startsWith("totalFeesCollected")` cashflow filter. It vanished from
       * problems AND notes, so the table printed `totalFeesCollected0 … DIFF 1`
       * and the summary still said no disagreement, exit 0.
       *
       * The one asymmetry that is EXCUSED is narrow, and the narrowness is the
       * whole point. Ponder's `isTraceCapabilityError` matches any error
       * containing "tracer", and viem embeds `"tracer":"callTracer"` in every
       * trace error body, so every trace failure there is misclassified as
       * permanent and the position records ZERO collected fees. That defect
       * explains exactly one shape — Ponder REPORTING A NUMERIC ZERO while we
       * hold a fee — and nothing else. `envio 10 vs ponder 5` is an Envio
       * DOUBLE-COUNT, not Ponder's under-count, and it fails. `envio < ponder`
       * means WE lost a fee and fails (subject to the relative-tolerance floor
       * documented at `cmp`: the difference has to exceed 1e-12 relative to
       * reach `bad` at all, which any real lost fee does by twelve orders of
       * magnitude). Anything unclassifiable — non-numeric on either side, or
       * numerically equal yet textually different — fails as well: an
       * unexplained difference is a problem, never a note.
       *
       * THE EXCUSE IS GATED ON THE RAW VALUE, NOT THE COERCED ONE. `Number(null)`
       * and `Number("")` are both 0, so `p === 0` used to match a Ponder read
       * that returned NO VALUE — printing "Ponder recorded 0 (its known
       * missed-trace under-count)" and `ponder=null` on the same screen, then
       * passing. Ponder did not record 0 there; it returned nothing, which is a
       * broken read and not the documented under-count. `numOrNull` yields
       * `null` for every no-value shape, and a `null` on either side falls
       * through to `unexplained` where it belongs.
       */
      const lower = [];
      const higherPonderZero = [];
      const cashflow = [];
      const unexplained = [];
      for (const b of bad) {
        if (!b.field.startsWith("totalFeesCollected")) {
          cashflow.push(b);
          continue;
        }
        const e = numOrNull(b.envio);
        const p = numOrNull(b.ponder);
        if (e === null || p === null) unexplained.push(b);
        else if (e < p) lower.push(b);
        else if (e > p && p === 0) higherPonderZero.push(b);
        else unexplained.push(b);
      }
      const bucketed = lower.length + higherPonderZero.length + cashflow.length + unexplained.length;
      if (bucketed !== bad.length) {
        // Unreachable by construction; kept so that a future edit which makes
        // the triage non-total fails loudly instead of silently dropping rows.
        out.problems.push(
          `ponder triage bug: only ${bucketed} of ${bad.length} difference(s) were classified — the rest were dropped`,
        );
      }
      if (lower.length) console.log(`    !! ENVIO LOWER on collected fees (a lost fee): ${lower.length}`);
      if (higherPonderZero.length) {
        console.log(`    Envio higher on collected fees where Ponder recorded 0 (its known missed-trace under-count): ${higherPonderZero.length}`);
      }
      if (unexplained.length) {
        console.log(
          `    !! UNEXPLAINED collected-fee difference(s) — over-count, non-numeric, or a no-value read: ${unexplained.length}`,
        );
      }
      for (const b of bad.slice(0, 12)) {
        console.log(`      tokenId=${b.tokenId} ${b.field}: envio=${b.envio} ponder=${b.ponder}`);
      }
      if (bad.length > 12) console.log(`      ... and ${bad.length - 12} more`);
      if (lower.length) out.problems.push(`collected fees LOWER than Ponder on ${lower.length} field(s)`);
      if (unexplained.length) {
        out.problems.push(
          `collected fees differ from Ponder in an unexplained way on ${unexplained.length} field(s) ` +
            `(Envio above a NON-ZERO Ponder figure, i.e. an over-count; a non-numeric value; or a Ponder ` +
            `read that returned NO VALUE, which is not the documented missed-trace zero)`,
        );
      }
      if (higherPonderZero.length) {
        out.notes.push(
          `${higherPonderZero.length} collected-fee field(s) read higher than a Ponder ZERO — its known missed-trace under-count`,
        );
      }
      if (cashflow.length) {
        const byField = {};
        for (const b of cashflow) byField[b.field] = (byField[b.field] ?? 0) + 1;
        const detail = Object.entries(byField)
          .map(([f, n]) => `${f} ${n}`)
          .join(", ");
        out.problems.push(`cashflow/gas vs Ponder: ${cashflow.length} difference(s) — ${detail}`);
      }
      out.ponder = {
        found: pond.size,
        gated,
        bad: bad.length,
        lower: lower.length,
        higherPonderZero: higherPonderZero.length,
        unexplained: unexplained.length,
        cashflow: cashflow.length,
      };
    }
  }

  // ── 4. LEDGER vs Ponder ──────────────────────────────────────────────────
  let ledgerReason = null;
  try {
    if (!PONDER[chain]) throw new Error(`no Ponder endpoint configured for chain ${chain}`);
    const LEDGER_FIELDS = `id tokenId txHash logIndex type amount0 amount1 gasCostETH blockNumber`;
    // Envio caps this read SERVER-SIDE at 1000 rows however large a `limit` is
    // requested; asking for 2000 documents that the cap is the server's, not
    // ours, and lets the completion step below detect it.
    const ENVIO_ROW_CAP = 1000;
    const windowRows = (
      await gql(
        ENVIO,
        `query T { PositionTransaction(where: {chainId: {_eq: "${chain}"}}, limit: 2000, order_by: {blockNumber: desc}) {
           ${LEDGER_FIELDS} } }`,
      )
    ).PositionTransaction ?? [];
    // Math.min() of nothing is Infinity, which would have been sent to Ponder
    // as a block bound; there is nothing to compare in that case anyway.
    if (windowRows.length === 0) throw new Error("no PositionTransaction rows indexed yet on this chain");
    // `Number(null)` is 0, and a 0 block number would drag `rawLo` to genesis
    // and make the Ponder range query span the whole chain. Our own rows, so a
    // null here is a defect in the read, not a condition to work around.
    const blocks = windowRows.map((t) => numOrNull(t.blockNumber));
    if (blocks.some((b) => b === null)) {
      throw new Error(
        `${blocks.filter((b) => b === null).length} of ${windowRows.length} PositionTransaction row(s) came back with an unreadable blockNumber`,
      );
    }
    const rawLo = Math.min(...blocks);
    const hi = Math.max(...blocks);

    /*
     * THE BOTTOM BLOCK IS COMPLETED, NOT EXCLUDED.
     *
     * The windowed read above is capped server-side at 1000 rows and ordered
     * `blockNumber desc`, so every block strictly above the minimum is complete
     * and the MINIMUM block is a partial tie group: rows sitting at exactly that
     * block which the cap sliced off. Ponder's range query has no such cap and
     * returns all of them, so joining over [rawLo, hi] on the windowed rows
     * alone invents phantom only-ponder rows. That is real: the first live run
     * of the reverse gate reported `only-ponder 1`, a COLLECT_FEES row at block
     * 61204912 on chain 43114, where both indexers in fact hold 2 rows and our
     * capped fetch had 1.
     *
     * A previous round fixed that by excluding the bottom block (`lo = rawLo +
     * 1`). Right diagnosis, wrong remedy, and it cost two things:
     *
     *   1. The reverse gate — the LOST-FEE gate, the most important one here —
     *      stopped covering the bottom block. A Ponder COLLECT_FEES row we never
     *      wrote, sitting on that one block, passed. "Catches a lost fee at
     *      every block but one" is not a lost-fee gate.
     *   2. A chain whose entire ledger sits on ONE block threw and became
     *      permanently INCONCLUSIVE. A low-volume chain could never reach PASS.
     *
     * Instead: issue a SECOND query pinned to that single block. One block's
     * rows are far below any server cap, so its completeness is PROVABLE rather
     * than assumed — and provable is the difference that matters, because the
     * whole reason the bottom block was suspect is that we could not tell a
     * short page from a complete one. Merge by entity id (`positionTxId` —
     * `${chainId}_${txHash}_${logIndex}_${type}`, src/utils/positions.ts:82), so
     * the rows the window already had are not double-counted, and compare over
     * the FULL [rawLo, hi].
     *
     * If even the single-block query comes back AT the cap, completeness is once
     * again unprovable — and that IS genuinely inconclusive, so it says so
     * instead of guessing. That case is the only one the exclusion was ever
     * really entitled to, and it is now the only one that pays for it.
     *
     * THE RESULT IS BOUNDED FROM BELOW TOO, AND THAT BOUND IS ARITHMETIC.
     * `rawLo` is the minimum of blocks taken from rows ALREADY IN `windowRows`,
     * so the pinned query is guaranteed to return at least the rows the window
     * itself holds at that block — `bottom.length >= windowAtLo >= 1` is
     * certain, not hopeful. A SMALLER result is proof that the pinned query did
     * not do what the merge below assumes (a filter that did not match, a
     * different block encoding, a partial page), and everything downstream then
     * runs on a row set nobody verified while WIDENING the compared range to
     * include that block. Checked only from above, that shipped two wrong
     * answers: `bottom` empty printed "0 recovered by completing block N, which
     * holds 0" — its own refutation — and passed; and a short `bottom` left the
     * sliced rows missing, so Ponder's copies of them counted as only-ponder
     * and the run reported a LOST FEE that does not exist. A false FAIL is the
     * worse of the two, because it teaches people to ignore the gate.
     */
    const bottom = (
      await gql(
        ENVIO,
        `query B { PositionTransaction(where: {chainId: {_eq: "${chain}"}, blockNumber: {_eq: "${rawLo}"}}, limit: ${ENVIO_ROW_CAP}) {
           ${LEDGER_FIELDS} } }`,
      )
    ).PositionTransaction ?? [];
    if (bottom.length >= ENVIO_ROW_CAP) {
      throw new Error(
        `block ${rawLo} alone returned ${bottom.length} row(s) — at the server cap, so our row set for the ` +
          `lowest block cannot be proven complete and an only-ponder count over it would not be trustworthy`,
      );
    }
    const windowAtLo = blocks.filter((b) => b === rawLo).length;
    if (bottom.length < windowAtLo) {
      // Kept short on purpose: `cannotCompare` slices the reason at 200 chars,
      // and BOTH counts have to survive that slice to be diagnosable.
      throw new Error(
        `block-${rawLo} completion returned ${bottom.length} row(s), fewer than the ${windowAtLo} the capped ` +
          `window already holds there — the pinned read is unreliable, so the completed set is unverified`,
      );
    }
    const byId = new Map();
    for (const r of windowRows) byId.set(r.id, r);
    const beforeMerge = byId.size;
    for (const r of bottom) byId.set(r.id, r);
    const recovered = byId.size - beforeMerge;
    const mineTx = [...byId.values()];

    // The compared range is now the FULL span of the rows we hold.
    const lo = rawLo;
    const theirs = new Map();
    let after = null;
    let pages = 0;
    let ok = true;
    let truncated = false;
    for (;;) {
      try {
        const d = await gql(
          PONDER[chain],
          `query T($w: positionTransactionFilter, $l: Int!, $a: String){
             positionTransactions(where:$w, orderBy:"blockNumber", orderDirection:"asc", limit:$l, after:$a){
               items { tokenId txHash logIndex type amount0 amount1 gasCostETH } pageInfo { hasNextPage endCursor } } }`,
          // The String() bounds were checked against the live deployment and the
          // comparison is NUMERIC, not lexicographic: `blockNumber_gte:
          // "9999999"` returns blocks 72826078 and 82729319, which a
          // string-ordered comparison would have excluded. Do not re-raise.
          { w: { chainId: chain, blockNumber_gte: String(lo), blockNumber_lte: String(hi) }, l: 1000, a: after },
        );
        const pg = d.positionTransactions;
        for (const r of pg?.items ?? []) theirs.set(`${r.tokenId}|${r.txHash.toLowerCase()}|${r.logIndex}|${r.type}`, r);
        pages += 1;
        if (!pg?.pageInfo?.hasNextPage || !pg.pageInfo.endCursor) break;
        if (pages > 50) {
          // Stopped early: Ponder's side of the join is incomplete, so any
          // only-envio count below would be this cap, not a real difference.
          truncated = true;
          break;
        }
        after = pg.pageInfo.endCursor;
      } catch (e) {
        ok = false;
        ledgerReason = `ponder ledger unavailable (no indexes on that deployment): ${e.message}`;
        break;
      }
    }
    if (ok && truncated) {
      console.log(`\n  LEDGER vs PONDER: NOT COMPARED — Ponder's ledger was truncated at the 50-page cap`);
      cannotCompare("ledger", "Ponder's ledger page walk hit the 50-page cap — its side of the join is incomplete");
    } else if (ok) {
      let exact = 0;
      let tol = 0;
      const bad = [];
      let onlyMine = 0;
      let matched = 0;
      /*
       * THE JOIN IS TWO-DIRECTIONAL. It used to walk `mineTx` only and count
       * `onlyMine`; `out.ledger` then stored `theirs: theirs.size` and
       * `matched` side by side and never compared them. A COLLECT_FEES row
       * Ponder holds INSIDE the very block range we derived from our own rows,
       * that we never wrote — a LOST FEE, the exact invariant this project says
       * must stay exact — printed `rows: envio 2, ponder 3; only-envio 0` and
       * then `every dimension compared, no disagreement`, exit 0.
       *
       * `theirs.size - matched` is NOT used as the reverse count, and the
       * unjoined Ponder keys are tracked in an explicit Set instead.
       *
       * To be accurate about why, because an earlier version of this comment was
       * not: NO duplicate was ever discovered, and our key cannot currently
       * produce one. `positionTxId` (src/utils/positions.ts:82) returns
       * `<chainId>_<txHash>_<logIndex>_<type>` and is the entity id at both — and
       * only both — `PositionTransaction.set` call sites
       * (modifyLiquidity-handler.ts:673 and :700), where the row's own `txHash`,
       * `logIndex` and `type` fields are set from the same event values. Two
       * rows sharing (txHash, logIndex, type) within one chain would therefore
       * be the SAME entity id, i.e. one row. So the join key really is unique on
       * our side today.
       *
       * The Set is kept as cheap defence against that changing — an id scheme
       * that drops `type`, a second write site, a merge that stops deduping —
       * not because a duplicate was found. And since it is cheap, the invariant
       * it protects is now ASSERTED below rather than merely assumed.
       */
      const unmatchedTheirs = new Set(theirs.keys());
      for (const t of mineTx) {
        const k = `${t.tokenId}|${t.txHash.toLowerCase()}|${t.logIndex}|${t.type}`;
        const p = theirs.get(k);
        if (!p) {
          onlyMine += 1;
          continue;
        }
        unmatchedTheirs.delete(k);
        matched += 1;
        for (const f of ["amount0", "amount1", "gasCostETH"]) {
          const v = cmp(t[f], p[f]);
          if (v === "EXACT") exact += 1;
          else if (v === "TOL") tol += 1;
          else bad.push({ tokenId: t.tokenId, type: t.type, field: f, envio: t[f], ponder: p[f] });
        }
      }
      const onlyTheirs = unmatchedTheirs.size;
      /*
       * THE JOIN MUST BE ONE-TO-ONE, AND THAT IS NOW CHECKED.
       *
       * `matched` counts MINE-side hits; `theirs.size - onlyTheirs` counts the
       * DISTINCT Ponder keys those hits landed on. With a unique key on our side
       * (established in the comment above) the two are equal by construction, so
       * any divergence — `matched` exceeding the distinct keys joined, or the
       * impossible `matched > theirs.size` — means two of our rows shared a join
       * key and the uniqueness argument has silently stopped holding.
       *
       * It was computed and printed before this check existed: `matched 3,
       * only-ponder 0` against `ponder 2` went to screen and the run exited 0.
       * An impossible state that is displayed but not asserted is not a check.
       */
      const distinctTheirsJoined = theirs.size - onlyTheirs;
      if (matched !== distinctTheirsJoined || matched > theirs.size) {
        out.problems.push(
          `ledger join is not one-to-one: ${matched} of our row(s) joined only ${distinctTheirsJoined} distinct ` +
            `Ponder key(s) (Ponder held ${theirs.size} in range) — two rows we hold shared the join key ` +
            `tokenId|txHash|logIndex|type, so the entity id is no longer unique on it`,
        );
      }
      console.log(`\n  LEDGER vs PONDER over blocks ${lo}..${hi}`);
      // BOTH directions are reported on the same line, and `matched` with them,
      // so a future false alarm on either gate is diagnosable at a glance —
      // the only-envio gate in particular has never fired against live data
      // (only chain 43114's ledger is servable; 1 and 42161 time out on the
      // missing SQL indexes), so its first firing needs to be readable.
      console.log(
        `    rows: envio ${mineTx.length} (${windowRows.length} in the capped window + ${recovered} recovered by ` +
          `completing block ${rawLo}, which holds ${bottom.length}), ponder ${theirs.size}; ` +
          `matched ${matched}, only-envio ${onlyMine}, only-ponder ${onlyTheirs}`,
      );
      console.log(`    field comparisons: EXACT ${exact}, TOL ${tol}, DIFF ${bad.length}`);
      for (const b of bad.slice(0, 10)) {
        console.log(`      tokenId=${b.tokenId} ${b.type} ${b.field}: envio=${b.envio} ponder=${b.ponder}`);
      }
      for (const k of [...unmatchedTheirs].slice(0, 10)) {
        const [tokenId, txHash, logIndex, type] = k.split("|");
        console.log(`      only-ponder row: tokenId=${tokenId} ${type} tx=${txHash.slice(0, 18)}… log=${logIndex}`);
      }
      if (onlyTheirs > 10) console.log(`      ... and ${onlyTheirs - 10} more only-ponder row(s)`);
      if (matched === 0) {
        // The join produced nothing, so "DIFF 0" described an empty set. This
        // is the shape a total key mismatch takes, and it used to pass.
        const why = `no row joined: envio ${mineTx.length}, ponder ${theirs.size} over blocks ${lo}..${hi}`;
        console.log(`    NOT COMPARED — ${why}`);
        cannotCompare("ledger", why);
      } else {
        if (bad.length) out.problems.push(`ledger: ${bad.length} field difference(s)`);
        /*
         * Rows we hold that Ponder does not, over a range Ponder has fully
         * indexed, are a row-set disagreement and gate. The port writes a row
         * under exactly Ponder's condition (`willWriteRow`, delta !== 0 or
         * something settled — modifyLiquidity-handler.ts:576), so there is no
         * legitimate reason for our set to be the larger one. A join that
         * matched NOTHING is handled above as inconclusive rather than as a
         * mass of differences.
         */
        if (onlyMine) {
          out.problems.push(`ledger: ${onlyMine} row(s) present here and absent from Ponder over blocks ${lo}..${hi}`);
        }
        /*
         * The reverse direction, and the more dangerous one. [lo,hi] is derived
         * from OUR OWN rows, so a Ponder row inside it is a row we should have
         * written and did not — a potentially LOST FEE on our side. That is a
         * measured disagreement, not a missing measurement, so it FAILS (exit
         * 1) rather than recording `cannotCompare`.
         */
        if (onlyTheirs) {
          out.problems.push(
            `ledger: ${onlyTheirs} row(s) Ponder holds inside blocks ${lo}..${hi} that are absent here — a potentially LOST FEE`,
          );
        }
      }
      out.ledger = {
        window: windowRows.length,
        completedBlock: rawLo,
        completedBlockRows: bottom.length,
        recovered,
        mine: mineTx.length,
        theirs: theirs.size,
        matched,
        onlyMine,
        onlyTheirs,
        bad: bad.length,
      };
    } else {
      console.log(`\n  LEDGER vs PONDER: not comparable (Ponder cannot serve a filtered query on this chain)`);
      cannotCompare("ledger", ledgerReason ?? "Ponder cannot serve a filtered query on this chain");
    }
  } catch (e) {
    cannotCompare("ledger", `not compared: ${e.message}`);
    console.log(`\n  LEDGER vs PONDER: NOT COMPARED — ${e.message}`);
  }

  report.push(out);
}

console.log(`\n${"=".repeat(76)}\nSUMMARY\n${"=".repeat(76)}`);
let anyProblem = false;
for (const r of report) {
  console.log(`\nchain ${r.chain}:`);
  for (const p of r.problems) {
    anyProblem = true;
    console.log(`  PROBLEM: ${p}`);
  }
  for (const s of r.inconclusive) console.log(`  not compared: ${s.site} — ${s.reason}`);
  // Printed at the SAME prominence as an inconclusive skip, and before the
  // "no disagreement" line, so nobody reads a PASS as covering these.
  for (const x of r.excluded) {
    console.log(`  not compared: ${x.site}.${x.fields} — ${x.skipped} comparison(s) skipped; ${x.reason}`);
  }
  for (const n of r.notes) console.log(`  note: ${n}`);
  if (r.problems.length === 0 && r.inconclusive.length === 0) {
    // Deliberately narrower than the old "every dimension compared, no
    // disagreement": the subgraph joins compare the intersection, so this says
    // what was actually established. See WHAT A 0 DOES AND DOES NOT COVER.
    console.log(
      r.excluded.length
        ? "  every dimension ran; no disagreement in what was compared — EXCEPT the field(s) listed above, which were not compared at all"
        : "  every dimension ran; no disagreement in what was compared",
    );
  }
}

/*
 * A chain that never reached report.push at all — every loop path now pushes,
 * so this is a backstop against a future `continue` reintroducing the bug that
 * made `--chain <unknown>` print an empty SUMMARY and exit 0.
 */
const reported = new Set(report.map((r) => r.chain));
const unreported = CHAINS.filter((c) => !reported.has(c));
for (const c of unreported) console.log(`\nchain ${c}:\n  not compared: chain — produced no report at all`);

const fullyCompared = report.filter((r) => r.inconclusive.length === 0);
const anyInconclusive = unreported.length > 0 || report.some((r) => r.inconclusive.length > 0);
const totalExcluded = report.reduce((n, r) => n + r.excluded.reduce((m, x) => m + x.skipped, 0), 0);

console.log("");
if (totalExcluded) {
  console.log(
    `EXCLUDED: ${totalExcluded} field comparison(s) were NOT MADE (${[...PRE20_FIELDS].join("/")} vs a pre-#20 ` +
      `subgraph deployment). Whatever the result line says, it says nothing about those.`,
  );
}
if (anyProblem) {
  console.log("RESULT: DISAGREEMENT — do not cut over until explained.   (FAIL, exit 1)");
} else if (fullyCompared.length === 0) {
  console.log("RESULT: INCONCLUSIVE — no chain was compared on every dimension. This is NOT a pass.   (exit 2)");
} else if (anyInconclusive) {
  console.log(
    `RESULT: PARTIAL — ${fullyCompared.length}/${CHAINS.length} chain(s) fully compared and agreeing; ` +
      `the rest left a dimension unmeasured. This is NOT a full pass.   (INCONCLUSIVE, exit 2)`,
  );
} else {
  console.log(
    `RESULT: PASS — all ${fullyCompared.length} chain(s) ran every dimension with no disagreement in what was compared.   (exit 0)`,
  );
}
console.log("");

// 1 on a measured disagreement, 2 when something was never measured, 0 only
// when every dimension actually ran. Silence must never read as success.
process.exit(anyProblem ? 1 : anyInconclusive ? 2 : 0);
