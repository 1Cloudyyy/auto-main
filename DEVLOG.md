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

## 2026-11-11 — база через `/clan home`

- Подтверждено владельцем: кланы связывают анархии, `/clan home` телепортирует на базу
  с **любой** анархии. Отдельная мейн-анархия в FSM не нужна.
- FSM: `RETURN_MAIN` → `GO_HOME (/clan home)`; убрано исключение мейна из целей фарма.
- Конфиг: добавлен `base.homeCommand` (env `BASE_HOME_COMMAND`, default `/clan home`) + 5 тестов.
- Документы: `Концепция_v0.md` §4, §7, §8; `КОНСПЕКТ.md` §13.
- Осталось выяснить: координаты воронок относительно точки `/clan home`, число воронок,
  кулдаун `/clan home`.

## 2026-11-11 — клан-хом привязан к одной анархии

- Поправка владельца: `/clan home` зарегистрирован **только на одной (main) анархии** (например, `/an302`).
  Боты фармят все анархии, кроме неё.
- Маршрут отгрузки: `MINE` → `/an302` → `/clan home` → база (drop + repair) → `/anN` (следующая цель).
- Конфиг: добавлен `base.homeAnarchy` (env `BASE_HOME_ANARCHY`).
- `targetPolicy()` мержит home-анархию в deny, CLI `mines` использует эффективную политику —
  главная анархия никогда не выбирается целью.
- Тесты: +3 (всего 23), typecheck чистый.
- Точку хома и членство в клане владелец настраивает вручную; продажа — тоже вручную.

## 2026-11-11 — plugin settings page live

- Added `plugin/` (Fabric mod, id `auto-main`, from the official template) that registers an
  instance settings page `auto-main` with: mines API URL/filter/interval, home command/anarchy,
  target strategy, travel/lead windows, rarity/allow/deny.
- Build: `eclipse-temurin:25-jdk` + `./gradlew build` in Docker (host has no JDK).
  Loom 1.15.4, compiled against `com.soulfiremc:mod:2.10.1` (latest published artifact);
  runtime is SoulFire 2.10.7 — plugin loads cleanly.
- Template fixes needed: `SoulFireAPI.registerServerExtension` no longer exists → `loadPlugin`;
  `com.soulfiremc:shared` is not published past 2.9.x → removed.
- Jar deployed to `/soulfire/data/minecraft/mods/auto-main-plugin-0.1.0.jar`, app restarted healthy.
- Controller: `src/soulfire/settings.ts` merges plugin defaults (`settings_definitions[].type.value.def`)
  with saved values (`config.settings[].entries`) and overlays them on env/yaml. `doctor` prints the
  full effective map. 36 tests, typecheck clean.
- Gotcha: `gradlew` from a Windows checkout has CRLF → build fails on Linux; added `.gitattributes`
  (`eol=lf`, wrapper jar binary).

## 2026-11-11 — test mode

- Plugin: new instance setting `test-mode` (checkbox "Test mode", default off) with description
  "Skip base trips (drop, repair); stop when inventory and shulkers are full".
- Controller: `runtime.testMode` (`TEST_MODE` env, plugin key `test-mode`), merged and validated;
  `doctor` prints the effective value and raw plugin map.
- Semantics for the upcoming modules: when on, `GO_MAIN`/`GO_HOME`/`DROP`/`REPAIR` are skipped and the
  run ends when inventory + shulkers are full — so the chain API → `/anN` → `/warp mine` → mining →
  shulker packing can be tested without the base.
- Plugin rebuilt and redeployed (`auto-main-plugin-0.1.0.jar`), app healthy, `test-mode` visible in
  `doctor`. 38 tests, typecheck clean.

## 2026-11-11 — miner v0 (planner + runner + CLI)

- `src/miner/planner.ts` — pure planning: candidates are ore positions, value = weighted ores inside
  the bulldozer 3×3 window on the same Y layer, greedy by value, layers top-down, targets ordered by
  value then distance. Y-range filter for the mine cuboid.
- `src/miner/runner.ts` — live loop: `/anN` → `/warp mine` → `waitForChunks` → `findBlocks` →
  plan batch → `goTo` (block goal, radius 2, deadline) → `digBlock` → repeat until `--seconds` or
  `--max-dig`. Logs every dig at debug and a summary at info.
- CLI: `auto-main mine --anarchy 205 --seconds 180 --max-dig 150` plus tuning flags
  (`--radius`, `--batch`, `--reach`, `--step-ms`, `--goto-ms`, warp/anarchy waits, `--start`).
