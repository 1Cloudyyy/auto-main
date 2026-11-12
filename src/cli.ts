#!/usr/bin/env node
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import type { SoulFireBot, SoulFireInstance } from "@soulfiremc/sdk";
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
import { DEFAULT_MINER_CONFIG, normalizeAnarchy, runMiner } from "./miner/runner.js";
import type { MinerConfig } from "./miner/runner.js";
import { runCollector } from "./miner/collector.js";
import type { CollectorConfig } from "./miner/collector.js";
import { runFarm } from "./farm/loop.js";
import type { FarmOptions } from "./farm/loop.js";
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
  auto-main mine [options]         switch anarchy, warp and mine until a budget is hit
  auto-main collect [options]      same, but uses the built-in SoulFire collectBlocks task
  auto-main farm [options]         rotation: dispatcher -> anarchy -> warp -> collect -> next

farm options:
  --iterations 3                   number of mines (0 = until stopped)
  --max 60                         blocks per mine
  --radius 24                      search radius per mine
  --seconds 120                    per-mine deadline
  --idle-ms 5000                   pause between mines
  --empty-runs 2                   stop after N empty mines in a row

collect options:
  --anarchy 226                    anarchy number or full command
  --warp mine                      warp command
  --max 60                         stop after this many blocks
  --radius 24                      search radius (max 64)
  --seconds 120                    task deadline
  --path-timeout 25                per-path deadline, seconds
  --ore minecraft:diamond_ore,...  block ids to collect
  --start                          start the bot if it is offline

mine options:
  --anarchy 205                    anarchy number or full command
  --warp mine                      warp command (default /warp mine)
  --seconds 180                    time budget
  --max-dig 150                    block budget
  --pickaxe-slot 1                 hotbar slot (1-9) with the pickaxe
  --radius 40                      findBlocks radius
  --batch 20                       planned targets per scan
  --reach 4.5                      dig without walking under this distance
  --step-ms 120                    pause after each dig
  --goto-ms 12000                  pathfinding deadline per target
  --anarchy-wait-ms 20000          wait after the anarchy switch
  --warp-wait-ms 12000             wait after the warp
  --start                          start the bot if it is offline

Settings come from the SoulFire plugin page (instance namespace "auto-main").
Pass --offline to skip SoulFire and use env/config only.

record options:
  --commands "/an205,/warp mine"   comma-separated commands (default: /warp mine)
  --wait 15000                     wait after each command, ms
  --pickaxe-slot 1                 hotbar slot (1-9) with the pickaxe
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
    case "mine":
      void runMine(config, log, flags);
      return;
    case "collect":
      void runCollect(config, log, flags);
      return;
    case "farm":
      void runFarmCommand(config, log, flags);
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

async function runMine(baseConfig: AppConfig, log: Logger, flags: Flags): Promise<void> {
  const config =
    flags["offline"] === true ? baseConfig : await resolveConfigWithSoulFire(baseConfig, log);
  const anarchy = typeof flags["anarchy"] === "string" ? flags["anarchy"] : undefined;
  const minerConfig: MinerConfig = {
    ...DEFAULT_MINER_CONFIG,
    warp: stringFlag(flags, "warp", "mine"),
    ...(anarchy === undefined ? {} : { anarchy }),
    pickaxeSlot: numberFlag(flags, "pickaxe-slot", DEFAULT_MINER_CONFIG.pickaxeSlot),
    radius: numberFlag(flags, "radius", DEFAULT_MINER_CONFIG.radius),
    maxDigs: numberFlag(flags, "max-dig", DEFAULT_MINER_CONFIG.maxDigs),
    maxSeconds: numberFlag(flags, "seconds", DEFAULT_MINER_CONFIG.maxSeconds),
    batchSize: numberFlag(flags, "batch", DEFAULT_MINER_CONFIG.batchSize),
    stepDelayMs: numberFlag(flags, "step-ms", DEFAULT_MINER_CONFIG.stepDelayMs),
    reach: numberFlag(flags, "reach", DEFAULT_MINER_CONFIG.reach),
    goToTimeoutMs: numberFlag(flags, "goto-ms", DEFAULT_MINER_CONFIG.goToTimeoutMs),
    anarchyWaitMs: numberFlag(flags, "anarchy-wait-ms", DEFAULT_MINER_CONFIG.anarchyWaitMs),
    warpWaitMs: numberFlag(flags, "warp-wait-ms", DEFAULT_MINER_CONFIG.warpWaitMs),
  };

  const program = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectClient(config);
      const instance = yield* resolveInstance(client, config.soulfire.instance);
      const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);
      const label = entry.accountName ?? entry.profileId;

      if (!entry.isOnline) {
        if (flags["start"] !== true) {
          return yield* Effect.fail(
            new Error(`Bot "${label}" is offline. Attach to a running bot or pass --start.`),
          );
        }
        log.info({ bot: label }, "bot is offline, starting");
        yield* bot.start();
        yield* waitOnline(instance, entry.profileId, 120_000);
      }

      if (config.runtime.testMode) {
        log.info("test mode: base trips are disabled");
      }

      log.info({ bot: label, ...minerConfig }, "mining started");
      const result = yield* Effect.promise(() => runMiner(bot, minerConfig, log));
      log.info({ bot: label, ...result }, "mining done");
    }),
  );

  NodeRuntime.runMain(program);
}

