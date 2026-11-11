# DEVLOG

## 2026-11-11 — bootstrap

### Environment
- Local: Windows, Node 24.18, npm 11.16, git 2.55, gh 2.97 (authenticated as 1Cloudyyy).
- Repo: `1Cloudyyy/auto-main` (private), branch `main`.
- Runtime target: VDS `217.60.33.212` in Docker next to SoulFire.

### Version pins (do not float)
- `@soulfiremc/sdk` **2.10.7** — exactly matches the deployed SoulFire 2.10.7.
- Minecraft protocol for bots: **767** (1.21.x). 777 breaks the connection (`unknown packet id 24`).
- `effect` 4.x — the SDK is Effect-based, so the controller is written in `Effect.gen`.

### Decisions
- Controller is an external TypeScript service, not a SoulFire plugin (see `КОНСПЕКТ.md` §14).
- Dispatcher is pure logic (`planNextTarget`) with injected policy, so it is unit-testable
  without network or a running server.
- Mines API is polled at `/api/backend/api/v1/plugin/mines?server-types=all` and parsed with zod
  (raw payload uses kebab-case keys; normalised into `MineEntry`).
- `reset-ms-left` is trusted as given; when absent we fall back to `reset-seconds-left * 1000`.
- Recorder attaches to an already online bot by default; `--start` is explicit to avoid
  touching a session the owner is using manually.

### Implemented (stage 0)
- `src/config.ts` — zod schema, env + optional `config/app.yaml`, validation of lead window.
- `src/log.ts` — pino, pretty in TTY.
- `src/mines/{types,client,dispatcher}.ts` — API client, normalisation, target selection
  (`timer` and `round_robin`), rarity weighting.
- `src/soulfire/{connect,recorder}.ts` — client connect, instance/bot resolution,
  command run + `findBlocks` snapshot to JSONL.
- `src/cli.ts` — `doctor`, `mines`, `record`.
- `test/` — dispatcher and mines-client unit tests.

### Verified
- `npm run typecheck` and `npm test` (see commit message / CI-less local run).
- `doctor` is the first live check to run against the VDS after filling `.env`.

### Next
1. Run `doctor` against the VDS; confirm instance `ft` and bot resolution.
2. Run `record` on a test anarchy: one warp, one snapshot → `var/*.jsonl`.
3. Closed-loop questions from `КОНСПЕКТ.md` §13.2 (block_updates, travel timing, reach).
4. Then miner (layer sweep, stride 3) — see `Концепция_v0.md` §11 stage 2.

### Open questions
- Exact main-anarchy command and base coordinates (spawn, hoppers, bottle chest).
- Whether the server sends the 8 neighbour block updates in one packet after a bulldozer break.
- Real `/anN` + chunk-load timing (affects `travelMs` in the dispatcher).
