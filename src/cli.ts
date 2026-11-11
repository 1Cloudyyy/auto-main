#!/usr/bin/env node
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import type { SoulFireInstance } from "@soulfiremc/sdk";
import { loadConfig, loadDotEnv } from "./config.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./log.js";
import type { Logger } from "./log.js";
import { fetchMines } from "./mines/client.js";
import { createDispatcherState, planNextTarget, rankCandidates, selectCandidates } from "./mines/dispatcher.js";
import type { DispatcherState, TargetPlan, TargetPolicy } from "./mines/dispatcher.js";
import { anarchyCommand } from "./mines/types.js";
import type { MineEntry } from "./mines/types.js";
import { targetPolicy } from "./policy.js";
import { connectClient, resolveBot, resolveInstance } from "./soulfire/connect.js";
import {
  applyPluginSettings,
  resolveConfigWithSoulFire,
  readSettingsNamespace,
  SETTINGS_NAMESPACE,
} from "./soulfire/settings.js";
import { DEFAULT_ORE_IDS, runRecorder } from "./soulfire/recorder.js";
import { formatDuration } from "./util/time.js";

type Flags = Record<string, string | true>;

const HELP = `auto-main — FunTime auto-mine farm controller

Usage:
  auto-main doctor                 check SoulFire connection, instance and bots
  auto-main mines [--watch] [--json] [--limit N] [--offline]
                                   poll the mines API and print the chosen target
  auto-main record [options]       attach to a bot, run commands, dump ore snapshot

Settings come from the SoulFire plugin page (instance namespace "auto-main").
Pass --offline to skip SoulFire and use env/config only.

record options:
  --commands "/an205,/warp mine"   comma-separated commands (default: /warp mine)
  --wait 15000                     wait after each command, ms
  --radius 40                      findBlocks radius
  --max 2000                       findBlocks result cap
  --out var/record.jsonl           JSONL output file
  --ore minecraft:diamond_ore,...  override ore block ids
  --start                          start the bot if it is offline

Environment: see .env.example. Config precedence: env > config/app.yaml > defaults.
`;

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const log = createLogger({ level: config.runtime.logLevel });

  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command ?? "help") {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "doctor":
      runDoctor(config, log);
      return;
    case "mines":
      void runMines(config, log, flags);
      return;
    case "record":
      void runRecord(config, log, flags);
      return;
    default:
      log.error({ command }, "unknown command");
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

function runDoctor(config: AppConfig, log: Logger): void {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectClient(config);
      log.info(
        {
          id: client.server.id,
          version: client.server.version,
          minecraft: client.server.minecraftVersion,
        },
        "connected to SoulFire",
      );

      const instances = yield* client.instances();
      log.info(
        { instances: instances.map((instance) => `${instance.friendlyName} (${instance.id})`) },
        "instances",
      );

      const instance = yield* resolveInstance(client, config.soulfire.instance);
      const info = yield* instance.info();
      const pluginSettings = readSettingsNamespace(info, SETTINGS_NAMESPACE);
      const effective = applyPluginSettings(config, pluginSettings);
      log.info(
        {
          namespace: SETTINGS_NAMESPACE,
          testMode: effective.runtime.testMode,
          homeAnarchy: effective.base.homeAnarchy ?? null,
          strategy: effective.targets.strategy,
          raw: pluginSettings,
        },
        "plugin settings",
      );
      const { entry } = yield* resolveBot(instance, config.soulfire.bot);
      const bots = yield* instance.bots();

      log.info(
        {
          bots: bots.map((bot) => ({
            name: bot.accountName ?? null,
            id: bot.profileId,
            online: bot.isOnline,
            position: bot.liveState
              ? [Math.round(bot.liveState.x), Math.round(bot.liveState.y), Math.round(bot.liveState.z)]
              : null,
          })),
        },
        "bots",
      );

      log.info({ selected: entry.accountName ?? entry.profileId, online: entry.isOnline }, "selected bot");
      if (!entry.isOnline) {
        log.warn("selected bot is offline: recorder can only attach to a running bot");
      }
    }),
  );

  NodeRuntime.runMain(program);
}