async function runFarmCommand(baseConfig: AppConfig, log: Logger, flags: Flags): Promise<void> {
  const config =
    flags["offline"] === true ? baseConfig : await resolveConfigWithSoulFire(baseConfig, log);
  const oreIds =
    flags["ore"] === undefined
      ? DEFAULT_ORE_IDS
      : stringFlag(flags, "ore", "")
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);

  const options: FarmOptions = {
    policy: targetPolicy(config),
    collect: {
      oreIds,
      radius: numberFlag(flags, "radius", 24),
      maxCount: numberFlag(flags, "max", 60),
      deadlineMs: numberFlag(flags, "seconds", 120) * 1000,
      pathTimeoutSeconds: numberFlag(flags, "path-timeout", 25),
    },
    minesApiUrl: config.mines.apiUrl,
    serverTypes: config.mines.serverTypes,
    warp: stringFlag(flags, "warp", "mine"),
    anarchyWaitMs: numberFlag(flags, "anarchy-wait-ms", 28_000),
    warpWaitMs: numberFlag(flags, "warp-wait-ms", 12_000),
    iterations: numberFlag(flags, "iterations", 3),
    idleMs: numberFlag(flags, "idle-ms", 5_000),
    maxEmptyRuns: numberFlag(flags, "empty-runs", 2),
  };

  const program = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectClient(config);
      const instance = yield* resolveInstance(client, config.soulfire.instance);
      const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);
      const label = entry.accountName ?? entry.profileId;

      let stopping = false;
      const stop = (): void => {
        stopping = true;
        log.info("stop requested, finishing the current mine");
      };
      process.once("SIGINT", stop);

      try {
        log.info({ bot: label, iterations: options.iterations }, "farm started");
        const runs = yield* Effect.promise(() =>
          runFarm(bot, instance, entry.profileId, options, log, () => stopping),
        );
        const total = runs.reduce((sum, run) => sum + run.blocksBroken, 0);
        log.info({ mines: runs.length, blocksBroken: total }, "farm finished");
        process.stdout.write(`${formatFarmTable(runs)}\n`);
      } finally {
        process.off("SIGINT", stop);
      }
    }),
  );

  NodeRuntime.runMain(program);
}

function formatFarmTable(
  runs: readonly { anarchy: string; command: string; status: string; blocksBroken: number; elapsedMs: number }[],
): string {
  const header = ["anarchy", "command", "status", "blocks", "time"];
  const rows = runs.map((run) => [
    run.anarchy,
    run.command,
    run.status,
    String(run.blocksBroken),
    `${Math.round(run.elapsedMs / 1000)}s`,
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

async function runCollect(baseConfig: AppConfig, log: Logger, flags: Flags): Promise<void> {
  const config =
    flags["offline"] === true ? baseConfig : await resolveConfigWithSoulFire(baseConfig, log);
  const anarchy = typeof flags["anarchy"] === "string" ? flags["anarchy"] : undefined;
  const warp = stringFlag(flags, "warp", "mine");
  const oreIds =
    flags["ore"] === undefined
      ? DEFAULT_ORE_IDS
      : stringFlag(flags, "ore", "")
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);

  const collector: CollectorConfig = {
    oreIds,
    radius: numberFlag(flags, "radius", 24),
    maxCount: numberFlag(flags, "max", 60),
    deadlineMs: numberFlag(flags, "seconds", 120) * 1000,
    pathTimeoutSeconds: numberFlag(flags, "path-timeout", 25),
  };

  const program = Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectClient(config);
      const instance = yield* resolveInstance(client, config.soulfire.instance);
      const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);
      const label = entry.accountName ?? entry.profileId;

      if (!entry.isOnline) {
        if (flags["start"] !== true) {
          return yield* Effect.fail(
            new Error(`Bot "${label}" is offline. Attach to a running bot or pass --start.`),
          );
        }
        log.info({ bot: label }, "bot is offline, starting");
        yield* bot.start();
        yield* waitOnline(instance, entry.profileId, 120_000);
      }

      const lease = yield* bot.acquireControl(120);
      try {
        if (anarchy !== undefined && anarchy.trim() !== "") {
          const command = normalizeAnarchy(anarchy);
          log.info({ command }, "switching anarchy");
          yield* bot.sendChat(command);
          yield* sleep(numberFlag(flags, "anarchy-wait-ms", 20_000));
        }

        const warpCommand = warp.startsWith("/") ? warp : `/warp ${warp}`;
        log.info({ command: warpCommand }, "warping to the mine");
        yield* bot.sendChat(warpCommand);
        yield* sleep(numberFlag(flags, "warp-wait-ms", 12_000));
        yield* bot.waitForChunks();

        if (!(yield* waitForMinePosition(bot, 15_000))) {
          log.warn("not at the mine after the first warp, retrying");
          yield* bot.sendChat(warpCommand);
          yield* sleep(numberFlag(flags, "warp-wait-ms", 12_000));
          yield* waitForMinePosition(bot, 15_000);
        }
      } finally {
        yield* Effect.promise(() =>
          Effect.runPromise(lease.release()).then(
            () => undefined,
            () => undefined,
          ),
        );
      }

      log.info({ bot: label, ...collector }, "collect started");
      const result = yield* Effect.promise(() => runCollector(bot, collector, log));
      log.info({ bot: label, ...result }, "collect done");
    }),
  );

  NodeRuntime.runMain(program);
}

const waitForMinePosition = (bot: SoulFireBot, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    const bounds = DEFAULT_MINER_CONFIG;

    while (Date.now() < deadline) {
      const state = yield* bot.liveState();
      const inside =
        state.x >= (bounds.minX ?? 0) - 2 &&
        state.x <= (bounds.maxX ?? 0) + 2 &&
        state.z >= (bounds.minZ ?? 0) - 2 &&
        state.z <= (bounds.maxZ ?? 0) + 2;
      const atWarp = Math.abs(state.x - 61) <= 6 && Math.abs(state.z - 2) <= 6 && state.y >= 80;

      if (inside || atWarp) {
        return true;
      }
      yield* sleep(1_000);
    }

    return false;
  });

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







