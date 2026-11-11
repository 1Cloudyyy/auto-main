# auto-main plugin

Fabric plugin for SoulFire that registers the **Auto-Main** instance settings page
(namespace `auto-main`). It adds no gameplay logic: the TypeScript controller reads
these values from `InstanceInfo.config.settings` and merges them over its local config.

Keys (kebab-case) are mirrored in `../src/soulfire/settings.ts`:

- `enabled`
- `mines-api-url`, `mines-server-types`, `mines-poll-interval-ms`
- `home-command`, `home-anarchy`
- `target-strategy`, `target-travel-ms`, `target-min-lead-ms`, `target-max-lead-ms`
- `target-rarity`, `target-allow`, `target-deny`

## Build

Requires JDK 25 (Gradle toolchain) and network access to Fabric/Mojang/SoulFire repositories.

```bash
cd plugin
sh ./gradlew build
```

The jar lands in `plugin/build/libs/`. On the dedicated server, put it into
`/soulfire/data/minecraft/mods` and restart SoulFire.
