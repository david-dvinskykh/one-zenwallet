/**
 * End-to-end exercise of the MCP store against an in-memory fake ZenMoney API.
 * Run with `npm run mcp:test`.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZenStore } from '../src/store';
import {
  applyGoalReminderConfig,
  buildGoalReminder,
  buildReminderMarkers,
  plannedMarkersFor,
  REMINDER_MARKER_HORIZON,
} from '../../src/utils/goalReminders';
import { reminderDayOfMonth } from '../../src/utils/goalMath';

// Never touch a real developer's session state.
const stateDir = path.join(os.tmpdir(), `one-zenwallet-mcp-test-${process.pid}`);
process.env.ONE_ZENWALLET_MCP_STATE_DIR = stateDir;
delete process.env.ZENMONEY_TOKEN;

const USER = { id: 7, login: 'tester', monthStartDay: 1 };

const db: Record<string, Record<string, unknown>[]> = {
  instrument: [{ id: 1, title: 'Euro', shortTitle: 'EUR', symbol: '€', rate: 1 }],
  account: [
    { id: 'wallet-1', title: 'Savings', type: 'cash', instrument: 1, user: 7, archive: false, balance: 500 },
    { id: 'salary-1', title: 'Salary card', type: 'ccard', instrument: 1, user: 7, archive: false, balance: 1000 },
  ],
  tag: [
    { id: 'tag-car', title: 'Car', parent: null, user: 7, showIncome: true, showOutcome: true },
    { id: 'tag-trip', title: 'Trip', parent: null, user: 7, showIncome: true, showOutcome: true },
  ],
  transaction: [
    {
      id: 'tx-transfer', date: '2026-07-05', income: 200, incomeAccount: 'wallet-1', incomeInstrument: 1,
      outcome: 200, outcomeAccount: 'salary-1', outcomeInstrument: 1, tag: null, comment: null,
      merchant: null, payee: null, reminderMarker: 'marker-1', deleted: false, changed: 1, created: 1, user: 7,
    },
    {
      id: 'tx-transfer-2', date: '2026-06-05', income: 200, incomeAccount: 'wallet-1', incomeInstrument: 1,
      outcome: 200, outcomeAccount: 'salary-1', outcomeInstrument: 1, tag: null, comment: null,
      merchant: null, payee: null, reminderMarker: 'marker-2', deleted: false, changed: 1, created: 1, user: 7,
    },
    {
      id: 'tx-expense', date: '2026-07-10', income: 0, incomeAccount: 'wallet-1', incomeInstrument: 1,
      outcome: 40, outcomeAccount: 'wallet-1', outcomeInstrument: 1, tag: null, comment: 'tyres',
      merchant: null, payee: 'Shop', reminderMarker: null, deleted: false, changed: 1, created: 1, user: 7,
    },
  ],
  reminder: [
    {
      id: 'rem-1', incomeAccount: 'wallet-1', outcomeAccount: 'salary-1', income: 200, incomeInstrument: 1,
      outcome: 200, outcomeInstrument: 1, tag: null, merchant: null, comment: null, payee: null,
      interval: 'month', step: 1, points: [5], startDate: '2026-01-05', endDate: null, notify: true,
      changed: 1, user: 7,
    },
  ],
  reminderMarker: [
    { id: 'marker-1', reminder: 'rem-1' },
    { id: 'marker-2', reminder: 'rem-1' },
  ],
  user: [USER],
};

/**
 * The fake mirrors the two ZenMoney behaviours that make writes easy to lose:
 * a diff only returns entities whose `changed` is newer than the requested
 * `serverTimestamp`, and the server keeps whatever `changed` the client sent
 * rather than restamping it. Its clock is deliberately ahead of the client's —
 * as a real one easily is — so anything stamped with `Date.now()` would be
 * invisible to every later sync.
 */
const CLOCK_SKEW_SECONDS = 60;
const serverTimestamp = Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS;

globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const payload = JSON.parse(init.body) as Record<string, unknown>;
  const since = (payload.serverTimestamp as number) ?? 0;
  const forceFetch = (payload.forceFetch as string[] | undefined) ?? [];
  const entityKeys = Object.keys(payload).filter(
    (key) => !['currentClientTimestamp', 'serverTimestamp', 'forceFetch'].includes(key)
  );

  // ZenMoney allows a category only on income/expense reminders, and rejects the
  // whole request when a transfer carries one.
  for (const entity of (payload.reminder ?? []) as Record<string, unknown>[]) {
    const isTransfer = entity.incomeAccount !== entity.outcomeAccount;
    if (isTransfer && Array.isArray(entity.tag) && entity.tag.length > 0) {
      return {
        ok: false,
        status: 400,
        text: async () => 'tag is not allowed on a transfer reminder',
      };
    }
  }

  const pushed = new Set<string>();
  for (const key of entityKeys) {
    const table = (db[key] ??= []);
    for (const entity of payload[key] as Record<string, unknown>[]) {
      pushed.add(`${key}:${entity.id}`);
      // A monthly reminder takes its day from startDate; the server overwrites
      // whatever `points` the client sent.
      const stored =
        key === 'reminder' && entity.interval === 'month' ? { ...entity, points: [0] } : entity;
      const index = table.findIndex((existing) => existing.id === entity.id);
      if (index >= 0) table[index] = { ...table[index], ...stored };
      else table.push(stored);
    }
  }

  const response: Record<string, unknown> = { serverTimestamp };
  for (const [key, table] of Object.entries(db)) {
    const wantsAll = since <= 0 || forceFetch.includes(key);
    // Entities sent in this very request are never echoed back.
    const rows = table.filter(
      (entity) =>
        !pushed.has(`${key}:${entity.id}`) &&
        (wantsAll || (typeof entity.changed === 'number' && entity.changed > since))
    );
    if (rows.length > 0) response[key] = structuredClone(rows);
  }

  return { ok: true, json: async () => response };
}) as never;

