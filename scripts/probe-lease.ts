import { Effect } from "effect";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { connectClient, resolveBot, resolveInstance } from "../src/soulfire/connect.js";

loadDotEnv();
const config = loadConfig();

const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* connectClient(config);
    const instance = yield* resolveInstance(client, config.soulfire.instance);
    const { bot, entry } = yield* resolveBot(instance, config.soulfire.bot);

    console.log(`bot: ${entry.accountName ?? entry.profileId} online=${entry.isOnline}`);

    try {
      const lease = yield* bot.acquireControl(5);
      yield* lease.release();
      console.log("lease: free (acquired and released)");
    } catch (error) {
      console.log(`lease: BUSY -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }),
);

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
