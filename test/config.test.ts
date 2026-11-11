import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const cwd = process.cwd();

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ env: { SF_TOKEN: "token" }, cwd });

    expect(config.soulfire.baseUrl).toBe("https://217.60.33.212");
    expect(config.soulfire.instance).toBe("ft");
    expect(config.base.homeCommand).toBe("/clan home");
    expect(config.mines.serverTypes).toBe("all");
    expect(config.targets.strategy).toBe("timer");
    expect(config.runtime.dataDir).toBe("var");
  });

  it("applies environment overrides", () => {
    const config = loadConfig({
      env: {
        SF_TOKEN: "token",
        SF_INSTANCE: "farm",
        BASE_HOME_COMMAND: "/clan home 2",
        TARGET_STRATEGY: "round_robin",
        TARGET_RARITY: "legendary, mythical",
        MINES_POLL_INTERVAL_MS: "1500",
      },
      cwd,
    });

    expect(config.soulfire.instance).toBe("farm");
    expect(config.base.homeCommand).toBe("/clan home 2");
    expect(config.targets.strategy).toBe("round_robin");
    expect(config.targets.rarity).toEqual(["legendary", "mythical"]);
    expect(config.mines.pollIntervalMs).toBe(1500);
  });

  it("requires a token", () => {
    expect(() => loadConfig({ env: {}, cwd })).toThrow(ConfigError);
  });

  it("rejects an inverted lead window", () => {
    expect(() =>
      loadConfig({
        env: { SF_TOKEN: "token", TARGET_MIN_LEAD_MS: "90000", TARGET_MAX_LEAD_MS: "10000" },
        cwd,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects non-numeric numbers", () => {
    expect(() => loadConfig({ env: { SF_TOKEN: "token", TARGET_TRAVEL_MS: "soon" }, cwd })).toThrow(
      ConfigError,
    );
  });
});
