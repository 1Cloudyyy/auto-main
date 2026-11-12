# HANDOFF — Auto-Main (состояние на 2026-11-12)

Документ для нового диалога: что сделано, какие решения приняты, какие API проверены,
где грабли и что дальше. Всё, что ниже, проверено на живой инфраструктуре.

---

## 1. Что это за проект

Автономный фарм шахт на FunTime (`mc.funtime.su`) через **SoulFire**.
Задача: бот сам выбирает анархию по API шахт, приходит на варп, добывает руду
(алмаз/золото приоритетно), складывает в шалкеры, при заполнении — на базу через клан-хом.

Репозиторий: `github.com/1Cloudyyy/auto-main` (**private**), ветка `main`.
Локальная копия: `C:\Users\клауд\Desktop\Auto-Main\auto-main`.
Заметки проекта: `C:\Users\клауд\Desktop\Auto-Main\КОНСПЕКТ.md`, `Концепция_v0.md`.

Теги: `v0.1.0` bootstrap → `v0.1.1` clan home → `v0.1.2` home anarchy → `v0.2.0` плагин настроек
→ `v0.2.1` test mode → `v0.3.0` miner v0 → `v0.3.1` lease/bounds/goTo → `v0.4.0` pickaxe slot +
валидация анархий → `v0.4.1` вход на поверхность → **`v0.5.0` task-коллектор (рабочий движок)**.

---

## 2. Инфраструктура

- VDS: `217.60.33.212`, Ubuntu 24.04.3, 4 vCPU / 7.8 GB / 145 GB, Docker 29.9.3, Compose v5.7.
- SSH: ключ `C:\Users\клауд\.ssh\vds_soulfire`, пользователи `root` и `deploy`.
- SoulFire **2.10.7** в `/opt/soulfire` (контейнеры `soulfire-app-1`, `soulfire-traefik-1`),
  HTTPS по IP (`https://217.60.33.212`), порт 38765 наружу не публикуется.
- Моды: `/soulfire/data/minecraft/mods/auto-main-plugin-0.1.0.jar` (наш плагин).
- Плагин собирается в Docker `eclipse-temurin:25-jdk` (`sh ./gradlew build`) против
  `com.soulfiremc:mod:2.10.1` (последний опубликованный артефакт; на 2.10.7 грузится нормально).
  Исходники плагина — `plugin/` в репозитории.
- Инстанс в SF: `ft` (uuid `43b84dd0-7d0d-4bd6-893e-8b2c17b31b38`).
- Бот: `HAHAHA_ojfoaf_1` (offline-аккаунт, profile id `2de5776d-400b-309d-8940-2b969f13a230`).
- Токен API: в локальном `.env` (gitignored). Генерируется в консоли SF: `generate-token api`.

### Важные факты о FunTime
- Протокол: бот должен ходить как **767 (1.21.x)**. С 777 — кик `unknown packet id 24`.
- Шахта живёт в измерении **`minecraft:lobby`** (не overworld).
- `/warp mine` ставит на **61 86 2**; кубоид шахты: X **69…89**, Z **−8…11**, Y **85…76**.
  Рядом с варпом — спусковой колодец («карман»), прямолинейный шаг вперёд сваливает в него.
- Кирка с зачарованием «Бульдозер II» ломает **3×3 в плоскости, перпендикулярной взгляду**
  (смотрим вниз → горизонтальная площадка 3×3).
- Анархии **только трёхзначные группы**: `1xx` соло, `2xx` дуо, `3xx` трио, `5xx` по 5, `9xx` до 10.
  `/an226` валиден, `/an21` — нет (раньше молча оставался на прежнем сервере).
- Ресурс-паки SF подтверждает сам; шалкеры открываются ПКМ в воздухе (плагин сервера);
  опыт с добычи не идёт; смерть/потерю шалкеров владелец считает невозможной.
- Клан-хом зарегистрирован **только на главной анархии** (сейчас `302`): отгрузка = `/an302` →
  `/clan home` → база (воронки) → `/anN`.

### API шахт (проверено)
`GET https://funtime.me/api/backend/api/v1/plugin/mines?server-types=all`
→ `{"servers":{"anarchy311":[{"server-ru-name":"Анархия-311","mine-name":"mine-1",
"mine-rarity":"default","next-mine-rarity":"mythical","reset-seconds-left":232,
"reset-ms-left":231981}]}}`. 84 сервера, таймеры размазаны (медиана ~196 с) → возможна ротация.

