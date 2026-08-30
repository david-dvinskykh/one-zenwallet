import type {
  Goal,
  GoalFeedItem,
  ZenAccount,
  ZenReminder,
  ZenReminderMarker,
  ZenTransaction,
} from '../types/zenmoney';
import { reminderDayOfMonth } from './goalMath';
import { getDataAccount, parseGoalRemindersFromReminders } from './hiddenData';

// A goal's monthly reminder: either a transfer from another account into the
// tracked wallet, or a plain income posting on the wallet itself.
export interface GoalReminderConfig {
  type: 'transfer' | 'income';
  sourceAccountId: string;
  dayOfMonth: number;
  amount: number;
  /** Defaults to 'monthly'. 'once' is a single transfer that does not repeat. */
  recurrence?: 'monthly' | 'once';
  /** Date the reminder should stop at; ignored when it is before the first run. */
  endDate?: string | null;
}

/**
 * `startDate`/`endDate` for a config. A one-off runs on a single day, so both
 * ends are that day; a repeating one keeps the target date when it names one.
 * An end before the first run is dropped — it would leave a reminder with no
 * occurrences at all.
 */
export function reminderDates(
  config: GoalReminderConfig,
  today?: Date
): { startDate: string; endDate: string | null } {
  const startDate = computeReminderStartDate(config.dayOfMonth, today);
  if (config.recurrence === 'once') return { startDate, endDate: startDate };
  const endDate = config.endDate && config.endDate >= startDate ? config.endDate : null;
  return { startDate, endDate };
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

/**
 * The comment a goal's funding transfer carries.
 *
 * A transfer reminder cannot hold a category, so without this it is anonymous
 * in ZenMoney — several goals funded from the same card look identical. The
 * comment is also what `computeGoals` matches an incoming transfer on, so the
 * transactions these reminders produce land on the right goal by themselves.
 */
export function goalReminderComment(categoryTitle: string): string | null {
  const title = categoryTitle.trim();
  return title.length > 0 ? title : null;
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
  const reuseIds = params.reuseIds ?? [];
  // A reminder with no interval runs once; a dated one stops at its endDate.
  const once = reminder.interval === null;
  const horizon = once ? 1 : params.count ?? REMINDER_MARKER_HORIZON;

  const dates: string[] = [];
  for (let index = 0; index < horizon; index += 1) {
    const date = once ? reminder.startDate : addMonthsClamped(reminder.startDate, index);
    if (reminder.endDate && date > reminder.endDate) break;
    dates.push(date);
  }

  return dates.map((date, index) => ({
    id: reuseIds[index] ?? crypto.randomUUID(),
    reminder: reminder.id,
    date,
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

/**
 * The occurrences to push for a reminder, cancellations included.
 *
 * `buildReminderMarkers` writes only as many occurrences as the reminder still
 * has, so pulling an end date forward would leave the surplus behind — planned
 * occurrences past the new end date, still carrying the old amount, which
 * ZenMoney goes on scheduling. Those are returned with `state: 'deleted'` so a
 * single push both rewrites the occurrences that remain and cancels the rest.
 */
export function syncReminderMarkers(params: {
  reminder: ZenReminder;
  now: number;
  /** Every marker in the snapshot; the reminder's own planned ones are picked out. */
  markers: ZenReminderMarker[];
  count?: number;
}): ZenReminderMarker[] {
  const { reminder, now, markers } = params;
  const planned = plannedMarkersFor(markers, reminder.id);
  const next = buildReminderMarkers({
    reminder,
    now,
    count: params.count,
    reuseIds: planned.map((m) => m.id),
  });
  const cancelled = planned
    .slice(next.length)
    .map((marker) => ({ ...marker, state: 'deleted' as const, changed: now }));
  return [...next, ...cancelled];
}

/**
 * Whether a reminder already holds exactly what `config` describes — the test
 * the bulk sync uses to leave a goal alone.
 *
 * The dates are compared against what `reminderDates` would actually write
 * rather than against the raw config: an end date earlier than the first run is
 * dropped when the reminder is built, and comparing the raw one would leave the
 * goal reported as out of date for ever, however often it is synced.
 */
export function reminderMatchesConfig(params: {
  reminder: ZenReminder;
  config: GoalReminderConfig;
  /** The wallet the funding transfer has to land in. */
  walletId: string;
  /** Expected comment; omit to leave it out of the comparison. */
  comment?: string | null;
  today?: Date;
}): boolean {
  const { reminder, config, walletId } = params;
  const isTransfer = config.type === 'transfer';
  const once = config.recurrence === 'once';
  const dates = reminderDates(config, params.today);

  return (
    reminder.income === config.amount &&
    reminderDayOfMonth(reminder) === config.dayOfMonth &&
    reminder.incomeAccount === walletId &&
    reminder.outcomeAccount === (isTransfer ? config.sourceAccountId : walletId) &&
    (reminder.interval === null) === once &&
    (reminder.endDate ?? null) === dates.endDate &&
    // A one-off that has already run has to be moved to its next date; a
    // repeating one keeps whatever start it was given.
    (!once || reminder.startDate === dates.startDate) &&
    (params.comment === undefined || reminder.comment === params.comment)
  );
}

export function buildGoalReminder(params: {
  categoryId: string;
  /** Names the goal in the reminder's comment — see `goalReminderComment`. */
  categoryTitle?: string;
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
  const once = config.recurrence === 'once';
  const dates = reminderDates(config, params.today);

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
    comment: params.categoryTitle ? goalReminderComment(params.categoryTitle) : null,
    payee: null,
    interval: once ? null : 'month',
    step: once ? null : 1,
    // The recurrence day travels in startDate. ZenMoney overwrites `points` with
    // [0] for a monthly reminder, so sending the day here would only make the
    // local copy disagree with what the server actually stored.
    points: once ? null : [0],
    startDate: dates.startDate,
    endDate: dates.endDate,
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
  /** Rewrites the comment to name the goal. Omit to leave the comment alone. */
  categoryTitle?: string;
}

export function applyGoalReminderConfig(
  reminder: ZenReminder,
  config: GoalReminderConfig,
  target: GoalReminderTarget,
  now: number = Math.floor(Date.now() / 1000),
  today?: Date
): ZenReminder {
  const isTransfer = config.type === 'transfer';
  const { walletId, walletInstrument, sourceInstrument, categoryTitle } = target;
  assertTransferSource(config, walletId);
  const once = config.recurrence === 'once';
  const dates = reminderDates(config, today);
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
    comment: categoryTitle ? goalReminderComment(categoryTitle) : reminder.comment,
    // See buildGoalReminder — startDate carries the day, ZenMoney zeroes points.
    interval: once ? null : 'month',
    step: once ? null : 1,
    points: once ? null : [0],
    startDate: dates.startDate,
    endDate: dates.endDate,
    changed: now,
  };
}
