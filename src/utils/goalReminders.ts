import type {
  Goal,
  GoalFeedItem,
  ZenAccount,
  ZenReminder,
  ZenReminderMarker,
  ZenTransaction,
} from '../types/zenmoney';
import { getDataAccount, parseGoalRemindersFromReminders } from './hiddenData';

// A goal's monthly reminder: either a transfer from another account into the
// tracked wallet, or a plain income posting on the wallet itself.
export interface GoalReminderConfig {
  type: 'transfer' | 'income';
  sourceAccountId: string;
  dayOfMonth: number;
  amount: number;
}

// First occurrence of a monthly reminder: this month if the day is still ahead,
// otherwise next month.
export function computeReminderStartDate(dayOfMonth: number, today: Date = new Date()): string {
  let startMonth = today.getMonth() + 1;
  let startYear = today.getFullYear();
  if (today.getDate() >= dayOfMonth) {
    startMonth++;
    if (startMonth > 12) { startMonth = 1; startYear++; }
  }
  return `${startYear}-${String(startMonth).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
}

/**
 * A funding transfer has to come from somewhere other than the goal wallet —
 * with both sides equal ZenMoney stores it as plain income, and the goal stops
 * being funded from anywhere.
 */
export function assertTransferSource(config: GoalReminderConfig, walletId: string): void {
  if (config.type !== 'transfer') return;
  if (!config.sourceAccountId) {
    throw new Error('Pick the account the transfer comes from');
  }
  if (config.sourceAccountId === walletId) {
    throw new Error('A transfer must come from an account other than the goal wallet');
  }
}

/** Occurrences generated ahead — the start month plus a further year. */
export const REMINDER_MARKER_HORIZON = 13;

/** Same day of the month, `months` later, clamped to the month's length. */
function addMonthsClamped(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInMonth);
  return [
    String(targetYear),
    String(targetMonth + 1).padStart(2, '0'),
    String(targetDay).padStart(2, '0'),
  ].join('-');
}

/**
 * The scheduled occurrences of a monthly reminder.
 *
 * ZenMoney stores a reminder as the recurrence rule alone and does not expand
 * it — the client owns the markers. A reminder pushed on its own is accepted
 * with a 200 and then shows up nowhere, which is exactly what "the transfer was
 * not saved" looks like. Push these alongside it.
 */
export function buildReminderMarkers(params: {
  reminder: ZenReminder;
  now: number;
  count?: number;
  /** Ids of existing markers to rewrite in place, so an update does not orphan them. */
  reuseIds?: string[];
}): ZenReminderMarker[] {
  const { reminder, now } = params;
  const count = params.count ?? REMINDER_MARKER_HORIZON;
  const reuseIds = params.reuseIds ?? [];

  return Array.from({ length: count }, (_, index) => ({
    id: reuseIds[index] ?? crypto.randomUUID(),
    reminder: reminder.id,
    date: addMonthsClamped(reminder.startDate, index),
    state: 'planned' as const,
    isForecast: false,
    income: reminder.income,
    incomeAccount: reminder.incomeAccount,
    incomeInstrument: reminder.incomeInstrument,
    outcome: reminder.outcome,
    outcomeAccount: reminder.outcomeAccount,
    outcomeInstrument: reminder.outcomeInstrument,
    tag: reminder.tag,
    merchant: reminder.merchant,
    payee: reminder.payee,
    comment: reminder.comment,
    notify: reminder.notify,
    changed: now,
    user: reminder.user,
  }));
}

/** Planned markers already generated for a reminder, oldest first. */
export function plannedMarkersFor(
  markers: ZenReminderMarker[],
  reminderId: string
): ZenReminderMarker[] {
  return markers
    .filter((m) => m.reminder === reminderId && m.state === 'planned')
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

export function buildGoalReminder(params: {
  categoryId: string;
  config: GoalReminderConfig;
  walletId: string;
  walletInstrument: number;
  sourceInstrument: number;
  userId: number;
  now?: number;
  today?: Date;
  id?: string;
}): ZenReminder {
  const { categoryId, config, walletId, walletInstrument, sourceInstrument, userId } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const isTransfer = config.type === 'transfer';
  assertTransferSource(config, walletId);

  return {
    id: params.id ?? crypto.randomUUID(),
    incomeAccount: walletId,
    outcomeAccount: isTransfer ? config.sourceAccountId : walletId,
    income: config.amount,
    incomeInstrument: walletInstrument,
    outcome: isTransfer ? config.amount : 0,
    outcomeInstrument: sourceInstrument,
    // ZenMoney rejects a reminder that carries a tag on a transfer. Transfers
    // are associated to their goal through the `oneZenwalletGoalReminders` map
    // instead — see `buildGoalReminderMap`.
    tag: isTransfer ? null : [categoryId],
    merchant: null,
    comment: null,
    payee: null,
    interval: 'month',
    step: 1,
    // The recurrence day travels in startDate. ZenMoney overwrites `points` with
    // [0] for a monthly reminder, so sending the day here would only make the
    // local copy disagree with what the server actually stored.
    points: [0],
    startDate: computeReminderStartDate(config.dayOfMonth, params.today),
    endDate: null,
    // A goal's funding transfer is a planned move between the user's own
    // accounts, not something to be pinged about.
    notify: false,
    changed: now,
    user: userId,
  };
}

/**
 * Goal tag id -> the monthly reminder that funds it.
 *
 * Reminders on the hidden data account are excluded (they are a key-value store,
 * not real reminders). Tagged monthly reminders map directly; transfer reminders
 * — which ZenMoney does not allow to carry a tag — are resolved through the
 * `oneZenwalletGoalReminders` map instead.
 */
export function buildGoalReminderMap(
  reminders: ZenReminder[],
  accounts: ZenAccount[]
): Map<string, ZenReminder> {
  const dataAccountId = getDataAccount(accounts)?.id;
  const map = new Map<string, ZenReminder>();

  for (const r of reminders) {
    if (r.deleted) continue;
    if (dataAccountId && (r.incomeAccount === dataAccountId || r.outcomeAccount === dataAccountId)) continue;
    if (r.interval !== 'month') continue;
    if (!r.tag?.length) continue;
    for (const tagId of r.tag) {
      map.set(tagId, r);
    }
  }

  const goalReminders = parseGoalRemindersFromReminders(reminders, dataAccountId ?? null);
  for (const [tagId, reminderId] of Object.entries(goalReminders)) {
    if (map.has(tagId)) continue;
    const reminder = reminders.find((r) => r.id === reminderId && !r.deleted);
    if (reminder) map.set(tagId, reminder);
  }

  return map;
}

/**
 * transaction.reminderMarker references a ReminderMarker entity, not a Reminder.
 * This map resolves markerId -> parent reminderId.
 */
export function buildMarkerToReminderMap(markers: ZenReminderMarker[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of markers) {
    map.set(m.id, m.reminder);
  }
  return map;
}

/**
 * For goals with no linked reminder, guess one from the reminder that generated
 * most of the goal's transactions.
 */
export function buildSuggestedReminderMap(params: {
  goals: Goal[];
  reminders: ZenReminder[];
  transactionMap: Map<string, ZenTransaction>;
  markerToReminderId: Map<string, string>;
  goalReminderMap: Map<string, ZenReminder>;
  /** Reminders the user told the app to stop offering. */
  dismissedReminderIds?: Iterable<string>;
}): Map<string, ZenReminder> {
  const { goals, reminders, transactionMap, markerToReminderId, goalReminderMap } = params;
  const dismissed = new Set(params.dismissedReminderIds ?? []);
  const map = new Map<string, ZenReminder>();

  for (const goal of goals) {
    if (goalReminderMap.has(goal.categoryId)) continue;
    const reminderCounts = new Map<string, number>();
    for (const tx of goal.transactions) {
      const marker = transactionMap.get(tx.id)?.reminderMarker;
      if (!marker) continue;
      const reminderId = markerToReminderId.get(marker);
      if (!reminderId || dismissed.has(reminderId)) continue;
      reminderCounts.set(reminderId, (reminderCounts.get(reminderId) ?? 0) + 1);
    }
    if (!reminderCounts.size) continue;
    const topReminderId = [...reminderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const reminder = reminders.find((r) => r.id === topReminderId && !r.deleted);
    if (reminder) map.set(goal.categoryId, reminder);
  }

  return map;
}

/**
 * Other still-unassigned transactions generated by the same recurring reminder as
 * `transactionId` — the basis for the "apply to all occurrences" suggestion.
 * Each occurrence has a distinct marker, so matching is done on the resolved
 * parent reminder id.
 */
export function findSameReminderUnassignedTransactions(params: {
  transactionId: string;
  feed: GoalFeedItem[];
  transactionMap: Map<string, ZenTransaction>;
  markerToReminderId: Map<string, string>;
  manualAssignments: Record<string, string>;
}): { reminderMarker: string; reminderId: string; transactionIds: string[] } | null {
  const { transactionId, feed, transactionMap, markerToReminderId, manualAssignments } = params;

  const marker = transactionMap.get(transactionId)?.reminderMarker;
  if (!marker) return null;
  const reminderId = markerToReminderId.get(marker);
  if (!reminderId) return null;

  const transactionIds = feed
    .filter((item) => {
      if (item.transactionId === transactionId) return false;
      if (item.goalId !== null) return false;
      if (manualAssignments[item.transactionId]) return false;
      const m = transactionMap.get(item.transactionId)?.reminderMarker;
      return m ? markerToReminderId.get(m) === reminderId : false;
    })
    .map((item) => item.transactionId);

  return { reminderMarker: marker, reminderId, transactionIds };
}

export interface GoalReminderTarget {
  /** The wallet the goal is tracked in — a funding transfer must land here. */
  walletId: string;
  walletInstrument: number;
  /** Currency of `config.sourceAccountId`; null for a non-transfer. */
  sourceInstrument: number | null;
}

export function applyGoalReminderConfig(
  reminder: ZenReminder,
  config: GoalReminderConfig,
  target: GoalReminderTarget,
  now: number = Math.floor(Date.now() / 1000),
  today?: Date
): ZenReminder {
  const isTransfer = config.type === 'transfer';
  const { walletId, walletInstrument, sourceInstrument } = target;
  assertTransferSource(config, walletId);
  return {
    ...reminder,
    income: config.amount,
    outcome: isTransfer ? config.amount : 0,
    // A funding transfer always runs source account -> goal wallet. The income
    // side has to be set explicitly: a reminder that was linked rather than
    // created here starts out pointing at some other account, and leaving it
    // alone would keep sending the money there.
    incomeAccount: isTransfer ? walletId : reminder.incomeAccount,
    incomeInstrument: isTransfer ? walletInstrument : reminder.incomeInstrument,
    outcomeAccount: isTransfer ? config.sourceAccountId : reminder.incomeAccount,
    outcomeInstrument:
      isTransfer && sourceInstrument !== null ? sourceInstrument : reminder.incomeInstrument,
    // Turning a tagged income reminder into a transfer has to drop the tag —
    // ZenMoney rejects the push otherwise. Callers keep the goal association by
    // writing the `oneZenwalletGoalReminders` link instead.
    tag: isTransfer ? null : reminder.tag,
    // Cleared here too, so a reminder created before this default — or linked
    // from elsewhere — stops notifying once it is edited or bulk-synced.
    notify: false,
    // See buildGoalReminder — startDate carries the day, ZenMoney zeroes points.
    points: [0],
    startDate: computeReminderStartDate(config.dayOfMonth, today),
    changed: now,
  };
}
