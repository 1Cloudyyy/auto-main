import { create } from "@bufbuild/protobuf";
import { GoToRequestSchema } from "../node_modules/@soulfiremc/sdk/dist/generated/soulfire/bot_live_pb.js";

const xz = { x: 1.5, z: 2.5, dimension: "minecraft:overworld", radius: 1 };

const shapes: Array<[string, unknown]> = [
  ["case/value", { goal: { goal: { case: "xz", value: xz } }, options: {} }],
  ["field-name", { goal: { xz } }],
  ["case+field", { goal: { goal: { case: "xz", xz } } }],
  ["flat", { goal: { case: "xz", value: xz } }],
];

for (const [name, init] of shapes) {
  try {
    const msg = create(GoToRequestSchema, init as never);
    const goal = msg.goal as unknown as { goal?: { case?: string }; case?: string };
    console.log(name, "->", JSON.stringify(goal?.goal ?? goal));
  } catch (error) {
    console.log(name, "-> ERROR", error instanceof Error ? error.message : String(error));
  }
}

