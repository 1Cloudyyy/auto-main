import { describe, expect, it } from "vitest";
import { fetchMines, MinesApiError } from "../src/mines/client.js";

const API_URL = "https://funtime.example/api/backend/api/v1/plugin/mines";

const payload = {
  servers: {
    anarchy311: [
      {
        "server-ru-name": "Анархия-311",
        "mine-name": "mine-1",
        "mine-rarity": "default",
        "next-mine-rarity": "mythical",
        "reset-seconds-left": 232,
        "reset-ms-left": 231_981,
      },
    ],
    anarchy112: [
      {
        "server-ru-name": "Анархия-112",
        "mine-name": "mine-1",
        "mine-rarity": "legendary",
        "next-mine-rarity": "default",
        "reset-seconds-left": 30,
      },
    ],
  },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("fetchMines", () => {
  it("normalises the payload and sorts by server", async () => {
    const entries = await fetchMines({ apiUrl: API_URL, fetchImpl: fakeFetch(payload) });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.serverKey).toBe("anarchy112");
    expect(entries[1]?.serverKey).toBe("anarchy311");

    const leg = entries[0];
    expect(leg?.rarity).toBe("legendary");
    expect(leg?.resetMsLeft).toBe(30_000);

    const def = entries[1];
    expect(def?.resetMsLeft).toBe(231_981);
    expect(def?.nextRarity).toBe("mythical");
    expect(def?.serverName).toBe("Анархия-311");
  });

  it("passes server-types to the query string", async () => {
    let requested = "";
    const spy = (async (input: string | URL) => {
      requested = input.toString();
      return new Response(JSON.stringify({ servers: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchMines({ apiUrl: API_URL, serverTypes: "1xx,2xx", fetchImpl: spy });
    expect(requested).toContain("server-types=1xx%2C2xx");
  });

  it("throws MinesApiError on a non-2xx response", async () => {
    await expect(
      fetchMines({ apiUrl: API_URL, fetchImpl: fakeFetch({ error: "nope" }, 503) }),
    ).rejects.toBeInstanceOf(MinesApiError);
  });

  it("throws MinesApiError on invalid json", async () => {
    await expect(
      fetchMines({ apiUrl: API_URL, fetchImpl: fakeFetch("<html>oops</html>") }),
    ).rejects.toBeInstanceOf(MinesApiError);
  });

  it("throws MinesApiError on an unexpected shape", async () => {
    await expect(
      fetchMines({ apiUrl: API_URL, fetchImpl: fakeFetch({ servers: { a: "not-an-array" } }) }),
    ).rejects.toBeInstanceOf(MinesApiError);
  });

  it("returns an empty list when the server reports no mines", async () => {
    await expect(fetchMines({ apiUrl: API_URL, fetchImpl: fakeFetch({ servers: {} }) })).resolves.toEqual([]);
  });
});