---

## 3. Архитектура и принятые решения

- Контроллер — **внешний TypeScript-сервис** на `@soulfiremc/sdk` (**2.10.7**, ровно как сервер).
  Не плагин и не визуальный скрипт: SDK покрывает все действия, а логике нужны HTTP, ротация, метрики.
- Рантайм — **на VDS в Docker** (пока не задеплоен, гоняем локально `npm run dev`).
- Настройки — страница в SF UI (плагин `auto-main`), контроллер читает их через `instance.info()`
  и накладывает поверх `.env`. Секреты (токен, URL) остаются в `.env`.
- SDK построен на **Effect v4**; в контроллере используем `Effect.runPromise` и `Effect.gen`.

---

## 4. Что реализовано (файлы)

```
src/config.ts            zod-схема, .env + config/app.yaml, валидация окна lead
src/log.ts               pino
src/policy.ts            targetPolicy(): home-анархия автоматически в deny
src/mines/types.ts       MineEntry, isAnarchyGroupNumber() (^[12359]\d{2}$)
src/mines/client.ts      клиент API шахт (zod, нормализация)
src/mines/dispatcher.ts  timer/round_robin, редкости, allow/deny (только чистые функции)
src/soulfire/connect.ts  подключение, резолв инстанса/бота
src/soulfire/settings.ts чтение namespace `auto-main` (defaults + сохранённые значения) и merge
src/soulfire/recorder.ts привязка → команды → findBlocks → JSONL
src/miner/planner.ts     3×3-планировщик (слой, value, порядок nearest-first) + тесты
src/miner/runner.ts      «ручной» майнер (lease, goTo, look, шаги по осям) — экспериментальный
src/miner/collector.ts   ***рабочий движок***: SF CollectBlocksTask
src/cli.ts               doctor | mines | record | mine | collect
plugin/                  Fabric-плагин: страница настроек `auto-main`
scripts/                 probe-lease.ts, probe-move.ts, probe-goal.ts (диагностика)
test/                    50 тестов (dispatcher, mines, config, settings, planner)
```

Плагин отдаёт ключи: `enabled`, `test-mode`, `pickaxe-slot` (1–9), `mines-api-url`,
`mines-server-types`, `mines-poll-interval-ms`, `home-command`, `home-anarchy`,
`target-strategy`, `target-travel-ms`, `target-min-lead-ms`, `target-max-lead-ms`,
`target-rarity`, `target-allow`, `target-deny`.

CLI:
```
doctor                      проверка SF, инстанса, бота, вывод настроек
mines [--watch] [--json]    поллер API шахт + выбранная цель
record --commands ...       привязка к боту, команды, снимок руды в JSONL
mine --anarchy 226 ...      экспериментальный самописный майнинг
collect --anarchy 226 ...   ***рекомендуемый***: SF CollectBlocksTask
```
Общие флаги: `--offline` (не читать настройки из SF), `--start` (запустить бота), `--ore`, `--radius`,
`--seconds`, `--max`, для `mine` — `--pickaxe-slot`, `--reach`, `--batch`, `--goto-ms` и т.д.

---

## 5. Проверенные API SDK (не переизобретать)

- `client.findBlocks({ blockIds, maxDistance, maxCount })` → позиции блоков.
- `bot.digBlock({ position })` — только в пределах reach; **не поворачивает бота**.
- `bot.look(yaw, pitch)` — yaw: 0 юг, 90 запад, −90 восток; pitch 90 = вниз.
- `bot.selectHotbar(0..8)`; `bot.inventoryState()` (слоты 36–44 — хотбар).
- `bot.goTo({ goal: { goal: { case: "xz", value: { x, z, dimension, radius } } },
  options: { allowMining, allowPlacing, timeoutSeconds } })` → **Stream**.
  `dimension` брать из `bot.liveState().dimension` (иначе `Cross-dimension pathfinding`).
- `bot.liveState()` → x, y, z, xRot, yRot, dimension, health.
- `bot.acquireControl(ttl)` → lease; `lease.renew(ttl)`; `lease.release()`. TTL 5–300 с,
  **`renew()` по умолчанию 30 с** (было причиной «lease expired»).
- `bot.tasks.collectBlocks(ids, { count, searchRadius, requireLineOfSight, avoidSubmergedTargets,
  path, deadline })` → задача; `task.wait()` → snapshot; `task.result()` → `{ reason, blocksBroken }`.
