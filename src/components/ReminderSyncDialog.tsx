import { useMemo, useState } from 'react';
import type { ZenAccount } from '../types/zenmoney';
import type { ReminderDefaults } from '../utils/storage';
import './ReminderSyncDialog.css';

export type ReminderPlanAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface ReminderPlan {
  categoryId: string;
  categoryTitle: string;
  action: ReminderPlanAction;
  /** Contribution the reminder should carry; null when it cannot be planned. */
  amount: number | null;
  /** 'once' covers an overdrawn goal with a single transfer instead of a standing one. */
  recurrence?: 'monthly' | 'once';
  /** Date the transfers stop, when the goal's target names one. */
  endDate?: string;
  /** What the reminder holds today, for the "update" case. */
  current: {
    dayOfMonth: number;
    amount: number;
    sourceTitle: string;
    /** Where it stops today — so a changed target date is visible in the row. */
    endDate: string | null;
  } | null;
  /** Why a goal is being skipped. */
  reason?: string;
}

/**
 * Creates or refreshes the funding reminder of many goals in one go, from a
 * shared source account and day. Each goal's amount still comes from its own
 * target — only the account and the day are shared.
 */
export function ReminderSyncDialog({
  plans,
  accounts,
  walletId,
  walletTitle,
  currency,
  defaults,
  onDefaultsChange,
  onApply,
  onClose,
  busy,
}: {
  plans: ReminderPlan[];
  accounts: ZenAccount[];
  walletId: string;
  walletTitle: string;
  currency: string;
  defaults: ReminderDefaults;
  onDefaultsChange: (next: ReminderDefaults) => void;
  onApply: (categoryIds: string[]) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const actionable = useMemo(
    () => plans.filter((p) => p.action === 'create' || p.action === 'update'),
    [plans]
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(actionable.map((p) => p.categoryId))
  );

  const sourceOptions = accounts.filter((a) => a.id !== walletId && !a.archive);
  const sourceMissing = !defaults.sourceAccountId;

  const toggle = (categoryId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  const chosen = actionable.filter((p) => selected.has(p.categoryId));

  const describe = (plan: ReminderPlan) => {
    if (plan.action === 'skip') return plan.reason ?? 'Nothing to plan';
    const amount = `${plan.amount?.toLocaleString()} ${currency}`;
    const until = (date?: string | null) => (date ? ` until ${date}` : ' with no end date');
    const target =
      plan.recurrence === 'once'
        ? `one-off ${amount} on day ${defaults.dayOfMonth}`
        : `${amount}/mo on day ${defaults.dayOfMonth}${until(plan.endDate)}`;
    if (plan.action === 'create') return `New — ${target}`;
    const from = plan.current;
    if (!from) return target;
    return `${from.amount.toLocaleString()} ${currency}/mo on day ${from.dayOfMonth}${until(from.endDate)} (${from.sourceTitle}) → ${target}`;
  };

  return (
    <div className="reminder-sync-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <div
        className="reminder-sync"
        role="dialog"
        aria-modal="true"
        aria-label="Sync goal reminders"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="reminder-sync-head">
          <h2>Recurring transfers</h2>
          <p>
            Each goal is funded by a monthly transfer into {walletTitle}. The amount comes from the
            goal's own target; the account and the day below apply to all of them.
          </p>
        </div>

        <div className="reminder-sync-defaults">
          <label className="reminder-sync-field">
            <span>Transfer from</span>
            <select
              value={defaults.sourceAccountId}
              onChange={(e) => onDefaultsChange({ ...defaults, sourceAccountId: e.target.value })}
              disabled={busy}
            >
              <option value="">Select…</option>
              {sourceOptions.map((a) => (
                <option key={a.id} value={a.id}>{a.title}</option>
              ))}
            </select>
          </label>
          <label className="reminder-sync-field">
            <span>Day of month</span>
            <input
              type="number"
              min="1"
              max="31"
              value={defaults.dayOfMonth}
              onChange={(e) =>
                onDefaultsChange({
                  ...defaults,
                  dayOfMonth: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)),
                })
              }
              disabled={busy}
            />
          </label>
        </div>

        {sourceMissing && (
          <p className="reminder-sync-warning">Pick the account the transfers come from.</p>
        )}

        <div className="reminder-sync-toolbar">
          <button
            type="button"
            onClick={() => setSelected(new Set(actionable.map((p) => p.categoryId)))}
            disabled={busy}
          >
            Select all
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={busy}>
            Select none
          </button>
          <span>
            {chosen.length} of {actionable.length} goal{actionable.length === 1 ? '' : 's'} selected
          </span>
        </div>

        <div className="reminder-sync-list">
          {plans.length === 0 && (
            <p className="reminder-sync-row skip">No goals to set a reminder up for.</p>
          )}
          {plans.map((plan) => (
            <label
              key={plan.categoryId}
              className={`reminder-sync-row${plan.action === 'skip' ? ' skip' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.has(plan.categoryId)}
                onChange={() => toggle(plan.categoryId)}
                disabled={busy || plan.action === 'skip' || plan.action === 'unchanged'}
              />
              <span className="reminder-sync-title">
                {plan.categoryTitle}
                <span className="reminder-sync-detail">{describe(plan)}</span>
              </span>
              <span className={`reminder-sync-action ${plan.action}`}>{plan.action}</span>
            </label>
          ))}
        </div>

        <div className="reminder-sync-foot">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || sourceMissing || chosen.length === 0}
            onClick={() => onApply(chosen.map((p) => p.categoryId))}
          >
            {busy ? 'Applying…' : `Apply to ${chosen.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
