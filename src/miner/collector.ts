import { Effect } from "effect";
import type { SoulFireBot } from "@soulfiremc/sdk";
import type { Logger } from "../log.js";

export interface CollectorConfig {
  /** Ores to collect. */
  readonly oreIds: readonly string[];
  /** Search radius, at most 64. */
  readonly radius: number;
  /** Stop after this many blocks. */
  readonly maxCount: number;
  /** Wall-clock budget for the task. */
  readonly deadlineMs: number;
  /** Per-path deadline. */
  readonly pathTimeoutSeconds: number;
}

export interface CollectorResult {
  readonly status: string;
  readonly reason: number;
  readonly blocksBroken: number;
  readonly elapsedMs: number;
}

/**
 * Runs SoulFire's built-in `collectBlocks` task: the server-side miner handles
 * navigation, line of sight and digging for the given block ids.
 */
export async function runCollector(
  bot: SoulFireBot,
  config: CollectorConfig,
  log: Logger,
): Promise<CollectorResult> {
  const started = Date.now();

  const task = await Effect.runPromise(
    bot.tasks.collectBlocks([...config.oreIds], {
      count: config.maxCount,
      searchRadius: config.radius,
      requireLineOfSight: true,
      avoidSubmergedTargets: true,
      path: {
        allowMining: true,
        allowPlacing: false,
        timeoutSeconds: config.pathTimeoutSeconds,
      },
      deadline: new Date(started + config.deadlineMs),
    }),
  );

  log.info({ taskId: task.id }, "collect task started");
  const snapshot = await Effect.runPromise(task.wait());
  const elapsedMs = Date.now() - started;

  log.debug({ snapshot }, "collect task snapshot");

  let reason = 0;
  let blocksBroken = 0;
  if (String(snapshot.status) === "6") {
    try {
      const result = await Effect.runPromise(task.result());
      reason = result.reason;
      blocksBroken = result.blocksBroken;
    } catch {
      // The task completed but the result is unavailable; keep the status only.
    }
  }

  log.info({ status: String(snapshot.status), reason, blocksBroken, elapsedMs }, "collect task finished");

  return { status: String(snapshot.status), reason, blocksBroken, elapsedMs };
}



