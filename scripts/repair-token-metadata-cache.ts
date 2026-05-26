/*
 * Stream-repairs the getTokenMetadata effect cache: any row whose stored value
 * is the poisoned default ("name": "unknown" / "symbol": "UNKNOWN") gets
 * re-queried against the chain's RPC and rewritten with real metadata.
 * Addresses with no bytecode (or where the RPC retry also fails) are dropped
 * so the indexer can re-attempt on a future sync — with fix #1 in place those
 * retries will not be persisted as garbage again.
 *
 * Input:   .envio/cache/getTokenMetadata.tsv
 * Output:  .envio/cache/getTokenMetadata.tsv.repaired  (atomic — review then swap)
 * Report:  scripts/repair-report.json
 *
 * Run with:
 *   node --env-file=.env --import tsx scripts/repair-token-metadata-cache.ts [--concurrency=N] [--dry-run]
 */

import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createPublicClient, http, type PublicClient } from "viem";

const CACHE_PATH = ".envio/cache/getTokenMetadata.tsv";
const OUT_PATH = ".envio/cache/getTokenMetadata.tsv.repaired";
const REPORT_PATH = "scripts/repair-report.json";

const RPC_URLS: Record<number, string | undefined> = {
  1: process.env.ENVIO_MAINNET_RPC_URL,
  10: process.env.ENVIO_OPTIMISM_RPC_URL,
  56: process.env.ENVIO_BSC_RPC_URL,
  130: process.env.ENVIO_UNICHAIN_RPC_URL,
  137: process.env.ENVIO_POLYGON_RPC_URL,
  143: process.env.ENVIO_MONAD_RPC_URL,
  480: process.env.ENVIO_WORLDCHAIN_RPC_URL,
  1868: process.env.ENVIO_SONIEUM_RPC_URL,
  8453: process.env.ENVIO_BASE_RPC_URL,
  42161: process.env.ENVIO_ARBITRUM_RPC_URL,
  42220: process.env.ENVIO_CELO_RPC_URL,
  43114: process.env.ENVIO_AVALANCHE_RPC_URL,
  57073: process.env.ENVIO_INK_RPC_URL,
  59144: process.env.ENVIO_LINEA_RPC_URL,
  81457: process.env.ENVIO_BLAST_RPC_URL,
  7777777: process.env.ENVIO_ZORA_RPC_URL,
};

const ABI = [
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "NAME", outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "SYMBOL", outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
] as const;

function parseArgs() {
  const out: { concurrency: number; dryRun: boolean } = { concurrency: 32, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--concurrency=")) out.concurrency = Number(a.split("=")[1]);
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

const clients: Record<number, PublicClient> = {};
function client(chainId: number): PublicClient | null {
  const url = RPC_URLS[chainId];
  if (!url) return null;
  if (!clients[chainId]) {
    clients[chainId] = createPublicClient({
      batch: { multicall: { batchSize: 1024, wait: 16 } },
      transport: http(url, { batch: { wait: 16, batchSize: 100 }, retryCount: 3, timeout: 25_000 }),
    });
  }
  return clients[chainId];
}

function sanitizeString(s: string | null | undefined): string {
  if (!s) return "";
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c >= 0x00 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) continue;
    out += ch;
  }
  return out.trim();
}

function bytes32ToString(hex: string): string {
  return sanitizeString(
    new TextDecoder().decode(
      new Uint8Array(Buffer.from(hex.slice(2), "hex").filter((n) => n !== 0))
    )
  );
}

type Repaired = { name: string; symbol: string; decimals: number } | { drop: true; reason: string };

async function tryRead<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function refetch(address: `0x${string}`, chainId: number): Promise<Repaired> {
  const c = client(chainId);
  if (!c) return { drop: true, reason: "no_rpc_for_chain" };

  const code = await tryRead(c.getCode({ address }));
  if (typeof code !== "string" || code === "0x" || code.length <= 2) {
    return { drop: true, reason: "no_bytecode" };
  }

  const [name, symbol, decimals, nameBytes32, symbolBytes32] = await Promise.all([
    tryRead(c.readContract({ address, abi: ABI, functionName: "name" }) as Promise<string>),
    tryRead(c.readContract({ address, abi: ABI, functionName: "symbol" }) as Promise<string>),
    tryRead(c.readContract({ address, abi: ABI, functionName: "decimals" })),
    tryRead(c.readContract({ address, abi: ABI, functionName: "NAME" }) as Promise<string>),
    tryRead(c.readContract({ address, abi: ABI, functionName: "SYMBOL" }) as Promise<string>),
  ]);

  const nameFailed = name === null && nameBytes32 === null;
  const symbolFailed = symbol === null && symbolBytes32 === null;
  const decimalsFailed = decimals === null;

  // If every read failed (same signature as the original poisoning), don't
  // rewrite the line — drop so the indexer can retry next sync.
  if (nameFailed && symbolFailed && decimalsFailed) {
    return { drop: true, reason: "all_reads_failed_again" };
  }

  let finalName = "unknown";
  if (name !== null) finalName = sanitizeString(name);
  else if (nameBytes32 !== null) finalName = bytes32ToString(nameBytes32);

  let finalSymbol = "UNKNOWN";
  if (symbol !== null) finalSymbol = sanitizeString(symbol);
  else if (symbolBytes32 !== null) finalSymbol = bytes32ToString(symbolBytes32);

  let finalDecimals = 18;
  if (typeof decimals === "number" && decimals <= 50) finalDecimals = decimals;

  // After all that, if we still ended up with the poison signature, drop it.
  if (finalName === "unknown" && finalSymbol === "UNKNOWN") {
    return { drop: true, reason: "still_unknown_after_retry" };
  }

  return { name: finalName || "unknown", symbol: finalSymbol || "UNKNOWN", decimals: finalDecimals };
}

