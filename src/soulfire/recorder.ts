import { Effect } from "effect";
import type { SoulFireBot } from "@soulfiremc/sdk";
import { JsonlWriter } from "../util/jsonl.js";
import { nowMs } from "../util/time.js";

export interface RecorderOptions {
  /** Commands sent in order before the snapshot (e.g. `/an205`, `/warp mine`). */
  readonly commands: readonly string[];
  /** Wait after each command before the next step. */
  readonly waitMs: number;
  /** `findBlocks` search radius in blocks. */
  readonly radius: number;
  /** `findBlocks` result cap. */
  readonly maxCount: number;
  /** Ore block ids to look for. */
  readonly oreIds: readonly string[];
  /** JSONL sink, relative to `cwd`. */
  readonly outFile: string;
  readonly cwd?: string;
}

export interface RecordedPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface RecordedBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: string;
}

export interface RecorderResult {
  readonly position: RecordedPosition;
  readonly blocks: readonly RecordedBlock[];
}

export const DEFAULT_ORE_IDS: readonly string[] = [
  "minecraft:diamond_ore",
  "minecraft:deepslate_diamond_ore",
  "minecraft:gold_ore",
  "minecraft:deepslate_gold_ore",
  "minecraft:lapis_ore",
  "minecraft:deepslate_lapis_ore",
  "minecraft:redstone_ore",
  "minecraft:deepslate_redstone_ore",
  "minecraft:iron_ore",
  "minecraft:deepslate_iron_ore",
  "minecraft:coal_ore",
  "minecraft:deepslate_coal_ore",
];

/**
 * Attaches to a running bot, runs the given commands, then snapshots every ore
 * block around it and appends the result to a JSONL file.
 */
export const runRecorder = (bot: SoulFireBot, options: RecorderOptions) =>
  Effect.gen(function* () {
    const writer = new JsonlWriter(options.outFile, options.cwd);
    const start = yield* bot.liveState();
    const startPosition = toPosition(start.x, start.y, start.z, start.yRot, start.xRot);

    for (const command of options.commands) {
      yield* bot.sendChat(command);
      yield* sleep(options.waitMs);
    }

    const state = yield* bot.liveState();
    const position = toPosition(state.x, state.y, state.z, state.yRot, state.xRot);

    const found = yield* bot.findBlocks({
      blockIds: [...options.oreIds],
      maxDistance: options.radius,
      maxCount: options.maxCount,
    });

    const blocks = found.blocks
      .flatMap((block) => {
        const pos = block.position;
        if (pos === undefined) {
          return [];
        }
        return [{ x: pos.x, y: pos.y, z: pos.z, id: block.blockId }];
      })
      .sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);

    writer.write({
      ts: nowMs(),
      kind: "recorder",
      commands: options.commands,
      oreIds: options.oreIds,
      radius: options.radius,
      startPosition,
      position,
      count: blocks.length,
      blocks,
    });

    return { position, blocks } satisfies RecorderResult;
  });

const sleep = (ms: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, ms)));

function toPosition(x: number, y: number, z: number, yaw: number, pitch: number): RecordedPosition {
  return { x, y, z, yaw, pitch };
}
