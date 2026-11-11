# auto-main

Controller for an autonomous FunTime auto-mine farm running on a SoulFire backend.

Private project. Runtime lives on the VDS next to SoulFire; the local machine is
only used for development.

## Status

Stage 0 — data collection (`КОНСПЕКТ.md` §13.2):

- `doctor` — verifies SoulFire connectivity, instance and bot resolution;
- `mines` — polls the FunTime mines API and prints the chosen target;
- `record` — attaches to a running bot, runs commands, snapshots ore blocks to JSONL.

Mining, inventory, rotation and offload modules are not implemented yet
(see `Концепция_v0.md` §11).

## Requirements

- Node.js >= 22 (developed on 24)
- SoulFire 2.10.7 (`@soulfiremc/sdk` is pinned to the same version)
- API token: run `generate-token api` in the SoulFire console

## Setup

```bash
npm ci
cp .env.example .env
# fill SF_TOKEN
npm run typecheck
npm test
```

## Usage

```bash
npm run dev -- doctor
npm run dev -- mines --limit 15
npm run dev -- mines --watch --json
npm run dev -- mine --anarchy 205 --seconds 120 --max-dig 80
npm run dev -- record --commands "/an205,/warp mine" --wait 20000 --out var/mine-205.jsonl
```

`record` attaches to an already running bot; pass `--start` only when you want the
controller to start it.

## Configuration

Precedence: environment variables > `config/app.yaml` > defaults.
See `.env.example`. Anything addressable (anarchies, stash points, thresholds)
belongs in config, not in code.

## Deploy (VDS)

```bash
docker compose up -d --build
docker compose logs -f controller
```

The container is intended to run 24/7 next to SoulFire (`restart: unless-stopped`).

## Layout

```
src/
  config.ts              zod schema, env/yaml loading
  log.ts                 pino logger
  mines/types.ts         MineEntry + server helpers
  mines/client.ts        FunTime mines API client
  mines/dispatcher.ts    target selection (timer / round_robin)
  soulfire/connect.ts    SoulFire client, instance/bot resolution
  soulfire/recorder.ts   attach -> commands -> findBlocks -> JSONL
  cli.ts                 doctor | mines | record
test/                    vitest unit tests
```
