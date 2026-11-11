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
  /** How long to keep rescanning while no ore is visible (chunk load / wrong spot). */
  readonly scanTimeoutMs: number;
  readonly oreIds: readonly string[];
  readonly weights: Readonly<Record<string, number>>;
  /** Mine cuboid; anything outside is ignored. */
  readonly minX?: number;
  readonly maxX?: number;
  readonly minY?: number;
  readonly maxY?: number;
  readonly minZ?: number;
  readonly maxZ?: number;
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
  radius: 24,
  maxDigs: 150,
  maxSeconds: 180,
  reach: 4.5,
  batchSize: 20,
  stepDelayMs: 120,
  goToTimeoutMs: 8_000,
  anarchyWaitMs: 20_000,
  warpWaitMs: 12_000,
  scanTimeoutMs: 30_000,
  oreIds: DEFAULT_ORE_IDS,
  weights: DEFAULT_WEIGHTS,
  minX: 69,
  maxX: 89,
  minY: 76,
  maxY: 85,
  minZ: -9,
  maxZ: 11,
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

  // Actions (chat commands, dig) require an exclusive control lease.
  const lease = await acquireLease(bot, log);
  const renewTimer = setInterval(() => {
    void runEffect(lease.renew()).catch((error: unknown) => {
      log.warn({ err: errorMessage(error) }, "control lease renew failed");
    });
  }, 60_000);

  const onSignal = (): void => {
    void runEffect(bot.stopPathfinding()).catch(() => undefined);
    void runEffect(lease.release()).catch(() => undefined);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {

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
  let emptySince: number | undefined;
  let oreBlocks = 0;
  let stopped: MinerResult["stopped"] = "budget";

  // The mining budget starts after the transitions, not after the lease wait.
  const miningStarted = Date.now();
  const deadline = miningStarted + config.maxSeconds * 1000;

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
    log.debug(
      {
        at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)],
        ores: ores.length,
      },
      "scan",
    );
    if (ores.length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince > config.scanTimeoutMs) {
        stopped = "empty";
        log.warn(
          {
            at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)],
            waitedMs: Date.now() - emptySince,
          },
          "no ore in range; check the warp and the mine cuboid",
        );
        break;
      }
      await sleep(2_000);
      continue;
    }
    emptySince = undefined;

    const targets = planTargets(ores, state, config.weights, {
      window: 3,
      maxTargets: config.batchSize,
      ...(config.minX === undefined ? {} : { minX: config.minX }),
      ...(config.maxX === undefined ? {} : { maxX: config.maxX }),
      ...(config.minY === undefined ? {} : { minY: config.minY }),
      ...(config.maxY === undefined ? {} : { maxY: config.maxY }),
      ...(config.minZ === undefined ? {} : { minZ: config.minZ }),
      ...(config.maxZ === undefined ? {} : { maxZ: config.maxZ }),
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
        const inReach = await moveWithinReach(bot, target, config, log);
        if (!inReach) {
          log.debug({ at: [target.x, target.y, target.z] }, "target unreachable, skipped");
          continue;
        }

        // Bulldozer breaks a plane perpendicular to the view: look straight down
        // so the 3x3 area is horizontal, on the target layer.
        await runEffect(bot.look(0, 90));
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
  } finally {
    clearInterval(renewTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await runEffect(lease.release());
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "control lease release failed");
    }
  }
}

async function moveWithinReach(
  bot: SoulFireBot,
  target: Vec3,
  config: MinerConfig,
  log: Logger,
): Promise<boolean> {
  const state = await runEffect(bot.liveState());
  if (distance(state, target) <= config.reach) {
    return true;
  }

  log.debug(
    { from: [Math.round(state.x), Math.round(state.y), Math.round(state.z)], at: [target.x, target.y, target.z] },
    "walking to target",
  );

  const stream = bot.goTo({
    goal: {
      goal: {
        case: "xz",
        value: {
          x: target.x + 0.5,
          z: target.z + 0.5,
          dimension: "minecraft:overworld",
          radius: 2,
        },
      },
    },
    options: {
      allowMining: false,
      allowPlacing: false,
      timeoutSeconds: Math.max(1, Math.ceil(config.goToTimeoutMs / 1000)),
    },
  });

  const drained = runEffect(Stream.runDrain(stream)).catch((error: unknown) => {
    log.debug({ err: errorMessage(error) }, "pathfinding failed");
  });

  const deadline = Date.now() + config.goToTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const current = await runEffect(bot.liveState());
    if (distance(current, target) <= config.reach) {
      await runEffect(bot.stopPathfinding()).catch(() => undefined);
      await drained;
      log.debug(
        { at: [Math.round(current.x), Math.round(current.y), Math.round(current.z)] },
        "reached target",
      );
      return true;
    }
  }

  await runEffect(bot.stopPathfinding()).catch(() => undefined);
  await drained;
  const final = await runEffect(bot.liveState());
  log.warn(
    {
      at: [target.x, target.y, target.z],
      stalledAt: [Math.round(final.x), Math.round(final.y), Math.round(final.z)],
      distance: Math.round(distance(final, target) * 10) / 10,
    },
    "could not reach target",
  );
  return false;
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

async function acquireLease(bot: SoulFireBot, log: Logger, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await runEffect(bot.acquireControl(120));
    } catch (error) {
      lastError = error;
      log.warn(
        { err: errorMessage(error) },
        "control lease is busy - close the SoulFire desktop/web client (or its POV view) and keep it closed; retrying in 5s",
      );
      await sleep(5_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("could not acquire the control lease");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });


function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}












