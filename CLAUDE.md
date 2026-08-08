# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install --legacy-peer-deps  # install (legacy flag required)
npm run dev                     # dev server
npm run build                   # tsc -b && vite build
npm run lint                    # eslint
npm run preview                 # preview dist
npm run deploy                  # build + push to gh-pages branch

npm run mcp:build               # bundle the MCP server (esbuild → mcp-server/dist/server.js)
npm run mcp:start               # run the MCP server over stdio
npm run mcp:test                # MCP end-to-end run against a fake ZenMoney API
```

The web app has no test suite; `npm run mcp:test` covers the MCP server's store logic.

## Architecture

Single-page React 19 + TypeScript PWA. No routing library — `App.tsx` renders one of three views based on global state: `LoginPage` → `WalletSelectPage` → `GoalsPage`.

Everything in `src/utils` and `src/api` is framework-free and shared with the MCP server (`mcp-server/`); only `src/pages`, `src/store` and `src/utils/storage.ts` are browser-specific.

### State (`src/store/AppContext.tsx`)

Single React context (`AppContext`) owns all async state: token, selectedWalletId, ZenMoney data, loading, error. Exposes `login`, `logout`, `selectWallet`, `refresh`. On mount it loads cached data from IndexedDB, then auto-fetches if token exists but data is empty. Incremental sync uses `serverTimestamp` (stored in localStorage) so only diffs are fetched.

### Storage (`src/utils/storage.ts`)

Two-tier persistence:
- **localStorage** — token, selected wallet id, server timestamp, manual goal assignments (small scalars)
- **IndexedDB** (`zenwallet` DB, `cache` store) — full ZenMoney snapshot (avoids quota limits)

### API (`src/api/zenmoney.ts`)

Thin wrapper over `POST https://api.zenmoney.ru/v8/diff`. Two exports:
- `fetchZenmoneyDiff(token, serverTimestamp)` — pull diff
- `pushZenmoneyDiff(token, serverTimestamp, patch)` — push entities back

### Goal Computation (`src/utils/goals.ts`)

Pure function `computeGoals(transactions, tags, accounts, selectedWalletId, options)` → `{ goals, feed }`. Transaction attribution priority:
1. Manual override (from `manualAssignments` map)
2. Native ZenMoney tags on the transaction
3. Incoming transfer matched by comment text containing a tag title
4. Incoming transfer matched via linked-account map (from ZenReminder metadata)
5. Unassigned (appears in feed only)

### Hidden Data / Cloud Sync (`src/utils/hiddenData.ts`, `src/utils/manualGoalsSync.ts`)

Manual goal assignments are persisted to ZenMoney itself via a synthetic archived account named `[One-Zenwallet Data]` and a `ZenReminder` record whose `comment` field stores JSON (`{ type: "oneZenwalletManualGoals", payload: {...} }`). This allows assignments to survive across devices without a backend.

### Shared Derived Logic (`src/utils/goalMath.ts`, `src/utils/goalReminders.ts`, `src/utils/zenData.ts`)

Framework-free helpers used by both `GoalsPage` and the MCP server: period start / monthly-need / goal progress math, goal↔reminder maps and reminder entity builders, and the id-keyed `mergeZenData` snapshot merge.

`zenData.ts` also owns the two rules that keep a push visible after it lands — see "Writing back to ZenMoney" below: `nextChangedTimestamp` (stamping) and `applyLocalChanges` (folding a push into the snapshot).

### Backup/Restore (`src/utils/backupRestore.ts`)

`createZenBackupSnapshot` / `restoreZenBackup` are environment-agnostic; `createZenBackupAndDownload` and `restoreZenBackupFromFile` are the browser wrappers (download link, `File` input). Restore re-uploads all entities with remapped UUIDs, handles debt account matching, and pushes in dependency order (merchant → tag → budget → account → reminder → transaction).

### MCP Server (`mcp-server/`)

Node stdio MCP server exposing the same operations as the UI (25 tools: session, wallets, goals, feed/assignment, reminders, backup). `mcp-server/src/store.ts` is the `AppContext` equivalent — cached snapshot plus locally staged changes flushed by `zen_save`. State lives in `~/.one-zenwallet-mcp` (`ONE_ZENWALLET_MCP_STATE_DIR`). Bundled with esbuild because it imports the app's extensionless TS modules directly. See `mcp-server/README.md`.

Two npx entry points, both running `mcp-server/dist/server.js`:
- `mcp-server/package.json` — the publishable `one-zenwallet-mcp` package (`npx one-zenwallet-mcp`); `prepack` rebuilds the bundle via the root, and only `dist/server.js` ships.
- The root package's `bin` + `prepare` — makes `npx github:<owner>/one-zenwallet` build and run the server from a git checkout. This is why `npm install` in the repo also runs `mcp:build`.