- `instance.info()` → `config.settings[]` (сохранённые) + `settingsDefinitions[]` (defaults в
  `type.value.def`) + `instanceSettings` (страницы UI).

---

## 6. Живые результаты и уроки (по порядку)

1. **Кик по протоколу** → версия 767, не 777.
2. **Ресурс-паки** — SF сам подтверждает, настраивать нечего.
3. **Причины киков** были невидимы → включён debug-лог (`/opt/soulfire/log4j2-debug.xml`),
   сейчас `DisconnectLogger` пишет на INFO. Debug-конфиг шумный, после отладки выключить.
4. **Lease** — SF отдаёт управление одному клиенту. Если открыт десктопный клиент SF
   (websocket `/pov/input`), он держит lease, и контроллер получает `already_exists`.
   Проверка: `npx tsx scripts/probe-lease.ts`. Перед запуском закрывать клиент SF.
5. **Самописный майнер**: цель — блок с радиусом 1 в камне → пасфайндер не строит путь;
   без `allowMining` не может прорубаться; сырые `setMovement` конфликтуют с `goTo` → бот кружит.
   Рабочий максимум — 5–11 ударов за заход, часто 0 из-за таймаутов.
6. **`digBlock` висел 60 с** на защищённых/невидимых блоках → таймаут 8 с + `cancel` + чёрный список.
7. **Планировщик** начинал с верхних слоёв и после падения бота вниз требовал руду сверху →
   теперь `maxY` ограничен текущим Y, перепланирование при смене слоя.
8. **Вход в шахту**: варп стоит рядом с колодцем; прямой шаг вперёд → падение в «карман».
   Смещение по оси (+Z) и остановка на верхнем слое частично помогли, но надёжности нет.
9. **Кирка**: бот сам находит `*_pickaxe` в хотбаре, если указанный слот занят другим предметом
   (нашёл `stone_pickaxe` во 2-м слоте). Владелец выдал кирку с Бульдозером — она в слоте 2.
10. **`collect` (CollectBlocksTask)** — лучший результат: **42 блока за 116 с**,
    `status=COMPLETED`, `reason=NO_REACHABLE_BLOCKS`. Навигацию и удары делает SF, мы не мешаем.
11. **Верификация варпа**: точка `61,86,2` вне кубоида, старая проверка считала варп неудачным.
    Теперь принимаем «на варпе» ИЛИ «в кубоиде».

---

## 7. Текущее состояние

- Сборка: `npm run typecheck` чистый, `npm test` — **50/50**.
- Плагин собран и задеплоен, `doctor` видит все ключи, включая `pickaxe-slot` и `test-mode`.
- Рабочий цикл: `collect` (одна анархия за запуск). Автоматической ротации, шалкеров,
  отгрузки и supervisor ещё **нет**.
- Контроллер **не задеплоен** на VDS (Dockerfile и compose есть, команда пока `help`).

## 8. Что дальше (приоритет)

1. Прогнать `collect` на свежих шахтах с `--radius 32..48`, `--max 120..200` — найти потолок захода.
2. Ротация: диспетчер → `collect` → следующая анархия (сейчас выбор цели есть в `mines`/`policy`,
   но не связано с запуском).
3. Инвентарь: lock (1 алмаз/золото в слот), фасовка в шалкер (ПКМ в воздухе), восстановление лока.
4. База: `/an302` → `/clan home` → воронки (нужны координаты воронок от точки хома) → назад.
5. Починка: бутылки из сундука на базе (кирка в off-hand, бутылки в руку, смотреть вниз).
6. Supervisor: watchdog, реконнект, запуск без ручного `npm run dev`, деплой в `/opt/automain`.

## 9. Грабли, которые нельзя забыть

- Перед запуском контроллера **закрыть клиент SoulFire** (иначе lease занят).
- `/an` только трёхзначные группы; проверка есть, не отключать.
- Не смешивать `goTo` и `setMovement` в одном движении — это и вызывало «бег по кругу».
- `renew()` без аргумента = 30 с.
- Шахта в `minecraft:lobby`, не overworld.
- `gradlew` из Windows-чекаута ломается на Linux (CRLF) → `.gitattributes` уже добавлен,
  при проблемах `sed -i 's/\r$//' gradlew` в каталоге сборки на VDS.
- Плагин собран против 2.10.1, работает на 2.10.7; при обновлении SF пересобирать.
