import { Effect, Stream } from "effect";
import type { SoulFireBot } from "@soulfiremc/sdk";
import type { Logger } from "../log.js";
import { DEFAULT_ORE_IDS } from "../soulfire/recorder.js";
import { isAnarchyGroupNumber } from "../mines/types.js";
import { distance, planTargets } from "./planner.js";
import type { DigTarget, OreBlock, Vec3 } from "./planner.js";

export interface MinerConfig {
  /** Anarchy number or command, e.g. `205` or `/an205`. */
  readonly anarchy?: string;
  /** Warp command, e.g. `mine` or `/warp mine`. */
  readonly warp: string;
  /** Hotbar slot (1-9) with the pickaxe. */
  readonly pickaxeSlot: number;
  /** `findBlocks` radius. */
  readonly radius: number;
  /** Hard cap on broken blocks. */
  readonly maxDigs: number;
  /** Hard cap on wall-clock time. */
  readonly maxSeconds: number;
  /** Distance at which the bot digs without walking. */
  readonly reach: number;
  /** Per-dig deadline; a stuck dig is cancelled and the block blacklisted. */
  readonly digTimeoutMs: number;
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
  /** How long to walk toward the mine after the warp. */
  readonly enterTimeoutMs: number;
  /** Side-step from the warp point before walking into the mine (avoids the shaft). */
  readonly entryShiftX: number;
  readonly entryShiftZ: number;
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
  pickaxeSlot: 1,
  radius: 24,
  maxDigs: 150,
  maxSeconds: 180,
  reach: 5,
  digTimeoutMs: 8_000,
  batchSize: 8,
  stepDelayMs: 120,
  goToTimeoutMs: 15_000,
  anarchyWaitMs: 20_000,
  warpWaitMs: 12_000,
  enterTimeoutMs: 10_000,
  entryShiftX: 0,
  entryShiftZ: 2,
  scanTimeoutMs: 30_000,
  oreIds: DEFAULT_ORE_IDS,
  weights: DEFAULT_WEIGHTS,
  minX: 69,
  maxX: 89,
  minY: 76,
  maxY: 85,
  minZ: -8,
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
    void runEffect(lease.renew(120)).catch((error: unknown) => {
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

  await approachMine(bot, config, log);

  const entered = await enterMine(bot, config, log);
  if (!entered) {
    log.warn("could not walk into the mine cuboid; continuing anyway");
  }

  await selectPickaxe(bot, config.pickaxeSlot, log);

  let digs = 0;
  let scanned = 0;
  let emptySince: number | undefined;
  const unbreakable = new Set<string>();
  let consecutiveFailures = 0;
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
        dimension: state.dimension ?? null,
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

    // Plan only layers the bot can reach: it descends while digging and
    // cannot climb, so layers above the current Y are dead weight.
    const effectiveMaxY = Math.min(
      config.maxY ?? Number.POSITIVE_INFINITY,
      Math.floor(state.y),
    );

    const targets = planTargets(ores, state, config.weights, {
      window: 3,
      maxTargets: config.batchSize,
      ...(config.minX === undefined ? {} : { minX: config.minX }),
      ...(config.maxX === undefined ? {} : { maxX: config.maxX }),
      ...(config.minY === undefined ? {} : { minY: config.minY }),
      maxY: effectiveMaxY,
      ...(config.minZ === undefined ? {} : { minZ: config.minZ }),
      ...(config.maxZ === undefined ? {} : { maxZ: config.maxZ }),
    });

    if (targets.length === 0) {
      stopped = "empty";
      log.info("no valuable targets left");
      break;
    }

    // Only same-layer or lower targets are reachable: the bot descends by
    // digging and cannot climb back without building up.
    const maxReachableY = Math.floor(state.y) + 1;
    const reachable = targets.filter((target) => target.y <= maxReachableY);
    if (reachable.length === 0) {
      stopped = "empty";
      log.warn(
        { botY: Math.round(state.y), nextTargetY: targets[0]?.y },
        "remaining targets are above the bot; finish the run",
      );
      break;
    }

    let progressed = false;
    let layerChanged = false;
    for (const target of reachable) {
      const targetKey = `${target.x},${target.y},${target.z}`;
      if (unbreakable.has(targetKey)) {
        continue;
      }

      const current = await runEffect(bot.liveState());
      if (target.y > Math.floor(current.y)) {
        // The bot fell to a lower layer while digging; re-plan for this layer.
        layerChanged = true;
        break;
      }

      // Stay local: chasing targets across the pit drops the bot into holes.
      if (distance(current, target) > config.reach + 2) {
        continue;
      }
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
        await digWithTimeout(bot, target, config.digTimeoutMs);
        digs += 1;
        oreBlocks += target.ores;
        progressed = true;
        log.debug(
          { digs, value: target.value, ores: target.ores, at: [target.x, target.y, target.z] },
          "dug target",
        );
      } catch (error) {
        unbreakable.add(targetKey);
        log.warn(
          { err: errorMessage(error), at: [target.x, target.y, target.z] },
          "dig target failed; block blacklisted",
        );
        await sleep(config.stepDelayMs);
        continue;
      }

      await sleep(config.stepDelayMs);
    }

    if (layerChanged) {
      continue;
    }

    if (!progressed) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        stopped = "no-progress";
        log.warn("no target could be dug in three consecutive batches");
        break;
      }
      continue;
    }

    consecutiveFailures = 0;
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

  const dimension = state.dimension ?? "minecraft:overworld";
  const stream = bot.goTo({
    goal: {
      goal: {
        case: "xz",
        value: {
          x: target.x + 0.5,
          z: target.z + 0.5,
          dimension,
          radius: 2,
        },
      },
    },
    options: {
      allowMining: true,
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

  // The mine floor is full of 3x3 holes; the pathfinder refuses to jump gaps.
  // Fall back to raw forward movement with jumps, like a human walking.
  if (await walkToward(bot, target, config, log)) {
    return true;
  }

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
  if (!isAnarchyGroupNumber(trimmed)) {
    throw new Error(
      `Invalid anarchy "${trimmed}": FunTime uses three-digit groups only (1xx, 2xx, 3xx, 5xx, 9xx)`,
    );
  }
  return `/an${trimmed}`;
}

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/**
 * Deterministic walk-in: side-step along +Z (away from the entry shaft), then
 * walk along +X toward the mine. Each segment uses an absolute yaw and aborts
 * when the bot stops making progress, so it cannot oscillate.
 */
async function approachMine(bot: SoulFireBot, config: MinerConfig, log: Logger): Promise<void> {
  const start = await runEffect(bot.liveState());
  log.debug(
    { at: [Math.round(start.x), Math.round(start.y), Math.round(start.z)] },
    "warp point",
  );

  if (config.entryShiftZ !== 0) {
    await stepAxis(bot, "z", start.z + config.entryShiftZ, 4_000);
  }

  const centerX = ((config.minX ?? 69) + (config.maxX ?? 89)) / 2;
  const now = await runEffect(bot.liveState());
  const direction = centerX >= now.x ? 1 : -1;
  await stepAxis(bot, "x", now.x + direction * 4, 4_000);

  const after = await runEffect(bot.liveState());
  log.debug(
    { at: [Math.round(after.x), Math.round(after.y), Math.round(after.z)] },
    "approached the mine",
  );
}

/** Walks along one axis using an absolute yaw, stopping on no progress. */
async function stepAxis(
  bot: SoulFireBot,
  axis: "x" | "z",
  target: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { x: number; z: number } | undefined;
  let stuck = 0;

  try {
    while (Date.now() < deadline) {
      const state = await runEffect(bot.liveState());
      const value = axis === "x" ? state.x : state.z;
      if ((axis === "x" && Math.abs(state.x - target) < 0.8) || (axis === "z" && Math.abs(state.z - target) < 0.8)) {
        break;
      }

      if (last !== undefined && Math.abs(state.x - last.x) < 0.05 && Math.abs(state.z - last.z) < 0.05) {
        stuck += 1;
        if (stuck >= 3) {
          break;
        }
      } else {
        stuck = 0;
      }
      last = { x: state.x, z: state.z };

      const delta = target - value;
      const yaw = axis === "x" ? (delta > 0 ? -90 : 90) : (delta > 0 ? 0 : 180);
      await runEffect(bot.look(yaw, 0));
      await runEffect(bot.setMovement({ forward: true }));
      await sleep(200);
    }
  } finally {
    await runEffect(bot.setMovement({ forward: false })).catch(() => undefined);
  }
}

/** Raw movement fallback: walk (and hop) toward the target until in reach. */
async function walkToward(
  bot: SoulFireBot,
  target: Vec3,
  config: MinerConfig,
  log: Logger,
): Promise<boolean> {
  const deadline = Date.now() + Math.min(config.goToTimeoutMs, 6_000);

  try {
    while (Date.now() < deadline) {
      const state = await runEffect(bot.liveState());
      if (distance(state, target) <= config.reach) {
        return true;
      }

      const dx = target.x + 0.5 - state.x;
      const dz = target.z + 0.5 - state.z;
      const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
      await runEffect(bot.look(yaw, 0));
      await runEffect(bot.setMovement({ forward: true, jump: true }));
      await sleep(250);
    }

    return distance(await runEffect(bot.liveState()), target) <= config.reach;
  } catch (error) {
    log.debug({ err: errorMessage(error) }, "manual walking failed");
    return false;
  } finally {
    await runEffect(bot.setMovement({ forward: false, jump: false })).catch(() => undefined);
  }
}

/** Selects the configured hotbar slot and verifies it holds a pickaxe. */
async function selectPickaxe(bot: SoulFireBot, slot: number, log: Logger): Promise<void> {
  const hotbarSlot = Math.min(9, Math.max(1, Math.trunc(slot))) - 1;
  await runEffect(bot.selectHotbar(hotbarSlot));

  const inventory = await runEffect(bot.inventoryState());
  const held = inventory.slots.find((entry) => entry.slot === 36 + hotbarSlot);

  if (held !== undefined && held.itemId.endsWith("_pickaxe")) {
    log.info({ slot: hotbarSlot + 1, item: held.itemId }, "pickaxe selected");
    return;
  }

  // Configured slot is wrong: fall back to the first pickaxe in the hotbar.
  const fallback = inventory.slots.find(
    (entry) => entry.slot >= 36 && entry.slot <= 44 && entry.itemId.endsWith("_pickaxe"),
  );

  if (fallback === undefined) {
    log.warn(
      { slot: hotbarSlot + 1, item: held?.itemId ?? null },
      "no pickaxe found in the hotbar",
    );
    return;
  }

  await runEffect(bot.selectHotbar(fallback.slot - 36));
  log.warn(
    { configured: hotbarSlot + 1, used: fallback.slot - 35, item: fallback.itemId },
    "configured slot is not a pickaxe; using the detected one",
  );
}

/** Digs one block with a deadline; on timeout the dig is cancelled. */
async function digWithTimeout(
  bot: SoulFireBot,
  target: Vec3,
  timeoutMs: number,
): Promise<void> {
  const position = positionOf(target);
  const dig = runEffect(bot.digBlock({ position })).then(
    () => "ok" as const,
    (error: unknown) => {
      throw error;
    },
  );

  const timeout = sleep(timeoutMs).then(() => "timeout" as const);
  const result = await Promise.race([dig, timeout]);

  if (result === "timeout") {
    await runEffect(bot.digBlock({ position, cancel: true })).catch(() => undefined);
    throw new Error(`dig timed out after ${timeoutMs} ms`);
  }
}

/**
 * Walks from the warp platform into the mine cuboid. Pathfinding refuses to
 * drop into the pit, so this uses raw movement input toward the centre.
 */
async function enterMine(bot: SoulFireBot, config: MinerConfig, log: Logger): Promise<boolean> {
  if (config.minX === undefined || config.maxX === undefined || config.minZ === undefined || config.maxZ === undefined) {
    return true;
  }

  const minX = config.minX - 1;
  const maxX = config.maxX + 1;
  const minZ = config.minZ - 1;
  const maxZ = config.maxZ + 1;

  // Walk toward the nearest ore, not the centre: the centre is often an open
  // shaft and the bot would fall to the bottom, out of reach of the top layers.
  const found = await runEffect(
    bot.findBlocks({ blockIds: [...config.oreIds], maxDistance: config.radius, maxCount: 4000 }),
  );
  const ores = found.blocks.flatMap((block) => {
    const position = block.position;
    if (position === undefined) {
      return [];
    }
    return [{ x: position.x, y: position.y, z: position.z }];
  });
  const state0 = await runEffect(bot.liveState());
  const nearest = ores
    .filter(
      (ore) =>
        ore.x >= config.minX! &&
        ore.x <= config.maxX! &&
        ore.z >= config.minZ! &&
        ore.z <= config.maxZ!,
    )
    .sort((a, b) => distance(state0, a) - distance(state0, b))[0];

  const deadline = Date.now() + config.enterTimeoutMs;
  let lastPos: { x: number; z: number } | undefined;
  let stuck = 0;

  while (Date.now() < deadline) {
    const state = await runEffect(bot.liveState());

    if (lastPos !== undefined && Math.abs(state.x - lastPos.x) < 0.05 && Math.abs(state.z - lastPos.z) < 0.05) {
      stuck += 1;
      if (stuck >= 4) {
        await runEffect(bot.setMovement({ forward: false }));
        log.debug("stopped walking into the mine: no progress");
        return false;
      }
    } else {
      stuck = 0;
    }
    lastPos = { x: state.x, z: state.z };
    const inside = state.x >= minX && state.x <= maxX && state.z >= minZ && state.z <= maxZ;
    const onTopLayer = state.y >= (config.maxY ?? 85) - 1;

    // Stop as soon as the bot stands on the mine surface: walking further
    // drops it into the entry shaft/pocket at the edge.
    if (state.y < (config.maxY ?? 85) - 3) {
      await runEffect(bot.setMovement({ forward: false }));
      log.warn(
        { at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)] },
        "fell into the entry pocket; aborting the walk-in",
      );
      return false;
    }

    if (inside && onTopLayer) {
      await runEffect(bot.setMovement({ forward: false }));
      log.debug(
        { at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)] },
        "inside the mine",
      );
      return true;
    }

    const dx = (nearest?.x ?? state.x) - state.x;
    const dz = (nearest?.z ?? state.z) - state.z;
    if (dx === 0 && dz === 0) {
      break;
    }
    const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
    await runEffect(bot.look(yaw, 20));
    await runEffect(bot.setMovement({ forward: true }));
    await sleep(400);
  }

  await runEffect(bot.setMovement({ forward: false }));
  return false;
}

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
































