/**
 * One mine as reported by https://funtime.me/mines backend
 * (`/api/backend/api/v1/plugin/mines`).
 */
export interface MineEntry {
  /** Raw server key, e.g. `anarchy311`. */
  readonly serverKey: string;
  /** Human readable name, e.g. `Анархия-311`. */
  readonly serverName: string;
  /** Mine id inside the server, e.g. `mine-1`. */
  readonly mineName: string;
  /** Current rarity: `default` | `mythical` | `legendary` (open set). */
  readonly rarity: string;
  /** Rarity that will be applied on the next reset. */
  readonly nextRarity: string;
  /** Milliseconds until the mine resets at the moment of observation. */
  readonly resetMsLeft: number;
  /** Local time (ms) when the payload was received. */
  readonly observedAtMs: number;
}

/** `/an311` for `anarchy311`; `null` when the key has another shape. */
export function anarchyCommand(serverKey: string): string | null {
  const number = serverNumber(serverKey);
  return number === null ? null : `/an${number}`;
}

/** Numeric part of the server key (`311` for `anarchy311`). */
export function serverNumber(serverKey: string): string | null {
  const match = /^anarchy(\d+)$/i.exec(serverKey);
  return match?.[1] ?? null;
}
