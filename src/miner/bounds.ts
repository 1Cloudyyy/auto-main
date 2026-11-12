/** Horizontal bounds of the FunTime mine cuboid (Y is handled separately). */
export interface MineBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Default mine cuboid: X 69..89, Z -8..11 (owner-confirmed). */
export const DEFAULT_MINE_BOUNDS: MineBounds = {
  minX: 69,
  maxX: 89,
  minZ: -8,
  maxZ: 11,
};

/** Where `/warp mine` puts the bot (it sits outside the cuboid). */
export const DEFAULT_WARP_POINT = { x: 61, y: 86, z: 2 };
