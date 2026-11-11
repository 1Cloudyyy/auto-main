export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface OreBlock extends Vec3 {
  readonly id: string;
}

export interface DigTarget extends Vec3 {
  /** Sum of ore weights inside the bulldozer 3×3 window. */
  readonly value: number;
  /** Number of ore blocks covered by this window. */
  readonly ores: number;
  /** Distance from the planning origin. */
  readonly distance: number;
}

export interface PlanOptions {
  /** Bulldozer window (3 means 3×3). */
  readonly window: number;
  /** Upper bound on returned targets. */
  readonly maxTargets: number;
  /** Optional cuboid filter (mine bounds). */
  readonly minX?: number;
  readonly maxX?: number;
  readonly minY?: number;
  readonly maxY?: number;
  readonly minZ?: number;
  readonly maxZ?: number;
}

/**
 * Plans bulldozer break positions for a set of ore blocks.
 *
 * A break at `p` destroys a `window × window` horizontal area centred on `p`
 * (the plane is horizontal because the bot looks straight down). Candidates are
 * ore positions themselves; the plan is greedy by value and then ordered layer
 * by layer from the top, nearest first, so the bot does not zig-zag.
 */
export function planTargets(
  ores: readonly OreBlock[],
  from: Vec3,
  weights: Readonly<Record<string, number>>,
  options: PlanOptions,
): DigTarget[] {
  const window = Math.max(1, Math.floor(options.window));
  const radius = Math.floor(window / 2);
  const inRange = ores.filter(
    (ore) =>
      (options.minX === undefined || ore.x >= options.minX) &&
      (options.maxX === undefined || ore.x <= options.maxX) &&
      (options.minY === undefined || ore.y >= options.minY) &&
      (options.maxY === undefined || ore.y <= options.maxY) &&
      (options.minZ === undefined || ore.z >= options.minZ) &&
      (options.maxZ === undefined || ore.z <= options.maxZ),
  );

  const remaining = new Map<string, OreBlock>();
  for (const ore of inRange) {
    remaining.set(key(ore), ore);
  }

  const targets: DigTarget[] = [];
  const layers = [...new Set(inRange.map((ore) => ore.y))].sort((a, b) => b - a);

  for (const layer of layers) {
    const layerOres = [...remaining.values()].filter((ore) => ore.y === layer);
    if (layerOres.length === 0) {
      continue;
    }

    // Candidate centres: ore positions on this layer.
    const candidates = dedupe(layerOres).map((ore) => scoreWindow(ore, layerOres, weights, radius));

    const layerTargets: DigTarget[] = [];
    while (candidates.length > 0) {
      candidates.sort((a, b) => b.value - a.value);
      const best = candidates.shift();
      if (best === undefined || best.value <= 0) {
        break;
      }

      layerTargets.push({ ...best, distance: distance(from, best) });

      // Remove ores covered by this window from the remaining pool and from
      // other candidates (their value is now stale).
      for (const ore of layerOres) {
        if (covers(best, ore, radius)) {
          remaining.delete(key(ore));
        }
      }
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (candidate === undefined) {
          continue;
        }
        const covered = layerOres.filter(
          (ore) => remaining.has(key(ore)) && covers(candidate, ore, radius),
        );
        const value = covered.reduce((sum, ore) => sum + weight(ore, weights), 0);
        candidates[index] = { ...candidate, value, ores: covered.length };
        if (value <= 0) {
          candidates.splice(index, 1);
        }
      }
    }

    targets.push(...orderByValue(layerTargets, from));
    if (targets.length >= options.maxTargets) {
      return targets.slice(0, options.maxTargets);
    }
  }

  return targets;
}

function scoreWindow(
  candidate: Vec3,
  layerOres: readonly OreBlock[],
  weights: Readonly<Record<string, number>>,
  radius: number,
): DigTarget {
  const covered = layerOres.filter((ore) => covers(candidate, ore, radius));
  return {
    x: candidate.x,
    y: candidate.y,
    z: candidate.z,
    value: covered.reduce((sum, ore) => sum + weight(ore, weights), 0),
    ores: covered.length,
    distance: 0,
  };
}

function covers(center: Vec3, ore: OreBlock, radius: number): boolean {
  return (
    ore.y === center.y &&
    Math.abs(ore.x - center.x) <= radius &&
    Math.abs(ore.z - center.z) <= radius
  );
}

function orderByValue(targets: readonly DigTarget[], from: Vec3): DigTarget[] {
  return targets
    .map((target) => ({ ...target, distance: distance(from, target) }))
    .sort((a, b) => b.value - a.value || a.distance - b.distance);
}

function dedupe(ores: readonly OreBlock[]): Vec3[] {
  const seen = new Set<string>();
  const result: Vec3[] = [];
  for (const ore of ores) {
    const id = positionKey(ore);
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ x: ore.x, y: ore.y, z: ore.z });
    }
  }
  return result;
}

function weight(ore: OreBlock, weights: Readonly<Record<string, number>>): number {
  return weights[ore.id] ?? weights[shortId(ore.id)] ?? 0;
}

export function shortId(blockId: string): string {
  return blockId.includes(":") ? blockId.slice(blockId.indexOf(":") + 1) : blockId;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function key(ore: Vec3): string {
  return `${positionKey(ore)}|${(ore as OreBlock).id ?? ""}`;
}

function positionKey(ore: Vec3): string {
  return `${ore.x},${ore.y},${ore.z}`;
}


