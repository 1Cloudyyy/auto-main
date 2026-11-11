import { Effect } from "effect";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { connectClient, resolveInstance } from "../src/soulfire/connect.js";

loadDotEnv();
const config = loadConfig();

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* connectClient(config);
    const instance = yield* resolveInstance(client, config.soulfire.instance);
    const info = yield* instance.info();

    const pages = (info.config?.settings ?? []).map((ns) => ({
      namespace: ns.namespace,
      entries: ns.entries.map((entry) => entry.key),
    }));

    const definitions = info.settingsDefinitions
      .filter((definition) => definition.id?.namespace === "auto-main")
      .map((definition) => ({
        key: definition.id?.key,
        scope: definition.scope,
        type: definition.type.case,
        value: definition.type.value,
      }));

    const uiPages = info.instanceSettings.map((page) => ({
      id: page.id,
      name: page.name,
      entries: page.entries.length,
    }));

    console.log(JSON.stringify({ pages, uiPages, definitions }, null, 2));
  }),
);

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
