import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface RunRecord {
  readonly ts: string;
  readonly anarchy: string;
  readonly command: string;
  readonly status: string;
  readonly blocksBroken: number;
  readonly elapsedMs: number;
  readonly error?: string;
}

export interface RunSummary {
  readonly runs: number;
  readonly blocksBroken: number;
  readonly totalMs: number;
  readonly perAnarchy: Record<string, { runs: number; blocksBroken: number }>;
}

/**
 * Append-only JSONL journal of farm runs. Used by `farm`/`daemon` to write and
 * by `stats` to read, so both the operator and the agent can inspect history.
 */
export class RunLog {
  readonly filePath: string;

  constructor(filePath: string, cwd: string = process.cwd()) {
    this.filePath = resolve(cwd, filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  append(record: RunRecord): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  readAll(): RunRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const records: RunRecord[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        records.push(JSON.parse(trimmed) as RunRecord);
      } catch {
        // Skip a corrupted line instead of losing the whole journal.
      }
    }
    return records;
  }

  summary(): RunSummary {
    return summarize(this.readAll());
  }
}

export function summarize(records: readonly RunRecord[]): RunSummary {
  const perAnarchy: Record<string, { runs: number; blocksBroken: number }> = {};
  let blocksBroken = 0;
  let totalMs = 0;

  for (const record of records) {
    blocksBroken += record.blocksBroken;
    totalMs += record.elapsedMs;

    const bucket = perAnarchy[record.anarchy] ?? { runs: 0, blocksBroken: 0 };
    bucket.runs += 1;
    bucket.blocksBroken += record.blocksBroken;
    perAnarchy[record.anarchy] = bucket;
  }

  return { runs: records.length, blocksBroken, totalMs, perAnarchy };
}

export type ControllerPhase = "idle" | "target" | "switching" | "warping" | "collecting" | "error";

export interface ControllerState {
  readonly updatedAt: string;
  readonly bot: string;
  readonly phase: ControllerPhase;
  readonly anarchy?: string;
  readonly command?: string;
  readonly blocksBroken?: number;
  readonly error?: string;
}

/** Small JSON file with the live phase, so the operator can see where the bot is. */
export class StateFile {
  readonly filePath: string;

  constructor(filePath: string, cwd: string = process.cwd()) {
    this.filePath = resolve(cwd, filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  write(state: Omit<ControllerState, "updatedAt">): void {
    const payload: ControllerState = { updatedAt: new Date().toISOString(), ...state };
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
  }

  read(): ControllerState | undefined {
    if (!existsSync(this.filePath)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as ControllerState;
    } catch {
      return undefined;
    }
  }
}
