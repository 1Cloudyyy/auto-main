import pino, { type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  const pretty = options.pretty ?? (process.stdout.isTTY && process.env["NODE_ENV"] !== "production");

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
