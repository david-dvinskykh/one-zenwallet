import type { ZenAccount, ZenReminder, GoalTarget } from '../types/zenmoney';

export const ONE_ZENWALLET_DATA_ACCOUNT_NAME = '[One-Zenwallet Data]';
const MANUAL_GOALS_TYPE = 'oneZenwalletManualGoals';
const GOAL_TARGETS_TYPE = 'oneZenwalletGoalTargets';

export function isDataAccountTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return [ONE_ZENWALLET_DATA_ACCOUNT_NAME]
    .map((value) => value.toLowerCase())
    .includes(normalized);
}

export function getDataAccount(accounts: ZenAccount[]): ZenAccount | null {
  return accounts.find((acc) => acc.archive && isDataAccountTitle(acc.title)) ?? null;
}

export function parseManualAssignmentsFromReminders(
  reminders: ZenReminder[],
  dataAccountId: string | null
): Record<string, string> {
  if (!dataAccountId) return {};

  for (const reminder of reminders) {
    if (reminder.deleted) continue;
    if (
      reminder.incomeAccount !== dataAccountId ||
      reminder.outcomeAccount !== dataAccountId
    ) {
      continue;
    }

    const parsed = parseJson(reminder.comment);
    if (!parsed || typeof parsed !== 'object') continue;

    if (
      'type' in parsed &&
      parsed.type === MANUAL_GOALS_TYPE &&
      'payload' in parsed &&
      parsed.payload &&
      typeof parsed.payload === 'object'
    ) {
      return parsed.payload as Record<string, string>;
    }
  }

  return {};
}

export function findManualAssignmentsReminder(
  reminders: ZenReminder[],
  dataAccountId: string | null
): ZenReminder | null {
  if (!dataAccountId) return null;

  for (const reminder of reminders) {
    if (reminder.deleted) continue;
    if (
      reminder.incomeAccount !== dataAccountId ||
      reminder.outcomeAccount !== dataAccountId
    ) {
      continue;
    }

    const parsed = parseJson(reminder.comment);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      parsed.type === MANUAL_GOALS_TYPE
    ) {
      return reminder;
    }
  }

  return null;
}

export function buildManualAssignmentsComment(
  assignments: Record<string, string>
): string {
  return JSON.stringify({
    type: MANUAL_GOALS_TYPE,
    payload: assignments,
    updatedAt: new Date().toISOString(),
  });
}

export function parseGoalTargetsFromReminders(
  reminders: ZenReminder[],
  dataAccountId: string | null
): Record<string, GoalTarget> {
  if (!dataAccountId) return {};

  for (const reminder of reminders) {
    if (reminder.deleted) continue;
    if (
      reminder.incomeAccount !== dataAccountId ||
      reminder.outcomeAccount !== dataAccountId
    ) {
      continue;
    }

    const parsed = parseJson(reminder.comment);
    if (!parsed || typeof parsed !== 'object') continue;

    if (
      'type' in parsed &&
      parsed.type === GOAL_TARGETS_TYPE &&
      'payload' in parsed &&
      parsed.payload &&
      typeof parsed.payload === 'object'
    ) {
      return parsed.payload as Record<string, GoalTarget>;
    }
  }

  return {};
}

export function findGoalTargetsReminder(
  reminders: ZenReminder[],
  dataAccountId: string | null
): ZenReminder | null {
  if (!dataAccountId) return null;

  for (const reminder of reminders) {
    if (reminder.deleted) continue;
    if (
      reminder.incomeAccount !== dataAccountId ||
      reminder.outcomeAccount !== dataAccountId
    ) {
      continue;
    }

    const parsed = parseJson(reminder.comment);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      parsed.type === GOAL_TARGETS_TYPE
    ) {
      return reminder;
    }
  }

  return null;
}

export function buildGoalTargetsComment(
  targets: Record<string, GoalTarget>
): string {
  return JSON.stringify({
    type: GOAL_TARGETS_TYPE,
    payload: targets,
    updatedAt: new Date().toISOString(),
  });
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

