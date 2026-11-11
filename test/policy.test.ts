import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { selectCandidates } from "../src/mines/dispatcher.js";
import type { MineEntry } from "../src/mines/types.js";
import { targetPolicy } from "../src/policy.js";

function mine(serverKey: string): MineEntry {
  return {
    serverKey,
    serverName: serverKey.replace("anarchy", "Анархия-"),
    mineName: "mine-1",
    rarity: "default",
    nextRarity: "default",
    resetMsLeft: 60_000,
    observedAtMs: 0,
  };
}

describe("targetPolicy", () => {
  it("keeps config untouched when no home anarchy is set", () => {
    const config = loadConfig({ env: { SF_TOKEN: "t" }, cwd: process.cwd() });
    const policy = targetPolicy(config);

    expect(policy.deny).toEqual([]);
    expect(policy.strategy).toBe("timer");
  });

  it("always denies the clan-home anarchy", () => {
    const config = loadConfig({
      env: { SF_TOKEN: "t", BASE_HOME_ANARCHY: "302" },
      cwd: process.cwd(),
    });
    const policy = targetPolicy(config);

    expect(policy.deny).toContain("302");

    const entries = [mine("anarchy302"), mine("anarchy311")];
    const candidates = selectCandidates(entries, policy);
    expect(candidates.map((entry) => entry.serverKey)).toEqual(["anarchy311"]);
  });

  it("does not duplicate an explicit deny entry", () => {
    const config = loadConfig({
      env: { SF_TOKEN: "t", BASE_HOME_ANARCHY: "302", TARGET_DENY: "302,501" },
      cwd: process.cwd(),
    });
    const policy = targetPolicy(config);

    expect(policy.deny.filter((value) => value === "302")).toHaveLength(1);
  });
});
