import { Effect, Stream } from "effect";
import type { SoulFireBot } from "@soulfiremc/sdk";
import type { Logger } from "../log.js";
import { DEFAULT_ORE_IDS } from "../soulfire/recorder.js";
import { distance, planTargets } from "./planner.js";
import type { DigTarget, OreBlock, Vec3 } from "./planner.js";

export interface MinerConfig {
  /** Anarchy number or command, e.g. `205` or `/an205`. */
  readonly anarchy?: string;
  /** Warp command, e.g. `mine` or `/warp mine`. */
  readonly warp: string;
  /** `findBlocks` radius. */
  readonly radius: number;
  /** Hard cap on broken blocks. */
  readonly maxDigs: number;
  /** Hard cap on wall-clock time. */
  readonly maxSeconds: number;
  /** Distance at which the bot digs without walking. */
  readonly reach: number;
  /** `findBlocks` batch plan size. */
  readonly batchSize: number;
  /** Pause after each dig, ms. */
  readonly stepDelayMs: number;
  /** `goTo` deadline, ms. */
  readonly goToTimeoutMs: number;
  /** Wait after the anarchy switch, ms. */
  readonly anarchyWaitMs: number;
  /** Wait after the warp, ms. */
  readonly warpWaitMs: number;
  readonly oreIds: readonly string[];
  readonly weights: Readonly<Record<string, number>>;
  readonly minY?: number;
  readonly maxY?: number;
}

export interface MinerResult {
  readonly digs: number;
  readonly scanned: number;
  readonly oreBlocks: number;
  readonly elapsedMs: number;
  readonly stopped: "budget" | "empty" | "error" | "no-progress";
}

export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  "minecraft:diamond_ore": 1,
  "minecraft:deepslate_diamond_ore": 1,
  "minecraft:gold_ore": 0.5,
  "minecraft:deepslate_gold_ore": 0.5,
  "minecraft:lapis_ore": 0.1,
  "minecraft:deepslate_lapis_ore": 0.1,
  "minecraft:redstone_ore": 0.05,
  "minecraft:deepslate_redstone_ore": 0.05,
};

export const DEFAULT_MINER_CONFIG: Omit<MinerConfig, "warp"> = {
  radius: 40,
  maxDigs: 150,
  maxSeconds: 180,
  reach: 4.5,
  batchSize: 20,
  stepDelayMs: 120,
  goToTimeoutMs: 12_000,
  anarchyWaitMs: 20_000,
  warpWaitMs: 12_000,
  oreIds: DEFAULT_ORE_IDS,
  weights: DEFAULT_WEIGHTS,
};

/**
 * Runs one mining session: switch anarchy, warp to the mine, then repeatedly
 * scan, plan bulldozer targets and dig until a budget is exhausted.
 *
 * Uses the plain Promise API on purpose: the loop is I/O bound and timeouts are
 * easier to express with `Promise.race` than with Effect scopes.
 */
export async function runMiner(
  bot: SoulFireBot,
  config: MinerConfig,
  log: Logger,
): Promise<MinerResult> {
  const started = Date.now();

  if (config.anarchy !== undefined && config.anarchy.trim() !== "") {
    const command = normalizeAnarchy(config.anarchy);
    log.info({ command }, "switching anarchy");
    await runEffect(bot.sendChat(command));
    await sleep(config.anarchyWaitMs);
  }

  const warp = config.warp.startsWith("/") ? config.warp : `/warp ${config.warp}`;
  log.info({ command: warp }, "warping to the mine");
  await runEffect(bot.sendChat(warp));
  await sleep(config.warpWaitMs);
  await runEffect(bot.waitForChunks());

  let digs = 0;
  let scanned = 0;
  let oreBlocks = 0;
  let stopped: MinerResult["stopped"] = "budget";

  const deadline = started + config.maxSeconds * 1000;

  while (Date.now() < deadline && digs < config.maxDigs) {
    const state = await runEffect(bot.liveState());
    const found = await runEffect(
      bot.findBlocks({
        blockIds: [...config.oreIds],
        maxDistance: config.radius,
        maxCount: 4000,
      }),
    );

    const ores: OreBlock[] = found.blocks.flatMap((block) => {
      const position = block.position;
      if (position === undefined) {
        return [];
      }
      return [{ x: position.x, y: position.y, z: position.z, id: block.blockId }];
    });

    scanned = ores.length;
    if (ores.length === 0) {
      stopped = "empty";
      log.info("no ore left in range");
      break;
    }

    const targets = planTargets(ores, state, config.weights, {
      window: 3,
      maxTargets: config.batchSize,
      ...(config.minY === undefined ? {} : { minY: config.minY }),
      ...(config.maxY === undefined ? {} : { maxY: config.maxY }),
    });

    if (targets.length === 0) {
      stopped = "empty";
      log.info("no valuable targets left");
      break;
    }

    let progressed = false;
    for (const target of targets) {
      if (Date.now() >= deadline || digs >= config.maxDigs) {
        break;
      }

      try {
        const current = await runEffect(bot.liveState());
        if (distance(current, target) > config.reach) {
          await goTo(bot, target, config.goToTimeoutMs);
        }

        await runEffect(bot.digBlock({ position: positionOf(target) }));
        digs += 1;
        oreBlocks += target.ores;
        progressed = true;
        log.debug(
          { digs, value: target.value, ores: target.ores, at: [target.x, target.y, target.z] },
          "dug target",
        );
      } catch (error) {
        log.warn(
          { err: errorMessage(error), at: [target.x, target.y, target.z] },
          "dig target failed",
        );
        await sleep(config.stepDelayMs);
        continue;
      }

      await sleep(config.stepDelayMs);
    }

    if (!progressed) {
      stopped = "no-progress";
      log.warn("no target could be dug in this batch");
      break;
    }
  }

  const elapsedMs = Date.now() - started;
  log.info({ digs, scanned, oreBlocks, elapsedMs, stopped }, "mining session finished");

  return { digs, scanned, oreBlocks, elapsedMs, stopped };
}

async function goTo(bot: SoulFireBot, target: Vec3, timeoutMs: number): Promise<void> {
  const stream = bot.goTo({
    goal: {
      goal: {
        case: "block",
        value: {
          position: positionOf(target),
          radius: 2,
        },
      },
    },
    options: {
      allowMining: false,
      allowPlacing: false,
      timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    },
  });

  await withTimeout(runEffect(Stream.runDrain(stream)), timeoutMs, "goTo");
}

function positionOf(target: Vec3): { x: number; y: number; z: number } {
  return { x: target.x, y: target.y, z: target.z };
}

export function normalizeAnarchy(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/an${trimmed}`;
}

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

