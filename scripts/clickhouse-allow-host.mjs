#!/usr/bin/env node
/*
 * Re-open the local ClickHouse container to host connections.
 *
 * The official clickhouse image ships /etc/clickhouse-server/users.d/default-user.xml
 * restricting `default` to 127.0.0.1 and ::1 when no CLICKHOUSE_PASSWORD is set.
 * envio connects from the HOST via the published port, so the container sees the
 * docker bridge gateway and rejects it with "Authentication failed".
 *
 * envio's own orchestration creates the container and passes only CLICKHOUSE_DB,
 * so there is no env-var lever — the users.d drop-in is the only one. It lives in
 * the container filesystem, so it survives `docker restart` but NOT a recreate,
 * which is why this needs to be re-runnable.
 *
 * The `zz-` prefix matters: files load alphabetically and default-user.xml must
 * be overridden, not preceded.
 *
 * Local development only. Never point this at a shared ClickHouse.
 */

import { execFileSync } from "node:child_process";

const CONTAINER = process.env.ENVIO_CLICKHOUSE_CONTAINER ?? "envio-clickhouse";
const TARGET = "/etc/clickhouse-server/users.d/zz-allow-host-dev.xml";

const XML = [
  "<clickhouse>",
  "  <users>",
  "    <default>",
  "      <networks replace=\"replace\"><ip>::/0</ip></networks>",
  "      <password></password>",
  "    </default>",
  "  </users>",
  "</clickhouse>",
].join("\n");

function docker(args, opts = {}) {
  // Silence stderr: the readiness poll below expects failures while the
  // container restarts, and leaking them looks like the script is broken.
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

/** The published HTTP port, which is the path that was actually failing. */
function hostPort() {
  const out = docker(["port", CONTAINER, "8123/tcp"]).trim().split("\n")[0] ?? "";
  const m = /:(\d+)$/.exec(out);
  return m ? Number(m[1]) : 8123;
}

try {
  docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]);
} catch {
  console.error(`clickhouse-allow-host: container ${CONTAINER} not found. Start the indexer once so envio creates it, then re-run.`);
  process.exit(1);
}

docker(["exec", "-i", CONTAINER, "sh", "-c", `cat > ${TARGET}`], { input: XML });

/*
 * Deliberately NO `docker restart`. ClickHouse watches users.d and hot-reloads
 * it within ~2s, and restarting drops the connections of any indexer already
 * running — which surfaces as an opaque mid-write
 * "Failed to insert items into ClickHouse table" on a process that was healthy.
 * Measured: auth is restored ~2s after the file lands, with no restart.
 */

/*
 * Verify over HTTP FROM THE HOST, not via `docker exec`. An exec'd
 * clickhouse-client connects from 127.0.0.1 inside the container, which
 * default-user.xml always permitted — so it would pass even when the thing this
 * script exists to fix is still broken.
 */
const port = hostPort();
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    const res = await fetch(`http://localhost:${port}/?query=SELECT%201`, {
      headers: { "x-clickhouse-user": "default", "x-clickhouse-key": "" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok && (await res.text()).trim() === "1") break;
  } catch {
    /* still restarting */
  }
  if (Date.now() > deadline) {
    console.error(
      `clickhouse-allow-host: ${CONTAINER} still refuses host connections on :${port} after 30s`,
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log(`clickhouse-allow-host: ${CONTAINER} accepts host connections on :${port} (${TARGET})`);
