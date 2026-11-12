import { Effect } from "effect";
import type { SoulFireBot, SoulFireBotControlLease, SoulFireInstance } from "@soulfiremc/sdk";
import type { Logger } from "../log.js";
import { DEFAULT_MINE_BOUNDS, DEFAULT_WARP_POINT } from "../miner/bounds.js";
import type { MineBounds } from "../miner/bounds.js";

export type { MineBounds };
export { DEFAULT_MINE_BOUNDS, DEFAULT_WARP_POINT };

/** Dimension the FunTime mine lives in (not overworld). */
export const DEFAULT_MINE_DIMENSION = "minecraft:lobby";

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * True when the bot stands on the warp platform or inside the mine cuboid.
 * The warp point is intentionally outside the cuboid, so both count as "ready".
 */
export async function isAtMine(
  bot: SoulFireBot,
  bounds: MineBounds = DEFAULT_MINE_BOUNDS,
  dimension = DEFAULT_MINE_DIMENSION,
): Promise<boolean> {
  const state = await runEffect(bot.liveState());

  if (state.dimension !== undefined && state.dimension !== dimension) {
    return false;
  }

  const inside =
    state.x >= bounds.minX - 2 &&
    state.x <= bounds.maxX + 2 &&
    state.z >= bounds.minZ - 2 &&
    state.z <= bounds.maxZ + 2;
  const atWarp =
    Math.abs(state.x - DEFAULT_WARP_POINT.x) <= 6 &&
    Math.abs(state.z - DEFAULT_WARP_POINT.z) <= 6 &&
    state.y >= 80;

  return inside || atWarp;
}

/** Polls the position until the bot is at the mine or the timeout expires. */
export async function waitForMinePosition(
  bot: SoulFireBot,
  timeoutMs: number,
  bounds: MineBounds = DEFAULT_MINE_BOUNDS,
  dimension = DEFAULT_MINE_DIMENSION,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isAtMine(bot, bounds, dimension)) {
      return true;
    }
    await sleep(1_000);
  }

  return false;
}

export interface WarpOptions {
  /** Warp command, e.g. `mine` or `/warp mine`. */
  readonly warp: string;
  /** Wait after sending the command. */
  readonly warpWaitMs: number;
  /** Verification timeout. */
  readonly verifyTimeoutMs?: number;
  readonly bounds?: MineBounds;
}

/**
 * Sends the warp command, verifies the position and retries once. Requires an
 * active control lease (the caller owns it).
 */
export async function warpToMine(
  bot: SoulFireBot,
  options: WarpOptions,
  log: Logger,
): Promise<boolean> {
  const command = options.warp.startsWith("/") ? options.warp : `/warp ${options.warp}`;
  const bounds = options.bounds ?? DEFAULT_MINE_BOUNDS;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 15_000;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log.info({ command, attempt }, "warping to the mine");
    await runEffect(bot.sendChat(command));
    await sleep(options.warpWaitMs);
    await runEffect(bot.waitForChunks());

    if (await waitForMinePosition(bot, verifyTimeoutMs, bounds)) {
      const state = await runEffect(bot.liveState());
      log.debug(
        {
          at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)],
          dimension: state.dimension ?? null,
        },
        "warp verified",
      );
      return true;
    }

    const state = await runEffect(bot.liveState());
    log.warn(
      {
        attempt,
        at: [Math.round(state.x), Math.round(state.y), Math.round(state.z)],
        dimension: state.dimension ?? null,
      },
      "not at the mine, retrying the warp",
    );
  }

  return false;
}

/** Starts the bot if it is offline and waits until it reports online. */
export async function ensureOnline(
  instance: SoulFireInstance,
  bot: SoulFireBot,
  profileId: string,
  log: Logger,
  timeoutMs = 120_000,
): Promise<boolean> {
  const isOnline = async (): Promise<boolean> => {
    const bots = await runEffect(instance.bots());
    return bots.some((entry) => entry.profileId === profileId && entry.isOnline);
  };

  if (await isOnline()) {
    return true;
  }

  log.info("bot is offline, starting");
  await runEffect(bot.start());

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOnline()) {
      return true;
    }
    await sleep(2_000);
  }

  return false;
}

/** Acquires an exclusive control lease, retrying while another client holds it. */
export async function acquireLease(
  bot: SoulFireBot,
  log: Logger,
  timeoutMs = 60_000,
): Promise<SoulFireBotControlLease | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await runEffect(bot.acquireControl(120));
    } catch (error) {
      lastError = error;
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "control lease is busy - close the SoulFire client (or its POV view); retrying in 5s",
      );
      await sleep(5_000);
    }
  }

  log.error(
    { err: lastError instanceof Error ? lastError.message : String(lastError) },
    "could not acquire the control lease",
  );
  return undefined;
}




