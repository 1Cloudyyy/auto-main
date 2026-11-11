import type { AppConfig } from "./config.js";
import type { TargetPolicy } from "./mines/dispatcher.js";

/**
 * Builds the effective target policy from config.
 *
 * The clan-home anarchy is a transit hub (and hosts the base), so it is never
 * farmed: it is merged into the deny list even if the user forgot about it.
 */
export function targetPolicy(config: AppConfig): TargetPolicy {
  const deny = [...config.targets.deny];
  const home = config.base.homeAnarchy?.trim();
  if (home !== undefined && home !== "" && !deny.includes(home)) {
    deny.push(home);
  }

  return {
    strategy: config.targets.strategy,
    travelMs: config.targets.travelMs,
    minLeadMs: config.targets.minLeadMs,
    maxLeadMs: config.targets.maxLeadMs,
    rarity: config.targets.rarity,
    allow: config.targets.allow,
    deny,
  };
}
