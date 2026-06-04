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
```

No test suite exists yet.

## Architecture

Single-page React 19 + TypeScript PWA. No routing library — `App.tsx` renders one of three views based on global state: `LoginPage` → `WalletSelectPage` → `GoalsPage`.

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

### Backup/Restore (`src/utils/backupRestore.ts`)

`createZenBackupAndDownload` — fetches full diff and downloads as JSON. `restoreZenBackupFromFile` — re-uploads all entities with remapped UUIDs, handles debt account matching, and pushes in dependency order (merchant → tag → budget → account → reminder → transaction).

### PWA

`vite-plugin-pwa` with `autoUpdate` service worker. Base path is `/one-zenwallet/` (GitHub Pages). Manifest and SW are auto-generated.

## Key Conventions

- `ZenTag` = budget category in ZenMoney terminology; used interchangeably with "goal category" in this app.
- `ZenReminder` records on the hidden data account are repurposed as a key-value store (not actual reminders). Formats: `linkedAccounts` (account→tag map), `oneZenwalletManualGoals` (transaction→tag map), `oneZenwalletGoalTargets` (tag→GoalTarget), and `oneZenwalletGoalReminders` (goal tag→reminder id, display-only link for transfer reminders).
- ZenMoney does **not** allow categories/tags on transfer reminders (only income/expense). Real recurring transfer reminders are associated to a goal via the `oneZenwalletGoalReminders` map, not by tagging them.
- A transaction's `reminderMarker` field is a `ReminderMarker` entity id (one per occurrence), **not** a `Reminder` id. Resolve via the `reminderMarker` table's `reminder` field to get the parent reminder.
- `mergeData` in AppContext uses id-keyed Maps so repeated syncs are idempotent.
- Install with `--legacy-peer-deps` because vite-plugin-pwa peer dep declarations lag behind React 19.
