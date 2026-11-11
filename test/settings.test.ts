import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  applyPluginSettings,
  protoValueToJs,
  readSettingsNamespace,
  SETTINGS_NAMESPACE,
} from "../src/soulfire/settings.js";

const base = loadConfig({ env: { SF_TOKEN: "token" }, cwd: process.cwd() });

const proto = (kindCase: string, value?: unknown) => ({ kind: { case: kindCase, value } });

describe("protoValueToJs", () => {
  it("unwraps scalars", () => {
    expect(protoValueToJs(proto("stringValue", "all"))).toBe("all");
    expect(protoValueToJs(proto("numberValue", 7000))).toBe(7000);
    expect(protoValueToJs(proto("boolValue", true))).toBe(true);
    expect(protoValueToJs(proto("nullValue"))).toBeNull();
  });

  it("unwraps lists and structs", () => {
    expect(
      protoValueToJs(proto("listValue", { values: [proto("stringValue", "legendary"), proto("stringValue", "default")] })),
    ).toEqual(["legendary", "default"]);

    expect(
      protoValueToJs(
        proto("structValue", { fields: { a: proto("numberValue", 1), b: proto("stringValue", "x") } }),
      ),
    ).toEqual({ a: 1, b: "x" });
  });

  it("returns undefined for malformed values", () => {
    expect(protoValueToJs(undefined)).toBeUndefined();
    expect(protoValueToJs({})).toBeUndefined();
    expect(protoValueToJs({ kind: {} })).toBeUndefined();
  });
});

describe("readSettingsNamespace", () => {
  it("flattens the requested namespace and ignores others", () => {
    const info = {
      config: {
        settings: [
          {
            namespace: SETTINGS_NAMESPACE,
            entries: [
              { key: "home-anarchy", value: proto("stringValue", "302") },
              { key: "mines-poll-interval-ms", value: proto("numberValue", 5000) },
            ],
          },
          {
            namespace: "something-else",
            entries: [{ key: "enabled", value: proto("boolValue", false) }],
          },
        ],
      },
    };

    expect(readSettingsNamespace(info as never, SETTINGS_NAMESPACE)).toEqual({
      "home-anarchy": "302",
      "mines-poll-interval-ms": 5000,
    });
  });

  it("returns an empty map when the namespace is absent", () => {
    expect(readSettingsNamespace({ config: { settings: [] } } as never, SETTINGS_NAMESPACE)).toEqual({});
  });

  it("merges plugin defaults with saved values (saved wins)", () => {
    const info = {
      settingsDefinitions: [
        {
          id: { namespace: SETTINGS_NAMESPACE, key: "home-anarchy" },
          type: { case: "string", value: { def: "302" } },
        },
        {
          id: { namespace: SETTINGS_NAMESPACE, key: "mines-poll-interval-ms" },
          type: { case: "int", value: { def: 7000 } },
        },
      ],
      config: {
        settings: [
          {
            namespace: SETTINGS_NAMESPACE,
            entries: [{ key: "mines-poll-interval-ms", value: proto("numberValue", 5000) }],
          },
        ],
      },
    };

    expect(readSettingsNamespace(info as never, SETTINGS_NAMESPACE)).toEqual({
      "home-anarchy": "302",
      "mines-poll-interval-ms": 5000,
    });
  });
});

describe("applyPluginSettings", () => {
  it("overrides operational settings but keeps secrets", () => {
    const merged = applyPluginSettings(base, {
      "mines-poll-interval-ms": 5000,
      "home-command": "/clan home 2",
      "home-anarchy": "511",
      "target-strategy": "round_robin",
      "target-rarity": ["mythical", "default"],
    });

    expect(merged.mines.pollIntervalMs).toBe(5000);
    expect(merged.base.homeCommand).toBe("/clan home 2");
    expect(merged.base.homeAnarchy).toBe("511");
    expect(merged.targets.strategy).toBe("round_robin");
    expect(merged.targets.rarity).toEqual(["mythical", "default"]);
    expect(merged.soulfire.token).toBe("token");
  });

  it("keeps local values for keys the plugin did not provide", () => {
    const merged = applyPluginSettings(base, {});
    expect(merged.mines.pollIntervalMs).toBe(base.mines.pollIntervalMs);
    expect(merged.targets.travelMs).toBe(base.targets.travelMs);
  });

  it("treats an empty home anarchy as unset", () => {
    const merged = applyPluginSettings({ ...base, base: { ...base.base, homeAnarchy: "302" } }, {
      "home-anarchy": "",
    });
    expect(merged.base.homeAnarchy).toBeUndefined();
  });

  it("ignores unknown keys", () => {
    const merged = applyPluginSettings(base, { "some-future-key": 1 });
    expect(merged.mines.pollIntervalMs).toBe(base.mines.pollIntervalMs);
  });

  it("rejects an invalid strategy", () => {
    expect(() => applyPluginSettings(base, { "target-strategy": "random" })).toThrow(ConfigError);
  });

  it("rejects an inverted lead window", () => {
    expect(() =>
      applyPluginSettings(base, { "target-min-lead-ms": 90000, "target-max-lead-ms": 10000 }),
    ).toThrow(ConfigError);
  });

  it("rejects a malformed url", () => {
    expect(() => applyPluginSettings(base, { "mines-api-url": "not a url" })).toThrow(ConfigError);
  });
});
