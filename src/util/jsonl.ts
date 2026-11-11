import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Append-only JSON Lines writer. Synchronous on purpose: recorder volumes are
 * low (a few records per run) and we want the record on disk even if the
 * process is killed right after a write.
 */
export class JsonlWriter {
  readonly filePath: string;

  constructor(filePath: string, cwd: string = process.cwd()) {
    this.filePath = resolve(cwd, filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  write(record: unknown): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
