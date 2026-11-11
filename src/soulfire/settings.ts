import { Effect } from "effect";
import type { InstanceInfo } from "@soulfiremc/sdk";
import { z } from "zod";
import { AppConfigSchema, ConfigError } from "../config.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../log.js";
import { connectClient, resolveInstance } from "./connect.js";

/** Must match `AutoMainSettings.NAMESPACE` in the plugin. */
export const SETTINGS_NAMESPACE = "auto-main";

const OverridesSchema = z.object({
  "test-mode": z.boolean().optional(),
  "pickaxe-slot": z.number().int().min(1).max(9).optional(),
  "mines-api-url": z.url().optional(),
  "mines-server-types": z.string().min(1).optional(),
  "mines-poll-interval-ms": z.number().int().positive().optional(),
  "home-command": z.string().min(1).optional(),
  "home-anarchy": z.string().optional(),
  "target-strategy": z.enum(["timer", "round_robin"]).optional(),
  "target-travel-ms": z.number().int().nonnegative().optional(),
  "target-min-lead-ms": z.number().int().nonnegative().optional(),
  "target-max-lead-ms": z.number().int().nonnegative().optional(),
  "target-rarity": z.array(z.string().min(1)).optional(),
  "target-allow": z.array(z.string().min(1)).optional(),
  "target-deny": z.array(z.string().min(1)).optional(),
});

interface ProtoKind {
  case?: string;
  value?: unknown;
}

interface ProtoValue {
  kind?: ProtoKind;
}

/** Converts a `google.protobuf.Value` (protobuf-es v2) into a plain JS value. */
export function protoValueToJs(value: unknown): unknown {
  const kind = (value as ProtoValue | undefined)?.kind;
  if (kind === undefined || kind.case === undefined) {
    return undefined;
  }

  switch (kind.case) {
    case "nullValue":
      return null;
    case "numberValue":
    case "stringValue":
    case "boolValue":
      return kind.value;
    case "listValue": {
      const list = kind.value as { values?: readonly unknown[] } | undefined;
      return (list?.values ?? []).map(protoValueToJs);
    }
    case "structValue": {
      const struct = kind.value as { fields?: Record<string, unknown> } | undefined;
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(struct?.fields ?? {})) {
        result[key] = protoValueToJs(entry);
      }
      return result;
    }
    default:
      return undefined;
  }
}

/**
 * Extracts the effective key/value map of one instance settings namespace.
 *
 * Values come from two places: defaults declared by the plugin
 * (`settings_definitions[].type.value.def`) and values the user saved
 * (`config.settings[].entries`). Saved values win.
 */
export function readSettingsNamespace(
  info: Pick<InstanceInfo, "config" | "settingsDefinitions">,
  namespace: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const definition of info.settingsDefinitions ?? []) {
    if (definition.id?.namespace !== namespace) {
      continue;
    }
    const setting = definition.type.value as { def?: unknown } | undefined;
    if (setting?.def !== undefined) {
      result[definition.id.key] = setting.def;
    }
  }

  const stored = (info.config?.settings ?? []).find((entry) => entry.namespace === namespace);
  for (const entry of stored?.entries ?? []) {
    result[entry.key] = protoValueToJs(entry.value);
  }

  return result;
}

/**
 * Applies plugin settings on top of the locally loaded config.
 * The plugin page is the primary source for operational knobs; secrets
 * (token, base URL) still come from the environment.
 */
export function applyPluginSettings(baseConfig: AppConfig, values: Record<string, unknown>): AppConfig {
  const parsed = OverridesSchema.safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid SoulFire plugin settings: ${details}`);
  }

  const overrides = parsed.data;
  const homeAnarchy = overrides["home-anarchy"]?.trim();

  const merged: AppConfig = {
    soulfire: baseConfig.soulfire,
    mines: {
      apiUrl: overrides["mines-api-url"] ?? baseConfig.mines.apiUrl,
      serverTypes: overrides["mines-server-types"] ?? baseConfig.mines.serverTypes,
      pollIntervalMs: overrides["mines-poll-interval-ms"] ?? baseConfig.mines.pollIntervalMs,
    },
    base: {
      homeCommand: overrides["home-command"] ?? baseConfig.base.homeCommand,
      ...(homeAnarchy === undefined
        ? baseConfig.base.homeAnarchy === undefined
          ? {}
          : { homeAnarchy: baseConfig.base.homeAnarchy }
        : homeAnarchy === ""
          ? {}
          : { homeAnarchy }),
    },
    targets: {
      strategy: overrides["target-strategy"] ?? baseConfig.targets.strategy,
      travelMs: overrides["target-travel-ms"] ?? baseConfig.targets.travelMs,
      minLeadMs: overrides["target-min-lead-ms"] ?? baseConfig.targets.minLeadMs,
      maxLeadMs: overrides["target-max-lead-ms"] ?? baseConfig.targets.maxLeadMs,
      rarity: overrides["target-rarity"] ?? baseConfig.targets.rarity,
      allow: overrides["target-allow"] ?? baseConfig.targets.allow,
      deny: overrides["target-deny"] ?? baseConfig.targets.deny,
    },
    miner: {
      pickaxeSlot: overrides["pickaxe-slot"] ?? baseConfig.miner.pickaxeSlot,
    },
    runtime: {
      ...baseConfig.runtime,
      testMode: overrides["test-mode"] ?? baseConfig.runtime.testMode,
    },
  };

  const validated = AppConfigSchema.safeParse(merged);
  if (!validated.success) {
    const details = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Merged configuration is invalid: ${details}`);
  }

  if (validated.data.targets.maxLeadMs < validated.data.targets.minLeadMs) {
    throw new ConfigError("Invalid plugin settings: target-max-lead-ms must be >= target-min-lead-ms");
  }

  return validated.data;
}

/**
 * Connects to SoulFire, reads the `auto-main` instance settings and merges them
 * into the local config. On any failure the local config is returned unchanged.
 */
export async function resolveConfigWithSoulFire(
  baseConfig: AppConfig,
  log: Logger,
): Promise<AppConfig> {
  try {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connectClient(baseConfig);
          const instance = yield* resolveInstance(client, baseConfig.soulfire.instance);
          const info = yield* instance.info();
          return readSettingsNamespace(info, SETTINGS_NAMESPACE);
        }),
      ),
    );

    const merged = applyPluginSettings(baseConfig, values);
    log.info(
      { namespace: SETTINGS_NAMESPACE, keys: Object.keys(values).sort() },
      "settings merged from SoulFire",
    );
    return merged;
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "SoulFire settings unavailable, using local config");
    return baseConfig;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