- Tests: planner (9 cases) — 47 total, typecheck clean.
- Known unknowns to verify in game: does `DigBlock` rotate the bot (affects the 3×3 plane), how many
  block updates arrive after one break, real travel time between anarchies.

## 2026-11-11 — miner fixes after first live run

Live run (anarchy 202) exposed four real issues, all fixed:

1. **No control lease** — SF rejects actions with `FAILED_PRECONDITION` unless the client owns a lease.
   Runner now acquires a 120s lease, renews every 60s, releases in `finally` and on SIGINT/SIGTERM,
   and retries every 5s for up to 90s when another client holds it.
2. **Targets outside the mine** — `findBlocks(radius 40)` returned ore at y=107 / z=-18. Added cuboid
   bounds (X 69..89, Z -9..11, Y 76..85), default radius 24.
3. **`goTo` did not move the bot** — block goal with radius 1 is unreachable inside stone. Switched to
   an XZ goal (radius 2, overworld), then poll `liveState` every 300ms and only dig when within reach;
   otherwise log `could not reach target` and skip.
4. **No rotation** — the SDK does expose `bot.look(yaw, pitch)` (BotService rotation RPC). Runner now
   looks straight down (pitch 90) before each `digBlock`, so the bulldozer plane is horizontal.

Remaining blocker for a live test: the SoulFire desktop/web client holds the lease while the bot is
open there (`already_exists: Bot control is already leased`), so the controller cannot act. Close the
client (or stop viewing the bot) before running the controller; in production the farm is headless.

Diagnostics: `npx tsx scripts/probe-lease.ts` reports whether the lease is free.

## 2026-11-11 — navigation lessons from live runs

Verified working: connect/lease → `/anN` → `/warp mine` → enter mine → `findBlocks` → `digBlock`
(one run: 5 digs, 10 ore blocks). Everything below was added after real failures.

- **Lease renew** defaulted to 30s (`renew()`), so the lease died mid-run. Now `renew(120)`.
- **Dig timeout**: a blocked/protected block made `digBlock` hang ~60s. Now 8s deadline + `cancel`
  + per-run blacklist.
- **Pickaxe slot**: `pickaxe-slot` (1–9) in the plugin page; the bot selects it and verifies the item,
  falling back to the first `*_pickaxe` in the hotbar with a warning. Live check found a
  `stone_pickaxe` in slot 2 while slot 1 was configured.
- **Anarchy numbering**: FunTime uses three-digit groups only (1xx solo, 2xx duo, 3xx trio, 5xx five,
  9xx ten). `normalizeAnarchy` rejects anything else — an earlier `/an21` test silently stayed on the
  previous server.
- **Dimension**: the mine lives in `minecraft:lobby`, not overworld. `goTo` now uses
  `liveState().dimension`; hardcoding overworld caused `Cross-dimension pathfinding is not supported`.
- **Planning by layer**: the plan is capped at the bot's current Y, and re-planned when the bot falls
  a layer; otherwise it kept requesting ore above it.
- **Movement**: `goTo` (xz, radius 2, allowMining) first; if it fails, raw forward+jump walking.

Known unsolved: in an already-dug mine the bot often ends up in a 1-block hole at the bottom and cannot
climb or cross the 3x3 gaps; digs then time out. Next iteration: tunnel-toward-target (break the block
in front of the desired direction instead of pathfinding), and test only on a freshly reset mine.

## 2026-11-12 � task-based collector (works)

`auto-main collect` uses SoulFire's built-in `CollectBlocksTask` instead of our hand-rolled
navigation. Live run on anarchy 226:

```
status=COMPLETED reason=NO_REACHABLE_BLOCKS blocksBroken=42 elapsed=116s
```

That is the first stable engine: the server-side task handles pathfinding, line of sight and digging,
we only provide anarchy, warp and the block filter.

Also fixed: warp position verification (the warp point is 61,86,2, outside the mine cuboid, so the old
check always failed and re-sent the warp).

## 2026-11-12 � rotation loop

`auto-main farm` added: dispatcher target -> `/anN` -> warp (3 attempts, verified by position **and**
dimension `minecraft:lobby`) -> SF `collectBlocks` task -> next mine. Failed or empty mines are
blacklisted for the session; stop on SIGINT or after N empty mines.

Shared navigation moved to `src/soulfire/nav.ts` (`isAtMine`, `waitForMinePosition`, `warpToMine`,
`ensureOnline`, `acquireLease`). Mine cuboid and warp point constants live in `src/miner/bounds.ts`.

Live verification was interrupted: the VDS stopped answering SSH (banner timeout) while ports 22/443
still accept TCP. Code compiles, 50 tests pass; farm must be re-tested once the host is back.
