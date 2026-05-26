/*
 * Streams the effect cache, finds every "unknown"/"UNKNOWN" entry, and re-queries
 * each address on the right chain via the RPCs in .env. Classifies the failure
 * mode and writes one JSON line per probe to scripts/probe-results.jsonl.
 *
 * Run with:
 *   node --env-file=.env --import tsx scripts/probe-poisoned-tokens.ts [--chain=ID] [--limit=N] [--concurrency=N]
 *
 * Resumable: if probe-results.jsonl exists, already-probed keys are skipped.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { createPublicClient, http, type PublicClient } from "viem";

const CACHE_PATH = ".envio/cache/getTokenMetadata.tsv";
const OUT_PATH = "scripts/probe-results.jsonl";

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

type Poisoned = { key: string; address: `0x${string}`; chainId: number };

function parseArgs() {
  const out: { limit?: number; chainFilter?: number; concurrency: number } = {
    concurrency: 32,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--limit=")) out.limit = Number(a.split("=")[1]);
    else if (a.startsWith("--chain=")) out.chainFilter = Number(a.split("=")[1]);
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.split("=")[1]);
  }
  return out;
}

async function streamPoisoned(filter?: (p: Poisoned) => boolean): Promise<Poisoned[]> {
  const rl = createInterface({ input: createReadStream(CACHE_PATH), crlfDelay: Infinity });
  const entries: Poisoned[] = [];
  for await (const line of rl) {
    if (!line.includes('"name": "unknown"') && !line.includes('"symbol": "UNKNOWN"')) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab);
    try {
      const [address, chainId] = JSON.parse(key) as [string, number];
      const p: Poisoned = { key, address: address as `0x${string}`, chainId };
      if (filter && !filter(p)) continue;
      entries.push(p);
    } catch {
      /* skip */
    }
  }
  return entries;
}

function loadAlreadyProbed(): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(OUT_PATH)) return seen;
  const text = readFileSync(OUT_PATH, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { key: string };
      seen.add(o.key);
    } catch { /* ignore */ }
  }
  return seen;
}

const clients: Record<number, PublicClient> = {};
function client(chainId: number): PublicClient | null {
  const url = RPC_URLS[chainId];
  if (!url) return null;
  if (!clients[chainId]) {
    clients[chainId] = createPublicClient({
      batch: { multicall: { batchSize: 1024, wait: 16 } },
      transport: http(url, { batch: { wait: 16, batchSize: 100 }, retryCount: 2, timeout: 20_000 }),
    });
  }
  return clients[chainId];
}

type Outcome = {
  key: string;
  address: string;
  chainId: number;
  bytecodeLen: number;
  name: string | { error: string };
  symbol: string | { error: string };
  decimals: number | { error: string };
  nameBytes32: string | { error: string };
  symbolBytes32: string | { error: string };
  category: string;
};

async function tryRead<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e: any) {
    const msg = (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 200);
    return { error: msg };
  }
}

function classify(o: Omit<Outcome, "category">): string {
  if (o.bytecodeLen === 0) return "no_bytecode";
  const nameOk = typeof o.name === "string";
  const symOk = typeof o.symbol === "string";
  const decOk = typeof o.decimals === "number";
  const nameB = typeof o.nameBytes32 === "string";
  const symB = typeof o.symbolBytes32 === "string";
  if (nameOk && symOk && decOk) return "now_returns_metadata";
  if ((nameB || symB) && decOk) return "bytes32_only";
  if (decOk && !nameOk && !symOk && !nameB && !symB) return "decimals_only";
  if (!nameOk && !symOk && !decOk && !nameB && !symB) return "all_revert";
  return "partial";
}

async function probe(p: Poisoned): Promise<Outcome | null> {
  const c = client(p.chainId);
  if (!c) return null;
  const code = await tryRead(c.getCode({ address: p.address }));
  const bytecodeLen = typeof code === "string" ? (code.length - 2) / 2 : 0;
  const [name, symbol, decimals, nameBytes32, symbolBytes32] = await Promise.all([
    tryRead(c.readContract({ address: p.address, abi: ABI, functionName: "name" }) as Promise<string>),
    tryRead(c.readContract({ address: p.address, abi: ABI, functionName: "symbol" }) as Promise<string>),
    tryRead(c.readContract({ address: p.address, abi: ABI, functionName: "decimals" }).then(Number)),
    tryRead(c.readContract({ address: p.address, abi: ABI, functionName: "NAME" }) as Promise<string>),
    tryRead(c.readContract({ address: p.address, abi: ABI, functionName: "SYMBOL" }) as Promise<string>),
  ]);
  const partial = { key: p.key, address: p.address, chainId: p.chainId, bytecodeLen, name, symbol, decimals, nameBytes32, symbolBytes32 };
  return { ...partial, category: classify(partial) };
}

async function main() {
  const { limit, chainFilter, concurrency } = parseArgs();
  const already = loadAlreadyProbed();
  console.log(`Already probed: ${already.size}`);

  console.log("Streaming cache for poisoned entries…");
  let entries = await streamPoisoned((p) =>
    (!chainFilter || p.chainId === chainFilter) && !already.has(p.key)
  );
  if (limit) entries = entries.slice(0, limit);
  console.log(`Probing ${entries.length} new entries with concurrency=${concurrency}…`);

  const out = createWriteStream(OUT_PATH, { flags: "a" });

  const counts: Record<string, number> = {};
  let done = 0;
  const start = Date.now();
  const queue = entries.slice();
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()!;
      const r = await probe(p);
      if (!r) continue;
      counts[r.category] = (counts[r.category] ?? 0) + 1;
      out.write(JSON.stringify(r) + "\n");
      done++;
      if (done % 500 === 0) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = done / elapsed;
        const eta = (entries.length - done) / rate;
        console.log(`  ${done}/${entries.length}  (${rate.toFixed(1)}/s, ETA ${(eta / 60).toFixed(1)} min)`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  out.end();

  console.log("\n=== Category counts (this run) ===");
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  console.log(`\nWrote ${done} results to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
