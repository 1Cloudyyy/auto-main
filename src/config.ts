import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isAnarchyGroupNumber } from "./mines/types.js";

export const DEFAULT_MINES_API_URL = "https://funtime.me/api/backend/api/v1/plugin/mines";
export const DEFAULT_SOULFIRE_URL = "https://217.60.33.212";

const stringList = z.array(z.string().min(1));

export const AppConfigSchema = z.object({
  soulfire: z.object({
    baseUrl: z.url().default(DEFAULT_SOULFIRE_URL),
    token: z.string().min(1),
    instance: z.string().min(1).default("ft"),
    bot: z.string().min(1).optional(),
  }),
  mines: z.object({
    apiUrl: z.url().default(DEFAULT_MINES_API_URL),
    serverTypes: z.string().min(1).default("all"),
    pollIntervalMs: z.number().int().positive().default(7000),
  }),
  base: z.object({
    /** Command that teleports the bot to the clan base. Only valid on `homeAnarchy`. */
    homeCommand: z.string().min(1).default("/clan home"),
    /**
     * The single anarchy where the clan home is registered (e.g. "302").
     * It is excluded from farm targets and used as the transit hub to the base.
     */
    homeAnarchy: z.string().min(1).optional(),
  }),
  targets: z.object({
    strategy: z.enum(["timer", "round_robin"]).default("timer"),
    travelMs: z.number().int().nonnegative().default(25_000),
    minLeadMs: z.number().int().nonnegative().default(10_000),
    maxLeadMs: z.number().int().nonnegative().default(90_000),
    rarity: stringList.default(["legendary", "mythical", "default"]),
    allow: stringList.default([]),
    deny: stringList.default([]),
  }),
  miner: z.object({
    /** Hotbar slot (1-9) where the pickaxe lives. */
    pickaxeSlot: z.number().int().min(1).max(9).default(1),
  }),
  runtime: z.object({
    dataDir: z.string().min(1).default("var"),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /**
     * Skips base trips (drop, repair) and stops a run when inventory and
     * shulkers are full. Used to validate the mining loop in isolation.
     */
    testMode: z.boolean().default(false),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type TargetConfig = AppConfig["targets"];

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/**
 * Loads `.env` from the working directory into `process.env`.
 * Existing environment variables are not overridden.
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const file = resolve(cwd, ".env");
  if (!existsSync(file)) {
    return;
  }

  const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof loader !== "function") {
    throw new ConfigError("process.loadEnvFile is unavailable; Node.js >= 22 is required");
  }
  loader(file);
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fileConfig = readOptionalYaml(env["CONFIG_FILE"], cwd);

  const raw = {
    soulfire: {
      ...asRecord(fileConfig["soulfire"]),
      ...dropUndefined({
        baseUrl: env["SF_BASE_URL"],
        token: env["SF_TOKEN"],
        instance: env["SF_INSTANCE"],
        bot: env["SF_BOT"],
      }),
    },
    mines: {
      ...asRecord(fileConfig["mines"]),
      ...dropUndefined({
        apiUrl: env["MINES_API_URL"],
        serverTypes: env["MINES_SERVER_TYPES"],
        pollIntervalMs: toNumber(env["MINES_POLL_INTERVAL_MS"]),
      }),
    },
    base: {
      ...asRecord(fileConfig["base"]),
      ...dropUndefined({
        homeCommand: env["BASE_HOME_COMMAND"],
        homeAnarchy: env["BASE_HOME_ANARCHY"],
      }),
    },
    targets: {
      ...asRecord(fileConfig["targets"]),
      ...dropUndefined({
        strategy: env["TARGET_STRATEGY"],
        travelMs: toNumber(env["TARGET_TRAVEL_MS"]),
        minLeadMs: toNumber(env["TARGET_MIN_LEAD_MS"]),
        maxLeadMs: toNumber(env["TARGET_MAX_LEAD_MS"]),
        rarity: toCsv(env["TARGET_RARITY"]),
        allow: toCsv(env["TARGET_ALLOW"]),
        deny: toCsv(env["TARGET_DENY"]),
      }),
    },
    miner: {
      ...asRecord(fileConfig["miner"]),
      ...dropUndefined({
        pickaxeSlot: toNumber(env["MINER_PICKAXE_SLOT"]),
      }),
    },
    runtime: {
      ...asRecord(fileConfig["runtime"]),
      ...dropUndefined({
        dataDir: env["DATA_DIR"],
        logLevel: env["LOG_LEVEL"],
        testMode: toBoolean(env["TEST_MODE"]),
      }),
    },
  };

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const config = parsed.data;
  const homeAnarchy = config.base.homeAnarchy;
  if (homeAnarchy !== undefined && /^\d+$/.test(homeAnarchy) && !isAnarchyGroupNumber(homeAnarchy)) {
    throw new ConfigError(
      `Invalid BASE_HOME_ANARCHY "${homeAnarchy}": use a three-digit group number (1xx, 2xx, 3xx, 5xx, 9xx)`,
    );
  }

  if (config.targets.maxLeadMs < config.targets.minLeadMs) {
    throw new ConfigError("Invalid configuration: TARGET_MAX_LEAD_MS must be >= TARGET_MIN_LEAD_MS");
  }

  return config;
}

function readOptionalYaml(file: string | undefined, cwd: string): Record<string, unknown> {
  const path = file ? resolve(cwd, file) : resolve(cwd, "config", "app.yaml");
  if (!existsSync(path)) {
    return {};
  }

  const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${path} must contain a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Config section must be a mapping");
  }
  return value as Record<string, unknown>;
}

function dropUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`Expected a number, got "${raw}"`);
  }
  return parsed;
}

function toCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function toBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new ConfigError(`Expected a boolean, got "${raw}"`);
}