type Report = {
  startedAt: string;
  finishedAt?: string;
  totalLines: number;
  poisonedFound: number;
  cleanPassedThrough: number;
  repaired: number;
  dropped: number;
  dropReasons: Record<string, number>;
  repairedByChain: Record<number, number>;
  droppedByChain: Record<number, number>;
};

async function main() {
  const { concurrency, dryRun } = parseArgs();
  console.log(`Repair concurrency=${concurrency} dryRun=${dryRun}`);

  const out = createWriteStream(OUT_PATH);
  const report: Report = {
    startedAt: new Date().toISOString(),
    totalLines: 0,
    poisonedFound: 0,
    cleanPassedThrough: 0,
    repaired: 0,
    dropped: 0,
    dropReasons: {},
    repairedByChain: {},
    droppedByChain: {},
  };

  type Poisoned = { address: `0x${string}`; chainId: number; key: string };
  const queue: Poisoned[] = [];
  let streamDone = false;

  // Worker pool repairs from `queue`.
  const start = Date.now();
  const worker = async () => {
    while (!streamDone || queue.length) {
      if (queue.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      const p = queue.shift()!;
      const result = await refetch(p.address, p.chainId);
      if ("drop" in result) {
        report.dropped++;
        report.dropReasons[result.reason] = (report.dropReasons[result.reason] ?? 0) + 1;
        report.droppedByChain[p.chainId] = (report.droppedByChain[p.chainId] ?? 0) + 1;
      } else {
        const value = `{"name": ${JSON.stringify(result.name)}, "symbol": ${JSON.stringify(result.symbol)}, "decimals": ${result.decimals}}`;
        out.write(`${p.key}\t${value}\n`);
        report.repaired++;
        report.repairedByChain[p.chainId] = (report.repairedByChain[p.chainId] ?? 0) + 1;
      }
      const done = report.repaired + report.dropped;
      if (done % 500 === 0 && done > 0) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = done / elapsed;
        const remaining = report.poisonedFound - done + (streamDone ? 0 : queue.length);
        const eta = rate > 0 ? remaining / rate : 0;
        console.log(`  repaired=${report.repaired} dropped=${report.dropped} queueDepth=${queue.length} rate=${rate.toFixed(1)}/s eta=${(eta / 60).toFixed(1)}min`);
      }
    }
  };
  const workers = Array.from({ length: concurrency }, worker);

  const rl = createInterface({ input: createReadStream(CACHE_PATH), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    report.totalLines++;
    if (lineNo === 1 && line.startsWith("id\t")) {
      out.write(line + "\n");
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) {
      out.write(line + "\n");
      continue;
    }
    const isPoisoned =
      line.includes('"name": "unknown"') || line.includes('"symbol": "UNKNOWN"');
    if (!isPoisoned) {
      out.write(line + "\n");
      report.cleanPassedThrough++;
      continue;
    }
    report.poisonedFound++;
    const key = line.slice(0, tab);
    try {
      const [address, chainId] = JSON.parse(key) as [string, number];
      if (dryRun) {
        report.dropped++;
        continue;
      }
      // Backpressure: if queue is huge, wait a bit.
      while (queue.length > concurrency * 8) {
        await new Promise((r) => setTimeout(r, 20));
      }
      queue.push({ address: address as `0x${string}`, chainId, key });
    } catch {
      // unparseable key — pass through unchanged
      out.write(line + "\n");
    }
    if (lineNo % 100_000 === 0) {
      console.log(`  read ${lineNo.toLocaleString()} lines | poisoned=${report.poisonedFound} queueDepth=${queue.length}`);
    }
  }
  streamDone = true;
  console.log("Input stream finished, draining workers…");
  await Promise.all(workers);

  out.end();
  report.finishedAt = new Date().toISOString();
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("\n=== Repair report ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nOutput: ${OUT_PATH}`);
  console.log(`Report: ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
