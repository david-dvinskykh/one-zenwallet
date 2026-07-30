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
