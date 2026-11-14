import { describe, expect, it } from "vitest";
import { summarize } from "../src/telemetry.js";
import type { RunRecord } from "../src/telemetry.js";

const run = (anarchy: string, blocksBroken: number, elapsedMs = 1000): RunRecord => ({
  ts: "2026-11-12T00:00:00.000Z",
  anarchy,
  command: `/an${anarchy}`,
  status: "6",
  blocksBroken,
  elapsedMs,
});

describe("summarize", () => {
  it("aggregates totals and per-anarchy buckets", () => {
    const summary = summarize([run("anarchy226", 42), run("anarchy226", 10), run("anarchy203", 5, 2000)]);

    expect(summary.runs).toBe(3);
    expect(summary.blocksBroken).toBe(57);
    expect(summary.totalMs).toBe(4000);
    expect(summary.perAnarchy["anarchy226"]).toEqual({ runs: 2, blocksBroken: 52 });
    expect(summary.perAnarchy["anarchy203"]).toEqual({ runs: 1, blocksBroken: 5 });
  });

  it("handles an empty journal", () => {
    expect(summarize([])).toEqual({ runs: 0, blocksBroken: 0, totalMs: 0, perAnarchy: {} });
  });
});
