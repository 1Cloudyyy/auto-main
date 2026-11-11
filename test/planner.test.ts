import { describe, expect, it } from "vitest";
import { distance, planTargets, shortId } from "../src/miner/planner.js";
import type { OreBlock } from "../src/miner/planner.js";

const weights = {
  "minecraft:diamond_ore": 1,
  "minecraft:gold_ore": 0.5,
  "minecraft:redstone_ore": 0.05,
};

const diamond = (x: number, y: number, z: number): OreBlock => ({
  x,
  y,
  z,
  id: "minecraft:diamond_ore",
});

const gold = (x: number, y: number, z: number): OreBlock => ({
  x,
  y,
  z,
  id: "minecraft:gold_ore",
});

describe("planTargets", () => {
  it("covers a 3×3 cluster with a single break", () => {
    const ores = [
      diamond(0, 85, 0),
      diamond(1, 85, 0),
      diamond(2, 85, 0),
      diamond(0, 85, 1),
      diamond(1, 85, 1),
      diamond(2, 85, 1),
      diamond(0, 85, 2),
      diamond(1, 85, 2),
      diamond(2, 85, 2),
    ];

    const targets = planTargets(ores, { x: 1, y: 86, z: 1 }, weights, {
      window: 3,
      maxTargets: 10,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.ores).toBe(9);
    expect(targets[0]?.value).toBe(9);
  });

  it("produces separate targets for distant clusters", () => {
    const ores = [diamond(0, 85, 0), diamond(10, 85, 10)];

    const targets = planTargets(ores, { x: 0, y: 86, z: 0 }, weights, {
      window: 3,
      maxTargets: 10,
    });

    expect(targets).toHaveLength(2);
  });

  it("works top-down layer by layer", () => {
    const ores = [diamond(0, 84, 0), diamond(0, 85, 0)];

    const targets = planTargets(ores, { x: 0, y: 90, z: 0 }, weights, {
      window: 3,
      maxTargets: 10,
    });

    expect(targets.map((target) => target.y)).toEqual([85, 84]);
  });

  it("prefers diamonds over gold", () => {
    const ores = [gold(0, 85, 0), diamond(20, 85, 20)];

    const targets = planTargets(ores, { x: 0, y: 86, z: 0 }, weights, {
      window: 3,
      maxTargets: 10,
    });

    expect(targets[0]?.x).toBe(20);
  });

  it("respects maxTargets", () => {
    const ores = Array.from({ length: 10 }, (_, index) => diamond(index * 10, 85, 0));

    const targets = planTargets(ores, { x: 0, y: 86, z: 0 }, weights, {
      window: 3,
      maxTargets: 3,
    });

    expect(targets).toHaveLength(3);
  });

  it("filters by Y range", () => {
    const ores = [diamond(0, 90, 0), diamond(0, 80, 0)];

    const targets = planTargets(ores, { x: 0, y: 91, z: 0 }, weights, {
      window: 3,
      maxTargets: 10,
      minY: 76,
      maxY: 85,
    });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.y).toBe(80);
  });

  it("ignores ores without weight", () => {
    const ores: OreBlock[] = [{ x: 0, y: 85, z: 0, id: "minecraft:coal_ore" }];

    const targets = planTargets(ores, { x: 0, y: 86, z: 0 }, weights, {
      window: 3,
      maxTargets: 10,
    });

    expect(targets).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("strips the namespace", () => {
    expect(shortId("minecraft:diamond_ore")).toBe("diamond_ore");
    expect(shortId("diamond_ore")).toBe("diamond_ore");
  });

  it("computes euclidean distance", () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });
});