### PWA

`vite-plugin-pwa` with `autoUpdate` service worker. Base path is `/one-zenwallet/` (GitHub Pages). Manifest and SW are auto-generated. Pushing to `main` deploys via `.github/workflows/deploy.yml`; `npm run deploy` is the manual fallback.

`VersionBadge` (`src/components/`) pins the running build to the corner of every
page as `<package version>+<git short sha>`, injected by `vite.config.ts` into
`__APP_VERSION__` / `__BUILD_TIME__`. Its Update button calls `forceUpdateApp`
(`src/appVersion.ts`), which unregisters the service worker, drops every cache
and reloads with a cache-busting query. Reach for it first when a deployed fix
appears not to have landed — the version on screen says whether the user is even
running it. `src/appVersion.ts` sits outside `src/utils` on purpose: that
directory is compiled into the MCP server, which has neither the Vite globals
nor `window`.

### Reporting write failures

Reminder create/update/delete/link push straight to ZenMoney instead of going
through "Save Data", so they report themselves through `StatusDialog`
(`src/components/`) via `runZenWrite` in `GoalsPage`. It shows the API's own
message verbatim — a rejected entity used to leave nothing on screen at all.
Keep new direct-push actions on `runZenWrite` rather than adding silent
`return` guards; a guard that cannot explain itself reads as a save that worked.

### Writing back to ZenMoney

Two things are easy to get wrong when pushing entities, and both make a save look
like it silently did nothing:

- **Stamp `changed` with `nextChangedTimestamp(serverTimestamp, previous?)`, never
  raw `Date.now()`.** ZenMoney keeps whatever `changed` the client sent and
  resolves conflicts by keeping the newest one, so a device clock behind the
  server loses the write outright. The helper also keeps the stamp ahead of the
  last known `serverTimestamp`, which is what makes the entity appear in the next
  incremental diff.
- **Fold the pushed entities into the snapshot yourself.** The following `diff`
  only returns entities newer than the requested `serverTimestamp` — it is not a
  reliable echo of your own write. The web app calls `applyLocalChanges` from
  `AppContext` after `refresh()`; the MCP server does it inside `ZenStore.push` /
  `ZenStore.applyLocal`. Both `syncHiddenDataToZenmoney` and
  `syncGoalRemindersToZenmoney` return a `ZenLocalChanges` for this. Skipping it
  makes goal amounts snap back to their pre-save values, because `GoalsPage`
  re-parses manual assignments from `data.reminders` whenever `data` changes.

The MCP e2e fake (`mcp-server/test/store.e2e.ts`) models both behaviours — its
clock deliberately runs ahead of the client's — so regressions here fail the test.

## Key Conventions

- `ZenTag` = budget category in ZenMoney terminology; used interchangeably with "goal category" in this app.
- `ZenReminder` records on the hidden data account are repurposed as a key-value store (not actual reminders). Formats: `linkedAccounts` (account→tag map), `oneZenwalletManualGoals` (transaction→tag map), `oneZenwalletGoalTargets` (tag→GoalTarget), and `oneZenwalletGoalReminders` (goal tag→reminder id, display-only link for transfer reminders).
- ZenMoney does **not** allow categories/tags on transfer reminders (only income/expense) — it rejects the whole push with a 400, it does not quietly drop the tag. `buildGoalReminder` and `applyGoalReminderConfig` therefore force `tag: null` whenever the config is a transfer, and callers keep the goal association by writing the `oneZenwalletGoalReminders` map instead. Switching a reminder between income and transfer has to move the association between the tag and that map.
- A monthly reminder's recurrence day lives in `startDate`, **not** in `points`: ZenMoney derives the schedule from `startDate` and overwrites whatever `points` the client sent with `[0]` (a push of `points: [12]` comes back as `points: [0]`, `startDate` untouched). Build monthly reminders with `points: [0]` so the locally applied copy matches what the server stored, and read the day with `reminderDayOfMonth`, which prefers `startDate`.
- A transaction's `reminderMarker` field is a `ReminderMarker` entity id (one per occurrence), **not** a `Reminder` id. Resolve via the `reminderMarker` table's `reminder` field to get the parent reminder.
- `mergeZenData` (`src/utils/zenData.ts`) uses id-keyed Maps so repeated syncs are idempotent.
- Install with `--legacy-peer-deps` because vite-plugin-pwa peer dep declarations lag behind React 19.