const store = await ZenStore.load();

// --- session ---------------------------------------------------------------
await store.login('fake-token');
assert.equal(store.token, 'fake-token');
await store.selectWallet('wallet-1');
assert.equal(store.currencySymbol(), '€');

// --- attribution -----------------------------------------------------------
let view = store.computeGoalsView();
assert.equal(view.goals.length, 0, 'nothing is attributed yet');
assert.equal(view.feed.filter((item) => item.goalId === null).length, 3);

const suggestion = store.markerToReminderId();
assert.equal(suggestion.get('marker-1'), 'rem-1', 'markers resolve to their parent reminder');

const assigned = await store.assignTransactions(['tx-transfer', 'tx-expense', 'nope'], 'tag-car');
assert.deepEqual(assigned.transfers, ['tx-transfer'], 'transfers become app-side assignments');
assert.deepEqual(assigned.regular, ['tx-expense'], 'other transactions get their category changed');
assert.deepEqual(assigned.unknown, ['nope']);
assert.equal(store.hasPendingChanges(), true);

// Assignments apply straight away; category changes only after a save.
view = store.computeGoalsView();
assert.equal(view.goals.length, 1);
assert.equal(view.goals[0].amount, 200);

// --- targets, pinning, saving ---------------------------------------------
await store.setGoalTarget('tag-car', { type: 'one_time', amount: 1000, date: '2026-12-01' });
await store.pinGoalCategory('tag-trip');

const timestampBeforeSave = store.requireData().serverTimestamp;
const saved = await store.save();
assert.equal(saved.assignments, 1);
assert.equal(saved.targets, 1);
assert.equal(saved.transactionUpdates, 1);
assert.deepEqual(saved.unpinned, ['tag-trip'], 'an empty pinned goal is dropped after saving');
assert.equal(store.hasPendingChanges(), false);

const hiddenAccount = db.account.find((account) => account.title === '[One-Zenwallet Data]');
assert.ok(hiddenAccount, 'hidden data account is created on first save');
assert.equal(hiddenAccount.archive, true);
assert.deepEqual(store.cloudManualAssignments(), { 'tx-transfer': 'tag-car' });
assert.deepEqual(store.cloudGoalTargets(), {
  'tag-car': { type: 'one_time', amount: 1000, date: '2026-12-01' },
});
const savedExpense = db.transaction.find((tx) => tx.id === 'tx-expense')!;
assert.deepEqual(savedExpense.tag, ['tag-car'], 'the category change reached ZenMoney');
assert.ok(
  (savedExpense.changed as number) > timestampBeforeSave,
  'writes are stamped ahead of the last known server time, so the next diff returns them'
);

view = store.computeGoalsView();
const car = view.goals.find((goal) => goal.categoryId === 'tag-car')!;
assert.equal(car.amount, 160, '200 transferred in, 40 spent');
assert.equal(car.transactions.length, 2);

// --- reminders -------------------------------------------------------------
assert.deepEqual(store.goalReminderLinks(), {});
await store.syncGoalReminderLinks({ 'tag-car': 'rem-1' });
await store.sync();
assert.deepEqual(store.goalReminderLinks(), { 'tag-car': 'rem-1' });
assert.equal(
  store.goalReminderMap().get('tag-car')?.id,
  'rem-1',
  'a transfer reminder is linked through the hidden data map'
);

// --- a push shows up without waiting for a sync ----------------------------
const remOne = store.requireData().reminders.find((reminder) => reminder.id === 'rem-1')!;
await store.push({
  reminder: [{ ...remOne, comment: 'pushed', changed: store.nextChanged(remOne.changed) }],
});
assert.equal(
  store.requireData().reminders.find((reminder) => reminder.id === 'rem-1')?.comment,
  'pushed',
  'a push is folded into the snapshot straight away, not on the next sync'
);

