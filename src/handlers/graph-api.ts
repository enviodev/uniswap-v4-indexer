/*
 * The only file under src/handlers/ that is not an event handler.
 *
 * envio auto-imports every src/handlers/**‌/*.ts into the indexer process
 * (HandlerLoader.res.mjs:41), which is the hook that lets the Graph-dialect API
 * run in-process — no separate server, no Hasura.
 *
 * It must NOT bind a port in every context that loads handlers:
 *
 *   envio dev / start  Main.res.mjs sets EnvioGlobal.value.persistence at :492,
 *                      two statements before handlers load at :494.  -> START
 *   createTestIndexer  TestIndexer.res.mjs:420 loads handlers too, and never
 *                      touches EnvioGlobal at all.                   -> SKIP
 *   envio codegen      never enters this JS path at all.             -> n/a
 *
 * So the presence of a live persistence layer is the discriminator, and the
 * whole thing is opt-in behind GRAPH_API_CHAIN_ID besides.
 */

/*
 * Everything below is dynamically imported inside a try/catch, and that is
 * load-bearing rather than defensive noise.
 *
 * `envio/src/EnvioGlobal.res.mjs` is an UNDOCUMENTED internal path — envio ships
 * no types for it and no `exports` map that promises it. A static import that
 * fails to resolve (a different packaging on the hosted platform, or a future
 * envio version moving the file) would throw at module load, and HandlerLoader
 * awaits every handler import in one Promise.all whose rejection aborts
 * `Main.start`. So an unresolvable cosmetic dependency would stop the INDEXER
 * from running, which is exactly backwards.
 *
 * Dynamic + caught means the worst case is "the API is unavailable and says so",
 * never "the indexer refuses to boot".
 */
void (async () => {
  try {
    const { value: envioGlobal } = await import("envio/src/EnvioGlobal.res.mjs");
    // A live persistence layer is what distinguishes a real indexing run from
    // createTestIndexer, which loads handlers but never sets it.
    if (envioGlobal?.persistence === undefined) return;
    const { bootGraphApi } = await import("../graph-api/boot.js");
    bootGraphApi();
  } catch (e) {
    console.error(
      `graph-api: not started, indexing continues (${e instanceof Error ? e.message : String(e)})`,
    );
  }
})();
