/**
 * Regression tests for the trace-capability classifier.
 *
 * A SEPARATE FILE on purpose. `positionGuards.test.ts` does
 * `vi.doMock("viem", ...)` to fake a chain-head read, and that replaces the
 * whole module — so importing `feesAccrued` there fails on
 * `toFunctionSelector`, which the mock does not provide. A pure function that
 * can only be imported in isolation is untestable in company; the fix is its
 * own file, not a wider mock.
 */

import { describe, it, expect } from "vitest";

describe("isTraceCapabilityError — permanent gap vs recoverable failure", () => {
  /*
   * TRUE means "permanent: record ZERO collected fees and stop retrying". A
   * false positive therefore writes a zero for a transaction that really settled
   * a fee, which no consumer can distinguish from a genuine zero. These cases
   * are the realistic provider bodies that decide it.
   *
   * viem composes its message from the URL and the FULL request body, so every
   * string below is prefixed the way viem would — which is the trap: the body
   * always contains `"tracer":"callTracer"`, and Ponder's classifier matches a
   * bare `"tracer"` and so calls every failure permanent.
   */
  const viemWrap = (detail: string) =>
    `HTTP request failed.\n\nURL: https://rpc.example.com/abc\n` +
    `Request body: {"method":"debug_traceTransaction","params":["0xdead",{"tracer":"callTracer"}]}\n\n` +
    `Details: ${detail}\nVersion: 2.21.0`;

  it("is TRUE for the JSON-RPC method-missing codes", async () => {
    const { isTraceCapabilityError } = await import("./effects/feesAccrued");
    expect(isTraceCapabilityError({ code: -32601 })).toBe(true);
    expect(isTraceCapabilityError({ code: -32004 })).toBe(true);
    expect(isTraceCapabilityError({ cause: { code: -32601 } })).toBe(true);
  });

  it("is TRUE for unambiguous method-missing prose", async () => {
    const { isTraceCapabilityError } = await import("./effects/feesAccrued");
    for (const d of [
      "the method debug_traceTransaction does not exist/is not available",
      "Method not found",
      "method not supported",
      "debug_traceTransaction is not supported on your current plan",
      "the method is not enabled for this endpoint",
    ]) {
      expect(isTraceCapabilityError({ message: viemWrap(d) }), d).toBe(true);
    }
  });

  it("is FALSE for recoverable failures that merely contain the words", async () => {
    const { isTraceCapabilityError } = await import("./effects/feesAccrued");
    for (const d of [
      // The failure actually observed on this project: a plain-text body under
      // load, surfaced as a JSON parse error. Classifying it permanent would
      // record zero fees for a real collect.
      `Unexpected token 'A', "API key is"... is not valid JSON`,
      "429 Too Many Requests",
      "your account has exceeded its rate limit",
      "execution timeout",
      // Pruning: the node is fine and the method exists, this block is gone.
      "state at block 12345 is not available, pruned",
      "missing trie node",
      // A gateway HTML page.
      "<html><head><title>502 Bad Gateway</title></head></html>",
      "connection reset by peer",
    ]) {
      expect(isTraceCapabilityError({ message: viemWrap(d) }), d).toBe(false);
    }
  });

  it("is FALSE for a bare mention of the words far from the method", async () => {
    const { isTraceCapabilityError } = await import("./effects/feesAccrued");
    // Anchoring is a WINDOW, not mere co-occurrence: viem's message always
    // names debug_traceTransaction in the request body, so "unsupported"
    // appearing anywhere in a long provider blurb must not qualify.
    const far =
      viemWrap("upstream error") +
      "\n\n" +
      "x".repeat(300) +
      " this browser is unsupported, please upgrade";
    expect(isTraceCapabilityError({ message: far })).toBe(false);
  });

  it("does not repeat Ponder's mistake of matching the tracer parameter", async () => {
    const { isTraceCapabilityError } = await import("./effects/feesAccrued");
    // Ponder's `msg.includes("tracer")` makes this TRUE, which is the defect
    // that lost 333387.830400084026115227 of real collected fees on tokenId 926.
    expect(isTraceCapabilityError({ message: viemWrap("socket hang up") })).toBe(false);
  });
});
