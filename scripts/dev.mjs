/*
 * Thin wrapper around `envio dev` that derives per-config storage settings.
 *
 * A single-chain config is a DIFFERENT dataset from the multi-chain one, with a
 * different `name:`. Sharing storage with it trips envio's incompatible-config
 * guard, so each config needs its own schema and ClickHouse database:
 *
 *   config.ethereum.yaml   -> ethereum
 *   config.yaml (or unset) -> public   (envio's own default)
 *
 * This exists because the alternative — remembering to pass ENVIO_PG_SCHEMA on
 * every invocation — has already failed twice in practice. An explicit value
 * still wins.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf("--config");
const configPath =
  flagIndex >= 0 && argv[flagIndex + 1] ? argv[flagIndex + 1] : process.env.ENVIO_CONFIG;

function slugFor(p) {
  if (!p) return null;
  const m = /^config\.(.+)\.yaml$/.exec(p.replace(/^.*\//, ""));
  if (!m) return null;
  const slug = m[1].replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return slug.length ? slug : null;
}

const slug = slugFor(configPath);
const env = {
  ...process.env,
  ENVIO_PG_SCHEMA: process.env.ENVIO_PG_SCHEMA ?? slug ?? "public",
  ENVIO_CLICKHOUSE_DATABASE: process.env.ENVIO_CLICKHOUSE_DATABASE ?? slug ?? "default",
};

console.log(
  `dev: config=${configPath ?? "config.yaml"} pgSchema=${env.ENVIO_PG_SCHEMA} ` +
    `clickhouseDb=${env.ENVIO_CLICKHOUSE_DATABASE}` +
    (process.env.GRAPH_API_CHAIN_ID ? ` graphApi=chain ${process.env.GRAPH_API_CHAIN_ID}` : ""),
);


/*
 * Heal the local ClickHouse container's host auth before starting.
 *
 * The clickhouse image restricts `default` to localhost when no password is set,
 * and envio connects from the HOST via the published port — so it is refused.
 * The users.d drop-in that fixes it lives in the container filesystem and does
 * NOT survive a recreate, which a Docker Desktop restart does routinely. This
 * has broken startup four times, always presenting as an opaque
 * "ClickHouse resume failed", so heal it here instead of after the fact.
 *
 * Only runs when the chosen config actually enables ClickHouse storage.
 */
function clickhouseEnabled(configPath) {
  try {
    const text = readFileSync(configPath ?? "config.yaml", "utf8");
    const storage = /\nstorage:\s*\n((?:[ \t]+.*\n)+)/.exec(text);
    return storage ? /clickhouse:\s*true/.test(storage[1]) : false;
  } catch {
    return false;
  }
}

async function healClickhouse() {
  const port = process.env.ENVIO_CLICKHOUSE_PORT ?? "8123";
  const ok = async () => {
    try {
      const res = await fetch(`http://localhost:${port}/?query=SELECT%201`, {
        headers: { "x-clickhouse-user": "default", "x-clickhouse-key": "" },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok && (await res.text()).trim() === "1";
    } catch {
      return false;
    }
  };
  // A refused connection here is usually "not started yet" rather than "auth
  // broken" — envio brings the container up itself, so only heal a container
  // that already exists.
  try {
    execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", "envio-clickhouse"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return;
  }
  if (await ok()) return;
  console.log("dev: ClickHouse refuses host connections — re-applying the users.d fix");
  try {
    execFileSync("node", ["scripts/clickhouse-allow-host.mjs"], { stdio: "inherit" });
  } catch {
    console.error("dev: could not heal ClickHouse automatically; run `pnpm clickhouse:allow-host`");
  }
}

if (clickhouseEnabled(configPath)) await healClickhouse();

const child = spawn("pnpm", ["envio", "dev", ...argv], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
