import type { Goal, GoalTarget, ZenReminder } from '../types/zenmoney';

// Start of the current budget period. ZenMoney lets the user shift the month
// boundary (`user.monthStartDay`), so "this month" may begin in the previous
// calendar month.
export function computeCurrentPeriodStart(monthStartDay: number, today: Date = new Date()): string {
  const day = today.getDate();
  let year = today.getFullYear();
  let month = today.getMonth();
  if (day < monthStartDay) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(monthStartDay).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Months from the current period to the target, inclusive of the current month.
// Returns null when dates are unusable or the window is empty.
export function monthsUntilTarget(targetDate: string, periodStart: string): number | null {
  if (!targetDate || !periodStart) return null;
  const tp = targetDate.split('-');
  const sp = periodStart.split('-');
  if (tp.length < 2 || sp.length < 2) return null;
  const startYear = parseInt(sp[0], 10);
  const startMonth = parseInt(sp[1], 10);
  const startDay = sp.length >= 3 ? parseInt(sp[2], 10) : 1;
  const targetDay = tp.length >= 3 ? parseInt(tp[2], 10) : 1;
  let adjTargetYear = parseInt(tp[0], 10);
  let adjTargetMonth = parseInt(tp[1], 10);
  if (targetDay < startDay) {
    adjTargetMonth -= 1;
    if (adjTargetMonth === 0) { adjTargetMonth = 12; adjTargetYear -= 1; }
  }
  const monthsLeft = (adjTargetYear - startYear) * 12 + (adjTargetMonth - startMonth) + 1;
  return monthsLeft > 0 ? monthsLeft : null;
}

// Per-month amount needed to reach the target.
// `excludeCurrentMonth` drops the current month from the window — use it with
// the full saved balance to get the amount required for each *future* month
// once the current month has already been funded.
export function computeMonthlyNeeded(
  saved: number,
  target: GoalTarget,
  periodStart: string,
  excludeCurrentMonth = false
): number | null {
  const type = target.type ?? 'one_time';

  if (type === 'fixed_monthly') {
    return target.amount > 0 ? target.amount : null;
  }

  // recurring and one_time share identical month math
  const monthsInclCurrent = monthsUntilTarget(target.date ?? '', periodStart);
  if (monthsInclCurrent === null) return null;
  const monthsLeft = excludeCurrentMonth ? monthsInclCurrent - 1 : monthsInclCurrent;
  if (monthsLeft <= 0) return null;

  const remaining = target.amount - saved;
  if (remaining <= 0) return 0;
  return remaining / monthsLeft;
}

// ZenMoney monthly reminders carry the recurrence day in startDate; `points` is
// only the day for reminders this app creates (externally-created ones may have
// points: [0]). Prefer a valid points day, else fall back to the startDate day.
export function reminderDayOfMonth(reminder: ZenReminder): number {
  const p = reminder.points?.[0];
  if (typeof p === 'number' && p >= 1 && p <= 31) return p;
  const sd = reminder.startDate?.split('-')[2];
  const d = sd ? parseInt(sd, 10) : NaN;
  return !isNaN(d) && d >= 1 && d <= 31 ? d : 1;
}

export interface GoalProgress {
  thisMonthAdded: number;
  savedBeforeThisMonth: number;
  monthlyNeeded: number | null;
  nextMonthNeeded: number | null;
  leftAmount: number | null;
  monthlyStatus: 'none' | 'partial' | 'met' | null;
}

export function computeGoalProgress(
  goal: Goal,
  target: GoalTarget | null,
  periodStart: string
): GoalProgress {
  const thisMonthAdded = goal.transactions
    .filter((tx) => tx.amount > 0 && tx.date >= periodStart)
    .reduce((sum, tx) => sum + tx.amount, 0);

  // Amount the current month *should* hold — based on what was saved before
  // this month, spread over the window that still includes this month.
  const savedBeforeThisMonth = goal.amount - thisMonthAdded;
  const monthlyNeeded = target
    ? computeMonthlyNeeded(savedBeforeThisMonth, target, periodStart)
    : null;

  // Amount required for each future month once this month is funded — full
  // saved balance spread over the remaining months, current month excluded.
  const nextMonthNeeded = target
    ? computeMonthlyNeeded(goal.amount, target, periodStart, true)
    : null;

  const leftAmount =
    monthlyNeeded !== null
      ? Math.max(0, monthlyNeeded - thisMonthAdded)
      : target
        ? Math.max(0, target.amount - goal.amount)
        : null;

  // Monthly contribution status: red = nothing added, yellow = partial, green = met/reached
  const monthlyStatus =
    monthlyNeeded === null
      ? null
      : monthlyNeeded === 0
        ? 'met'
        : thisMonthAdded <= 0
          ? 'none'
          : thisMonthAdded < monthlyNeeded
            ? 'partial'
            : 'met';

  return {
    thisMonthAdded,
    savedBeforeThisMonth,
    monthlyNeeded,
    nextMonthNeeded,
    leftAmount,
    monthlyStatus,
  };
}
