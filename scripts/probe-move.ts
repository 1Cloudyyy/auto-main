import { Effect, Stream } from "effect";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { connectClient, resolveBot, resolveInstance } from "../src/soulfire/connect.js";

loadDotEnv();
const config = loadConfig();
const log = createLogger({ level: "debug", pretty: true });

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* connectClient(config);
    const instance = yield* resolveInstance(client, config.soulfire.instance);
    const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);
    if (!entry.isOnline) {
      console.log("bot is offline");
      return;
    }

    const lease = yield* bot.acquireControl(120);
    console.log("lease acquired");

    const state = yield* bot.liveState();
    console.log("start", [state.x, state.y, state.z], "rot", state.yRot, state.xRot);

    const goal = {
      goal: {
        goal: {
          case: "xz" as const,
          value: { x: state.x + 2.5, z: state.z + 0.5, dimension: "minecraft:overworld", radius: 1 },
        },
      },
      options: { allowMining: false, allowPlacing: false, timeoutSeconds: 10 },
    };

    const drained = Effect.runPromise(Stream.runDrain(bot.goTo(goal))).then(
      () => console.log("goTo stream completed"),
      (error: unknown) => console.log("goTo stream error:", error instanceof Error ? error.message : String(error)),
    );

    for (let i = 0; i < 12; i += 1) {
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
      const s = yield* bot.liveState();
      console.log(`t+${(i + 1) * 0.5}s`, [Math.round(s.x), Math.round(s.y), Math.round(s.z)]);
    }

    yield* bot.stopPathfinding();
    yield* Effect.promise(() => drained);
    yield* lease.release();
    console.log("done");
  }),
);

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});


