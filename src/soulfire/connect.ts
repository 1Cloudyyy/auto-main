import { Effect } from "effect";
import { SoulFire } from "@soulfiremc/sdk/node";
import type { BotListEntry, SoulFireBot, SoulFireClient, SoulFireInstance } from "@soulfiremc/sdk";
import type { AppConfig } from "../config.js";

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

export interface ResolvedBot {
  readonly bot: SoulFireBot;
  readonly entry: BotListEntry;
}

export const connectClient = (config: AppConfig) =>
  SoulFire.connect({
    baseUrl: config.soulfire.baseUrl,
    token: config.soulfire.token,
  });

export const resolveInstance = (client: SoulFireClient, nameOrId: string) =>
  Effect.gen(function* () {
    const instances = yield* client.instances();
    const hit =
      instances.find((instance) => instance.id === nameOrId) ??
      instances.find((instance) => instance.friendlyName === nameOrId);

    if (hit === undefined) {
      return yield* Effect.fail(
        new ResolveError(`Instance "${nameOrId}" not found. Available: ${describeInstances(instances)}`),
      );
    }

    return client.instance(hit.id);
  });

export const resolveBot = (instance: SoulFireInstance, selector?: string) =>
  Effect.gen(function* () {
    const bots = yield* instance.bots();
    const entry = pickBot(bots, selector);
    return { bot: instance.bot(entry.profileId), entry } satisfies ResolvedBot;
  });

export function pickBot(bots: readonly BotListEntry[], selector?: string): BotListEntry {
  if (bots.length === 0) {
    throw new ResolveError("Instance has no bots configured");
  }

  if (selector !== undefined && selector.trim() !== "") {
    const wanted = selector.trim();
    const normalized = wanted.toLowerCase();
    const hit =
      bots.find((bot) => bot.profileId === wanted) ??
      bots.find((bot) => (bot.accountName ?? "").toLowerCase() === normalized);

    if (hit === undefined) {
      throw new ResolveError(`Bot "${selector}" not found. Available: ${describeBots(bots)}`);
    }
    return hit;
  }

  const online = bots.filter((bot) => bot.isOnline);
  const [onlyOnline] = online;
  if (online.length === 1 && onlyOnline !== undefined) {
    return onlyOnline;
  }

  const [only] = bots;
  if (bots.length === 1 && only !== undefined) {
    return only;
  }

  throw new ResolveError(
    `Cannot pick a bot automatically (${online.length} online of ${bots.length}). ` +
      `Set SF_BOT to a name or profile id. Available: ${describeBots(bots)}`,
  );
}

function describeInstances(instances: readonly { id: string; friendlyName: string }[]): string {
  if (instances.length === 0) {
    return "none";
  }
  return instances.map((instance) => `${instance.friendlyName} (${instance.id})`).join(", ");
}

function describeBots(bots: readonly BotListEntry[]): string {
  if (bots.length === 0) {
    return "none";
  }
  return bots
    .map((bot) => `${bot.accountName ?? "<unnamed>"} (${bot.profileId}, ${bot.isOnline ? "online" : "offline"})`)
    .join(", ");
}
