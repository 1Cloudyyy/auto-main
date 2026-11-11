import type { MineEntry } from "./types.js";
import { serverNumber } from "./types.js";

export interface TargetPolicy {
  strategy: "timer" | "round_robin";
  travelMs: number;
  minLeadMs: number;
  maxLeadMs: number;
  rarity: readonly string[];
  allow: readonly string[];
  deny: readonly string[];
}

export interface DispatcherState {
  cursor: number;
}

export interface TargetPlan {
  readonly entry: MineEntry;
  /** Milliseconds until reset, as observed. */
  readonly resetInMs: number;
  readonly score: number;
  readonly reason: string;
}

/** Rarity is worth this many milliseconds of timing advantage. */
export const RARITY_WEIGHT_MS = 30_000;

export function createDispatcherState(): DispatcherState {
  return { cursor: 0 };
}

export function selectCandidates(entries: readonly MineEntry[], policy: TargetPolicy): MineEntry[] {
  return entries.filter((entry) => isAllowed(entry, policy.allow, policy.deny));
}

export function isAllowed(
  entry: MineEntry,
  allow: readonly string[],
  deny: readonly string[],
): boolean {
  const keys = identityKeys(entry);
  const denySet = new Set(deny.map(lower));
  if (keys.some((key) => denySet.has(key))) {
    return false;
  }
  if (allow.length === 0) {
    return true;
  }
  const allowSet = new Set(allow.map(lower));
  return keys.some((key) => allowSet.has(key));
}

export function rarityRank(rarity: string, order: readonly string[]): number {
  const index = order.findIndex((candidate) => candidate.toLowerCase() === rarity.toLowerCase());
  return index === -1 ? order.length : index;
}

export function rankCandidates(entries: readonly MineEntry[], policy: TargetPolicy): MineEntry[] {
  return [...entries].sort((a, b) => {
    const rarityDelta = rarityRank(a.rarity, policy.rarity) - rarityRank(b.rarity, policy.rarity);
    if (rarityDelta !== 0) {
      return rarityDelta;
    }
    return a.resetMsLeft - b.resetMsLeft;
  });
}

/**
 * Picks the next mine for a bot.
 *
 * `timer`: prefer a mine that resets while the bot travels to it (arrive just
 * after reset). `round_robin`: walk the ranked list, ignoring timing.
 */
export function planNextTarget(
  entries: readonly MineEntry[],
  policy: TargetPolicy,
  state: DispatcherState,
): TargetPlan | undefined {
  const candidates = selectCandidates(entries, policy);
  if (candidates.length === 0) {
    return undefined;
  }

  const ranked = rankCandidates(candidates, policy);

  if (policy.strategy === "round_robin") {
    const index = state.cursor % ranked.length;
    state.cursor = (index + 1) % ranked.length;
    const entry = ranked[index];
    if (entry === undefined) {
      return undefined;
    }
    return {
      entry,
      resetInMs: entry.resetMsLeft,
      score: -index,
      reason: `round_robin #${index + 1}/${ranked.length}`,
    };
  }

  const idealResetMs = policy.travelMs + policy.minLeadMs;
  const horizonMs = policy.travelMs + policy.maxLeadMs;

  let best: { entry: MineEntry; score: number } | undefined;
  for (const entry of ranked) {
    const score = timerScore(entry, policy, idealResetMs, horizonMs);
    if (best === undefined || score > best.score) {
      best = { entry, score };
    }
  }

  if (best === undefined) {
    return undefined;
  }

  const withinHorizon = best.entry.resetMsLeft <= horizonMs;
  return {
    entry: best.entry,
    resetInMs: best.entry.resetMsLeft,
    score: best.score,
    reason: withinHorizon
      ? `timer: reset in ${Math.round(best.entry.resetMsLeft / 1000)}s (${best.entry.rarity})`
      : `timer: no mine inside horizon, soonest reset in ${Math.round(best.entry.resetMsLeft / 1000)}s`,
  };
}

export function timerScore(
  entry: MineEntry,
  policy: TargetPolicy,
  idealResetMs: number,
  horizonMs: number,
): number {
  const rarityScore = -rarityRank(entry.rarity, policy.rarity) * RARITY_WEIGHT_MS;
  const timingScore = -Math.abs(entry.resetMsLeft - idealResetMs);
  const beyondHorizon = Math.max(0, entry.resetMsLeft - horizonMs);
  return rarityScore + timingScore - beyondHorizon * 5;
}

function identityKeys(entry: MineEntry): string[] {
  const keys = [entry.serverKey, entry.serverName];
  const number = serverNumber(entry.serverKey);
  if (number !== null) {
    keys.push(number);
  }
  return keys.map(lower);
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}
