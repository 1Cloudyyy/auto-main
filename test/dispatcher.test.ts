import { describe, expect, it } from "vitest";
import {
  createDispatcherState,
  planNextTarget,
  rarityRank,
  selectCandidates,
  type TargetPolicy,
} from "../src/mines/dispatcher.js";
import type { MineEntry } from "../src/mines/types.js";

const basePolicy: TargetPolicy = {
  strategy: "timer",
  travelMs: 25_000,
  minLeadMs: 10_000,
  maxLeadMs: 90_000,
  rarity: ["legendary", "mythical", "default"],
  allow: [],
  deny: [],
};

function mine(serverKey: string, rarity: string, resetMsLeft: number): MineEntry {
  return {
    serverKey,
    serverName: serverKey.replace("anarchy", "Анархия-"),
    mineName: "mine-1",
    rarity,
    nextRarity: "default",
    resetMsLeft,
    observedAtMs: 0,
  };
}

describe("selectCandidates", () => {
  const entries = [mine("anarchy101", "default", 1000), mine("anarchy202", "mythical", 1000)];

  it("returns everything without filters", () => {
    expect(selectCandidates(entries, basePolicy)).toHaveLength(2);
  });

  it("respects the allow list by server key, number and name", () => {
    expect(selectCandidates(entries, { ...basePolicy, allow: ["202"] })).toHaveLength(1);
    expect(selectCandidates(entries, { ...basePolicy, allow: ["anarchy101"] })).toHaveLength(1);
    expect(selectCandidates(entries, { ...basePolicy, allow: ["Анархия-101"] })).toHaveLength(1);
  });

  it("deny wins over allow", () => {
    expect(selectCandidates(entries, { ...basePolicy, allow: ["101"], deny: ["101"] })).toHaveLength(0);
  });
});

describe("rarityRank", () => {
  it("orders rarity by policy and puts unknown last", () => {
    expect(rarityRank("legendary", basePolicy.rarity)).toBe(0);
    expect(rarityRank("default", basePolicy.rarity)).toBe(2);
    expect(rarityRank("epic", basePolicy.rarity)).toBe(3);
  });
});

describe("planNextTarget (timer)", () => {
  it("prefers a mine that resets while the bot travels", () => {
    const entries = [mine("anarchy101", "default", 300_000), mine("anarchy202", "default", 35_000)];
    const plan = planNextTarget(entries, basePolicy, createDispatcherState());
    expect(plan?.entry.serverKey).toBe("anarchy202");
  });

  it("lets rarity win between equally timed mines", () => {
    const entries = [mine("anarchy101", "default", 35_000), mine("anarchy202", "legendary", 35_000)];
    const plan = planNextTarget(entries, basePolicy, createDispatcherState());
    expect(plan?.entry.serverKey).toBe("anarchy202");
  });

  it("falls back to the soonest reset when everything is beyond the horizon", () => {
    const entries = [mine("anarchy101", "default", 400_000), mine("anarchy202", "default", 300_000)];
    const plan = planNextTarget(entries, basePolicy, createDispatcherState());
    expect(plan?.entry.serverKey).toBe("anarchy202");
    expect(plan?.reason).toContain("no mine inside horizon");
  });

  it("returns undefined when nothing matches the policy", () => {
    const entries = [mine("anarchy101", "default", 1000)];
    expect(planNextTarget(entries, { ...basePolicy, deny: ["101"] }, createDispatcherState())).toBeUndefined();
  });
});

describe("planNextTarget (round_robin)", () => {
  it("walks the ranked list and wraps around", () => {
    const policy: TargetPolicy = { ...basePolicy, strategy: "round_robin", rarity: ["legendary", "default"] };
    const entries = [mine("anarchy101", "default", 1000), mine("anarchy202", "legendary", 5000)];
    const state = createDispatcherState();

    expect(planNextTarget(entries, policy, state)?.entry.serverKey).toBe("anarchy202");
    expect(planNextTarget(entries, policy, state)?.entry.serverKey).toBe("anarchy101");
    expect(planNextTarget(entries, policy, state)?.entry.serverKey).toBe("anarchy202");
  });
});
