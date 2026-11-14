import pino, { type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty?: boolean;
  /** Also append JSON logs to this file (created with parents). */
  file?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  const pretty = options.pretty ?? (process.stdout.isTTY && process.env["NODE_ENV"] !== "production");

  if (options.file !== undefined) {
    const level = options.level as pino.Level;
    return pino(
      { level: options.level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
      pino.multistream([
        { level, stream: process.stdout },
        { level, stream: pino.destination({ dest: options.file, mkdir: true, sync: false }) },
      ]),
    );
  }

  return pino({
    level: options.level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              translateTime: "HH:MM:ss",
              ignore: "pid,hostname",
              singleLine: true,
            },
          },
        }
      : {}),
  });
}