// --- a recurring transfer reminder reaches ZenMoney ------------------------
const transferReminder = buildGoalReminder({
  categoryId: 'tag-trip',
  config: { type: 'transfer', sourceAccountId: 'salary-1', dayOfMonth: 5, amount: 250 },
  walletId: 'wallet-1',
  walletInstrument: 1,
  sourceInstrument: 1,
  userId: 7,
  now: store.nextChanged(),
});
assert.equal(transferReminder.tag, null, 'a transfer reminder carries no category');
assert.equal(transferReminder.startDate.slice(-2), '05', 'the day travels in startDate');
assert.deepEqual(transferReminder.points, [0], 'and not in points, which the server zeroes');

await assert.rejects(
  store.push({ reminder: [{ ...transferReminder, id: 'rem-rejected', tag: ['tag-trip'] }] }),
  /API error: 400/,
  'ZenMoney refuses a category on a transfer reminder, and the failure surfaces'
);

const markers = buildReminderMarkers({ reminder: transferReminder, now: store.nextChanged() });
assert.equal(markers.length, REMINDER_MARKER_HORIZON, 'a year of occurrences is generated ahead');
assert.equal(markers[0].date, transferReminder.startDate, 'the first occurrence is the start date');
assert.equal(markers[1].date, '2026-10-05', 'and the rest step a month at a time');
assert.ok(
  markers.every((m) => m.reminder === transferReminder.id && m.state === 'planned'),
  'every marker points at its reminder and is planned'
);
assert.equal(transferReminder.notify, false, 'a funding transfer does not notify');
assert.ok(markers.every((m) => m.notify === false), 'and neither do its occurrences');

await store.push({ reminder: [transferReminder], reminderMarker: markers });
assert.equal(
  db.reminderMarker.filter((m) => m.reminder === transferReminder.id).length,
  REMINDER_MARKER_HORIZON,
  'the occurrences reach ZenMoney — without them the reminder is stored but never scheduled'
);
assert.equal(
  store.markerToReminderId().get(markers[0].id),
  transferReminder.id,
  'and land in the snapshot straight away'
);
await store.syncGoalReminderLinks({ ...store.goalReminderLinks(), 'tag-trip': transferReminder.id });
await store.sync();
assert.ok(
  db.reminder.some((reminder) => reminder.id === transferReminder.id),
  'the recurring transfer was saved to ZenMoney'
);
assert.equal(
  store.goalReminderMap().get('tag-trip')?.id,
  transferReminder.id,
  'and the goal picks it up through the links map'
);
assert.deepEqual(
  db.reminder.find((reminder) => reminder.id === transferReminder.id)?.points,
  store.requireData().reminders.find((reminder) => reminder.id === transferReminder.id)?.points,
  'the locally applied copy matches what the server actually stored'
);
assert.equal(
  reminderDayOfMonth(store.requireData().reminders.find((r) => r.id === transferReminder.id)!),
  5,
  'the day still reads back correctly once points is zeroed'
);
assert.equal(transferReminder.outcomeAccount, 'salary-1', 'money leaves the funding account');
assert.equal(transferReminder.incomeAccount, 'wallet-1', 'and lands in the goal wallet');

// Editing a reminder that was linked rather than created here must still route
// the money into the goal wallet, whatever the original pointed at.
const strayReminder = { ...transferReminder, incomeAccount: 'salary-1', outcomeAccount: 'wallet-1' };
const rerouted = applyGoalReminderConfig(
  strayReminder,
  { type: 'transfer', sourceAccountId: 'salary-1', dayOfMonth: 9, amount: 300 },
  { walletId: 'wallet-1', walletInstrument: 1, sourceInstrument: 1 },
  store.nextChanged(strayReminder.changed)
);
assert.equal(rerouted.outcomeAccount, 'salary-1', 'an edit re-points the source account');
assert.equal(rerouted.incomeAccount, 'wallet-1', 'and the destination back to the goal wallet');

// An edit rewrites the existing occurrences instead of orphaning them.
const reusedIds = plannedMarkersFor(store.requireData().reminderMarkers, transferReminder.id).map(
  (m) => m.id
);
const rewritten = buildReminderMarkers({
  reminder: rerouted,
  now: store.nextChanged(),
  reuseIds: reusedIds,
});
assert.deepEqual(
  rewritten.map((m) => m.id),
  reusedIds,
  'the same marker ids are reused, so no duplicate occurrences pile up'
);
assert.ok(
  rewritten.every((m) => m.income === 300 && m.incomeAccount === 'wallet-1'),
  'and they carry the edited amount and destination'
);

assert.throws(
  () =>
    applyGoalReminderConfig(
      strayReminder,
      { type: 'transfer', sourceAccountId: 'wallet-1', dayOfMonth: 9, amount: 300 },
      { walletId: 'wallet-1', walletInstrument: 1, sourceInstrument: 1 }
    ),
  /other than the goal wallet/,
  'a wallet-to-itself "transfer" is refused rather than saved as income'
);

// --- clearing --------------------------------------------------------------
await store.assignTransactions(['tx-transfer'], null);
assert.equal(store.hasPendingChanges(), true);
await store.save();
assert.deepEqual(store.cloudManualAssignments(), {});

await fs.rm(stateDir, { recursive: true, force: true });

console.log('mcp-server e2e: all checks passed');
