import type {
  ZenAccount,
  ZenTag,
  ZenTransaction,
  ZenInstrument,
  ZenReminder,
  ZenReminderMarker,
  ZenUser,
  ZenDiffResponse,
} from '../types/zenmoney';

/** Full local snapshot of the ZenMoney entities this app cares about. */
export interface ZenData {
  accounts: ZenAccount[];
  tags: ZenTag[];
  transactions: ZenTransaction[];
  instruments: ZenInstrument[];
  reminders: ZenReminder[];
  reminderMarkers: ZenReminderMarker[];
  serverTimestamp: number;
  user: ZenUser | null;
}

export interface ZenDataDiff {
  accounts?: ZenAccount[];
  tags?: ZenTag[];
  transactions?: ZenTransaction[];
  instruments?: ZenInstrument[];
  reminders?: ZenReminder[];
  reminderMarkers?: ZenReminderMarker[];
  user?: ZenUser;
  serverTimestamp: number;
}

/** Entities just pushed to ZenMoney, to be folded back into the local snapshot. */
export type ZenLocalChanges = Pick<
  ZenDataDiff,
  'accounts' | 'tags' | 'transactions' | 'reminders'
>;

export function toZenDataDiff(diff: ZenDiffResponse): ZenDataDiff {
  return {
    accounts: diff.account,
    tags: diff.tag,
    transactions: diff.transaction,
    instruments: diff.instrument,
    reminders: diff.reminder,
    reminderMarkers: diff.reminderMarker,
    user: diff.user?.[0],
    serverTimestamp: diff.serverTimestamp,
  };
}

/** Merges an incremental diff into a snapshot. Id-keyed, so repeated syncs are idempotent. */
export function mergeZenData(existing: ZenData | null, diff: ZenDataDiff): ZenData {
  const base: ZenData = existing ?? {
    accounts: [],
    tags: [],
    transactions: [],
    instruments: [],
    reminders: [],
    reminderMarkers: [],
    serverTimestamp: 0,
    user: null,
  };

  function mergeArray<T extends { id: string | number }>(
    existing: T[] | null | undefined,
    incoming: T[] | null | undefined
  ): T[] {
    const base = existing ?? [];
    if (!incoming) return base;
    const map = new Map(base.map((item) => [item.id, item]));
    for (const item of incoming) {
      map.set(item.id, item);
    }
    return Array.from(map.values());
  }

  return {
    accounts: mergeArray(base.accounts, diff.accounts),
    tags: mergeArray(base.tags, diff.tags),
    transactions: mergeArray(base.transactions, diff.transactions),
    instruments: mergeArray(base.instruments, diff.instruments),
    reminders: mergeArray(base.reminders, diff.reminders),
    reminderMarkers: mergeArray(base.reminderMarkers, diff.reminderMarkers),
    serverTimestamp: diff.serverTimestamp,
    user: diff.user !== undefined ? diff.user : base.user,
  };
}

/**
 * Folds entities we just pushed into the snapshot, leaving `serverTimestamp`
 * alone.
 *
 * A push is not echoed back by the following incremental `diff` — the server
 * only returns entities whose `changed` is newer than the requested
 * `serverTimestamp`, and our own writes carry a client-generated `changed` that
 * can easily be older than that. Waiting for the next sync to reveal a save is
 * therefore unreliable; applying the pushed entities directly keeps the
 * snapshot (and every amount derived from it) in step with the server.
 */
export function applyLocalChanges(existing: ZenData, changes: ZenLocalChanges): ZenData {
  return mergeZenData(existing, { ...changes, serverTimestamp: existing.serverTimestamp });
}

/**
 * A `changed` stamp ZenMoney is guaranteed to accept.
 *
 * ZenMoney resolves conflicts by keeping the entity with the newest `changed`,
 * so a client clock running behind the server makes writes silently lose to the
 * stored copy. Staying ahead of both the last known server time and the
 * entity's current stamp avoids that, and also guarantees the entity shows up
 * in the next incremental diff.
 */
export function nextChangedTimestamp(
  serverTimestamp: number,
  previousChanged?: number | null
): number {
  const clientNow = Math.floor(Date.now() / 1000);
  return Math.max(clientNow, serverTimestamp + 1, (previousChanged ?? 0) + 1);
}
