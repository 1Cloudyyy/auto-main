import { z } from "zod";
import type { MineEntry } from "./types.js";

const WireMineSchema = z.object({
  "server-ru-name": z.string().default(""),
  "mine-name": z.string().default("mine-1"),
  "mine-rarity": z.string().default("default"),
  "next-mine-rarity": z.string().default("default"),
  "reset-seconds-left": z.number().optional(),
  "reset-ms-left": z.number().optional(),
});

const WireResponseSchema = z.object({
  servers: z.record(z.string(), z.array(WireMineSchema)),
});

type WireMine = z.infer<typeof WireMineSchema>;

export class MinesApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MinesApiError";
    this.status = status;
  }
}

export interface MinesClientOptions {
  apiUrl: string;
  serverTypes?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches every reported mine and normalises it into a flat list.
 * The endpoint is documented in `КОНСПЕКТ.md` §3.
 */
export async function fetchMines(options: MinesClientOptions): Promise<MineEntry[]> {
  const { apiUrl, serverTypes = "all", timeoutMs = 10_000, fetchImpl = fetch } = options;

  const url = new URL(apiUrl);
  url.searchParams.set("server-types", serverTypes);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new MinesApiError(`Mines API request failed: ${describe(cause)}`, undefined, cause);
  }

  if (!response.ok) {
    throw new MinesApiError(`Mines API responded ${response.status} ${response.statusText}`, response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (cause) {
    throw new MinesApiError("Mines API returned invalid JSON", response.status, cause);
  }

  const parsed = WireResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new MinesApiError(`Unexpected mines payload shape: ${details}`);
  }

  const observedAtMs = Date.now();
  const entries: MineEntry[] = [];
  for (const [serverKey, mines] of Object.entries(parsed.data.servers)) {
    for (const mine of mines) {
      entries.push(toEntry(serverKey, mine, observedAtMs));
    }
  }

  return entries.sort((a, b) =>
    a.serverKey.localeCompare(b.serverKey, "en", { numeric: true }),
  );
}

function toEntry(serverKey: string, mine: WireMine, observedAtMs: number): MineEntry {
  const resetMs = mine["reset-ms-left"] ?? (mine["reset-seconds-left"] ?? 0) * 1000;

  return {
    serverKey,
    serverName: mine["server-ru-name"] || serverKey,
    mineName: mine["mine-name"],
    rarity: mine["mine-rarity"],
    nextRarity: mine["next-mine-rarity"],
    resetMsLeft: Math.max(0, Math.round(resetMs)),
    observedAtMs,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timeout" : error.message;
  }
  return String(error);
}
