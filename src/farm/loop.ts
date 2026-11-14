import { Effect } from "effect";
import type { SoulFireBot, SoulFireInstance } from "@soulfiremc/sdk";
import type { Logger } from "../log.js";
import { fetchMines } from "../mines/client.js";
import { createDispatcherState, planNextTarget } from "../mines/dispatcher.js";
import type { TargetPolicy } from "../mines/dispatcher.js";
import { anarchyCommand } from "../mines/types.js";
import { runCollector } from "../miner/collector.js";
import type { CollectorConfig } from "../miner/collector.js";
import { acquireLease, ensureOnline, warpToMine } from "../soulfire/nav.js";
import type { ControllerPhase } from "../telemetry.js";

export interface FarmOptions {
  readonly policy: TargetPolicy;
  readonly collect: CollectorConfig;
  readonly minesApiUrl: string;
  readonly serverTypes: string;
  readonly includeBedrock: boolean;
  readonly warp: string;
  readonly anarchyWaitMs: number;
  readonly warpWaitMs: number;
  /** 0 means "run until stopped". */
  readonly iterations: number;
  readonly idleMs: number;
  /** Stop after this many consecutive empty mines. */
  readonly maxEmptyRuns: number;
  /** Called after every finished mine (used for the JSONL journal). */
  readonly onRun?: (run: FarmRun) => void;
  /** Called on every phase change (used for the live state file). */
  readonly onPhase?: (phase: {
    phase: ControllerPhase;
    anarchy?: string;
    command?: string;
    blocksBroken?: number;
    error?: string;
  }) => void;
}

export interface FarmRun {
  readonly anarchy: string;
  readonly command: string;
  readonly status: string;
  readonly blocksBroken: number;
  readonly elapsedMs: number;
  readonly error?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Rotation loop: pick a mine from the dispatcher, switch anarchy, warp, run the
 * SoulFire collect task, then move on. Failed or empty mines are blacklisted for
 * the rest of the session.
 */
export async function runFarm(
  bot: SoulFireBot,
  instance: SoulFireInstance,
  profileId: string,
  options: FarmOptions,
  log: Logger,
  shouldStop: () => boolean = () => false,
): Promise<FarmRun[]> {
  const dispatcher = createDispatcherState();
  const failed = new Set<string>();
  const runs: FarmRun[] = [];
  let emptyStreak = 0;

  for (let index = 0; options.iterations === 0 || index < options.iterations; index += 1) {
    if (shouldStop()) {
      log.info("stop requested");
      break;
    }

    const entries = await fetchMines({
      apiUrl: options.minesApiUrl,
      serverTypes: options.serverTypes,
      includeBedrock: options.includeBedrock,
      timeoutMs: 10_000,
    });

    const policy: TargetPolicy = {
      ...options.policy,
      deny: [...options.policy.deny, ...failed],
    };
    const plan = planNextTarget(entries, policy, dispatcher);

    if (plan === undefined) {
      log.warn("no target matched the policy");
      await sleep(options.idleMs);
      continue;
    }

    const command = anarchyCommand(plan.entry.serverKey);
    if (command === null) {
      log.warn({ server: plan.entry.serverKey }, "cannot derive an anarchy command");
      failed.add(plan.entry.serverKey);
      continue;
    }

    options.onPhase?.({ phase: "target", anarchy: plan.entry.serverKey, command });

    log.info(
      {
        anarchy: plan.entry.serverKey,
        command,
        resetInMs: plan.resetInMs,
        rarity: plan.entry.rarity,
        reason: plan.reason,
      },
      "next target",
    );

    if (!(await ensureOnline(instance, bot, profileId, log))) {
      log.error("bot did not come online");
      break;
    }

    const lease = await acquireLease(bot, log);
    if (lease === undefined) {
      break;
    }

    let warped = false;
    try {
      options.onPhase?.({ phase: "switching", anarchy: plan.entry.serverKey, command });
      log.info({ command }, "switching anarchy");
      await runEffect(bot.sendChat(command));
      await sleep(options.anarchyWaitMs);
      options.onPhase?.({ phase: "warping", anarchy: plan.entry.serverKey, command });
      warped = await warpToMine(bot, { warp: options.warp, warpWaitMs: options.warpWaitMs }, log);
    } catch (error) {
      log.warn({ err: message(error) }, "transition failed");
    } finally {
      await runEffect(lease.release()).catch(() => undefined);
    }

    if (!warped) {
      failed.add(plan.entry.serverKey);
      log.warn({ anarchy: plan.entry.serverKey }, "warp failed; blacklisted for this session");
      continue;
    }

    const started = Date.now();
    try {
      options.onPhase?.({ phase: "collecting", anarchy: plan.entry.serverKey, command });
      const result = await runCollector(bot, options.collect, log);
      const run: FarmRun = {
        anarchy: plan.entry.serverKey,
        command,
        status: result.status,
        blocksBroken: result.blocksBroken,
        elapsedMs: result.elapsedMs,
      };
      runs.push(run);
      options.onRun?.(run);
      options.onPhase?.({
        phase: "idle",
        anarchy: plan.entry.serverKey,
        command,
        blocksBroken: result.blocksBroken,
      });

      if (result.blocksBroken === 0) {
        emptyStreak += 1;
        failed.add(plan.entry.serverKey);
        if (emptyStreak >= options.maxEmptyRuns) {
          log.warn({ emptyStreak }, "too many empty mines in a row, stopping");
          break;
        }
      } else {
        emptyStreak = 0;
      }
    } catch (error) {
      const failedRun: FarmRun = {
        anarchy: plan.entry.serverKey,
        command,
        status: "ERROR",
        blocksBroken: 0,
        elapsedMs: Date.now() - started,
        error: message(error),
      };
      runs.push(failedRun);
      options.onRun?.(failedRun);
      options.onPhase?.({ phase: "error", anarchy: plan.entry.serverKey, command, error: failedRun.error });
      failed.add(plan.entry.serverKey);
      log.warn({ err: message(error) }, "collect task failed");
    }

    await sleep(options.idleMs);
  }

  return runs;
}

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}