async function runMines(baseConfig: AppConfig, log: Logger, flags: Flags): Promise<void> {
  const config =
    flags["offline"] === true ? baseConfig : await resolveConfigWithSoulFire(baseConfig, log);
  const asJson = flags["json"] === true;
  const watch = flags["watch"] === true;
  const limit = numberFlag(flags, "limit", 25);
  const state = createDispatcherState();
  const policy = targetPolicy(config);

  const pullOnce = async (): Promise<void> => {
    const entries = await fetchMines({
      apiUrl: config.mines.apiUrl,
      serverTypes: config.mines.serverTypes,
      timeoutMs: 10_000,
    });
    const plan = planNextTarget(entries, policy, state);

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), plan, entries })}\n`);
      return;
    }

    printMines(entries, plan, limit, policy, log);
  };

  try {
    await pullOnce();
  } catch (error) {
    log.error({ err: errorMessage(error) }, "mines poll failed");
    process.exitCode = 1;
    return;
  }

  if (!watch) {
    return;
  }

  const timer = setInterval(() => {
    void pullOnce().catch((error: unknown) => log.error({ err: errorMessage(error) }, "mines poll failed"));
  }, config.mines.pollIntervalMs);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function printMines(
  entries: readonly MineEntry[],
  plan: TargetPlan | undefined,
  limit: number,
  policy: TargetPolicy,
  log: Logger,
): void {
  const candidates = selectCandidates(entries, policy);
  const ranked = rankCandidates(candidates, policy).slice(0, limit);

  log.info(
    {
      total: entries.length,
      candidates: candidates.length,
      rarity: countBy(entries, (entry) => entry.rarity),
    },
    "mines snapshot",
  );

  if (plan === undefined) {
    log.warn("no target matched the policy");
    return;
  }

  const header = ["", "server", "rarity", "next", "reset", "command"];
  const widths = [2, 14, 10, 10, 8, 10];
  const lines = [formatRow(header, widths)];
  for (const entry of ranked) {
    const marker = entry.serverKey === plan.entry.serverKey ? "*" : " ";
    lines.push(
      formatRow(
        [
          marker,
          entry.serverKey,
          entry.rarity,
          entry.nextRarity,
          formatDuration(entry.resetMsLeft),
          anarchyCommand(entry.serverKey) ?? "-",
        ],
        widths,
      ),
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  log.info(
    {
      target: plan.entry.serverKey,
      command: anarchyCommand(plan.entry.serverKey),
      resetIn: formatDuration(plan.resetInMs),
      reason: plan.reason,
    },
    "target",
  );
}

async function runRecord(baseConfig: AppConfig, log: Logger, flags: Flags): Promise<void> {
  const config =
    flags["offline"] === true ? baseConfig : await resolveConfigWithSoulFire(baseConfig, log);
  const commands = stringFlag(flags, "commands", "/warp mine")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const waitMs = numberFlag(flags, "wait", 15_000);
  const radius = numberFlag(flags, "radius", 40);
  const maxCount = numberFlag(flags, "max", 2_000);
  const outFile = stringFlag(flags, "out", `${config.runtime.dataDir}/record.jsonl`);
  const oreIds = flags["ore"] === undefined
    ? DEFAULT_ORE_IDS
    : stringFlag(flags, "ore", "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
  const shouldStart = flags["start"] === true;

  const program = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectClient(config);
      const instance = yield* resolveInstance(client, config.soulfire.instance);
      const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);
      const label = entry.accountName ?? entry.profileId;

      if (!entry.isOnline) {
        if (!shouldStart) {
          return yield* Effect.fail(
            new Error(`Bot "${label}" is offline. Attach to a running bot or pass --start.`),
          );
        }
        log.info({ bot: label }, "bot is offline, starting");
        yield* bot.start();
        yield* waitOnline(instance, entry.profileId, 120_000);
      }

      log.info({ bot: label, commands, waitMs, radius, maxCount, outFile }, "recording");
      const result = yield* runRecorder(bot, {
        commands,
        waitMs,
        radius,
        maxCount,
        oreIds,
        outFile,
        cwd: process.cwd(),
      });

      log.info(
        {
          bot: label,
          position: result.position,
          blocks: result.blocks.length,
          outFile,
        },
        "record done",
      );
    }),
  );

  NodeRuntime.runMain(program);
}

const waitOnline = (instance: SoulFireInstance, profileId: string, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const bots = yield* instance.bots();
      if (bots.some((bot) => bot.profileId === profileId && bot.isOnline)) {
        return;
      }
      yield* sleep(2_000);
    }
    return yield* Effect.fail(new Error(`Bot ${profileId} did not come online within ${timeoutMs} ms`));
  });

const sleep = (ms: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, ms)));

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }

    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

function stringFlag(flags: Flags, name: string, fallback: string): string {
  const value = flags[name];
  return typeof value === "string" ? value : fallback;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = flags[name];
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    result[bucket] = (result[bucket] ?? 0) + 1;
  }
  return result;
}

function formatRow(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

main();
