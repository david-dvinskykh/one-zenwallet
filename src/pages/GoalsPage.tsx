import { useState, useMemo, useEffect } from 'react';
import { useApp } from '../store/AppContext';
import { computeGoals } from '../utils/goals';
import {
  clearSelectedWallet,
  setManualGoalAssignment,
  getPinnedGoalCategories,
  setPinnedGoalCategories,
} from '../utils/storage';
import {
  getDataAccount,
  parseManualAssignmentsFromReminders,
  parseGoalTargetsFromReminders,
} from '../utils/hiddenData';
import { syncHiddenDataToZenmoney } from '../utils/hiddenDataSync';
import type { Goal, GoalFeedItem, GoalTarget, ZenTransaction } from '../types/zenmoney';
import './GoalsPage.css';

interface BulkSuggestion {
  tagId: string;
  reminderMarker: string;
  affectedTransactionIds: string[];
}

export function GoalsPage() {
  const {token, data, selectedWalletId, selectWallet, logout, loading, refresh} =
      useApp();
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'positive' | 'negative'>('all');
  const [feedSearch, setFeedSearch] = useState('');
  const [feedGoalFilter, setFeedGoalFilter] = useState('');
  const [bulkSuggestion, setBulkSuggestion] = useState<BulkSuggestion | null>(null);
  const [manualAssignments, setManualAssignments] = useState<Record<string, string>>({});
  const [goalTargets, setGoalTargets] = useState<Record<string, GoalTarget>>({});
  const [pendingCategoryChanges, setPendingCategoryChanges] = useState<Record<string, string | null>>({});
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [batchTagId, setBatchTagId] = useState('');
  const [pinnedGoalCategories, setPinnedGoalCategoriesState] = useState<string[]>(() => getPinnedGoalCategories());
  const [showAddGoalPicker, setShowAddGoalPicker] = useState(false);
  const [addGoalTagId, setAddGoalTagId] = useState('');
  const [highlightedTransactionId, setHighlightedTransactionId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedAccount = useMemo(
      () => data?.accounts.find((a) => a.id === selectedWalletId),
      [data, selectedWalletId]
  );

  const instrumentMap = useMemo(
      () => new Map(data?.instruments.map((i) => [i.id, i]) ?? []),
      [data]
  );

  const transactionMap = useMemo(
      () => new Map(data?.transactions.map((t) => [t.id, t]) ?? []),
      [data]
  );

  const monthStartDay = data?.user?.monthStartDay ?? 1;

  useEffect(() => {
    if (!data) return;
    const dataAccount = getDataAccount(data.accounts);
    const accountId = dataAccount?.id ?? null;
    setManualAssignments(parseManualAssignmentsFromReminders(data.reminders, accountId));
    setGoalTargets(parseGoalTargetsFromReminders(data.reminders, accountId));
  }, [data]);

  const goalData = useMemo(() => {
    if (!data || !selectedWalletId) return {goals: [], feed: []};
    return computeGoals(data.transactions, data.tags, data.accounts, selectedWalletId, {
      reminders: data.reminders,
      manualAssignments,
      pinnedCategoryIds: pinnedGoalCategories,
    });
  }, [data, selectedWalletId, manualAssignments, pinnedGoalCategories]);

  const goals = goalData.goals;
  const feed = goalData.feed;

  const filteredFeed = useMemo(() => {
    let result = feed;
    if (feedGoalFilter === '__unassigned__') {
      result = result.filter((item) => item.goalId === null);
    } else if (feedGoalFilter) {
      result = result.filter((item) => item.goalId === feedGoalFilter);
    }
    if (feedSearch.trim()) {
      const query = feedSearch.trim().toLowerCase();
      result = result.filter((item) => {
        const amountStr = Math.abs(item.amount).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        return (
            item.goalTitle?.toLowerCase().includes(query) ||
            item.comment?.toLowerCase().includes(query) ||
            amountStr.includes(query)
        );
      });
    }
    return result;
  }, [feed, feedGoalFilter, feedSearch]);

  const filteredGoals = useMemo(() => {
    if (filter === 'positive') return goals.filter((g) => g.amount > 0);
    if (filter === 'negative') return goals.filter((g) => g.amount < 0);
    return goals;
  }, [goals, filter]);

  const totalAmount = useMemo(
      () => filteredGoals.reduce((sum, g) => sum + g.amount, 0),
      [filteredGoals]
  );

  const goalTags = useMemo(
      () => goals.map((g) => ({id: g.categoryId, title: g.categoryTitle})),
      [goals]
  );

  const availableTagsForGoal = useMemo(() => {
    const goalIds = new Set(goals.map((g) => g.categoryId));
    return (data?.tags ?? []).filter((t) => !goalIds.has(t.id));
  }, [goals, data?.tags]);

  const unassignedCount = useMemo(
      () => feed.filter((i) => i.goalId === null).length,
      [feed]
  );

  const handleTransactionClick = (transactionId: string) => {
    setFeedGoalFilter('');
    setHighlightedTransactionId(transactionId);
    setTimeout(() => {
      document.getElementById(`feed-row-${transactionId}`)?.scrollIntoView({behavior: 'smooth', block: 'center'});
    }, 50);
    setTimeout(() => setHighlightedTransactionId(null), 1800);
  };

  const handleAddGoalCategory = (tagId: string) => {
    if (!tagId) return;
    const updated = [...pinnedGoalCategories, tagId];
    setPinnedGoalCategoriesState(updated);
    setPinnedGoalCategories(updated);
    setShowAddGoalPicker(false);
    setAddGoalTagId('');
  };

  const currentPeriodStart = useMemo(() => {
    const today = new Date();
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
  }, [monthStartDay]);

  const thisMonthAddings = useMemo(
      () => feed
          .filter((item) => item.amount > 0 && item.date >= currentPeriodStart)
          .reduce((sum, item) => sum + item.amount, 0),
      [feed, currentPeriodStart]
  );

  const selectableItems = filteredFeed;

  const allFilteredSelected =
      selectableItems.length > 0 &&
      selectableItems.every((item) => selectedTransactionIds.has(item.transactionId));

  if (!data || !selectedWalletId) return null;

  const currency =
      instrumentMap.get(selectedAccount?.instrument ?? 0)?.symbol ?? '';

  const formatAmount = (n: number) =>
      `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })} ${currency}`;

  const handleChangeWallet = () => {
    clearSelectedWallet();
    selectWallet('');
  };

  const handleManualGoalChange = (transactionId: string, tagId: string) => {
    const nextTagId = tagId || null;
    setManualGoalAssignment(transactionId, nextTagId);
    setManualAssignments((prev) => {
      const next = {...prev};
      if (nextTagId) {
        next[transactionId] = nextTagId;
      } else {
        delete next[transactionId];
      }
      return next;
    });
    setSaveState('idle');
    setSaveError(null);
    setBulkSuggestion(null);

    if (nextTagId) {
      const tx = transactionMap.get(transactionId);
      if (tx?.reminderMarker) {
        const marker = tx.reminderMarker;
        const affectedTransactionIds = feed
            .filter((item) => {
              if (item.transactionId === transactionId) return false;
              if (item.goalId !== null) return false;
              if (manualAssignments[item.transactionId]) return false;
              return transactionMap.get(item.transactionId)?.reminderMarker === marker;
            })
            .map((item) => item.transactionId);

        if (affectedTransactionIds.length > 0) {
          setBulkSuggestion({tagId: nextTagId, reminderMarker: marker, affectedTransactionIds});
        }
      }
    }
  };

  const handleBulkApply = () => {
    if (!bulkSuggestion) return;
    setManualAssignments((prev) => {
      const next = {...prev};
      for (const txId of bulkSuggestion.affectedTransactionIds) {
        next[txId] = bulkSuggestion.tagId;
        setManualGoalAssignment(txId, bulkSuggestion.tagId);
      }
      return next;
    });
    setSaveState('idle');
    setBulkSuggestion(null);
  };

  const handleToggleSelect = (transactionId: string) => {
    setSelectedTransactionIds((prev) => {
      const next = new Set(prev);
      if (next.has(transactionId)) {
        next.delete(transactionId);
      } else {
        next.add(transactionId);
      }
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedTransactionIds(new Set());
    } else {
      setSelectedTransactionIds(new Set(selectableItems.map((item) => item.transactionId)));
    }
  };

  const applyTagToTransactions = (transactionIds: string[], tagId: string) => {
    const nextTagId = tagId === '__clear__' ? null : (tagId || null);

    const transferIds: string[] = [];
    const regularIds: string[] = [];
    for (const txId of transactionIds) {
      const tx = transactionMap.get(txId);
      const isTransfer = tx != null && tx.outcomeAccount !== tx.incomeAccount && tx.income > 0 && tx.outcome > 0;
      if (isTransfer) transferIds.push(txId);
      else regularIds.push(txId);
    }

    if (transferIds.length > 0) {
      setManualAssignments((prev) => {
        const next = {...prev};
        for (const txId of transferIds) {
          if (nextTagId) {
            next[txId] = nextTagId;
            setManualGoalAssignment(txId, nextTagId);
          } else {
            delete next[txId];
            setManualGoalAssignment(txId, null);
          }
        }
        return next;
      });
    }

    if (regularIds.length > 0) {
      setPendingCategoryChanges((prev) => {
        const next = {...prev};
        for (const txId of regularIds) {
          const original = transactionMap.get(txId);
          const originalTagId = original?.tag?.[0] ?? null;
          if (nextTagId === originalTagId) {
            delete next[txId];
          } else {
            next[txId] = nextTagId;
          }
        }
        return next;
      });
    }

    setSaveState('idle');
    setBulkSuggestion(null);
  };

  const handleApplyToSelected = () => {
    if (!batchTagId || selectedTransactionIds.size === 0) return;
    applyTagToTransactions(Array.from(selectedTransactionIds), batchTagId);
    setSelectedTransactionIds(new Set());
  };

  const handleApplyToAllFiltered = () => {
    if (!batchTagId || selectableItems.length === 0) return;
    applyTagToTransactions(selectableItems.map((item) => item.transactionId), batchTagId);
    setSelectedTransactionIds(new Set());
  };

  const handleGoalTargetChange = (categoryId: string, target: GoalTarget | null) => {
    setGoalTargets((prev) => {
      const next = {...prev};
      if (target) {
        next[categoryId] = target;
      } else {
        delete next[categoryId];
      }
      return next;
    });
    setSaveState('idle');
  };

  const handleCategoryChange = (transactionId: string, tagId: string) => {
    const nextTagId = tagId || null;
    const original = transactionMap.get(transactionId);
    const originalTagId = original?.tag?.[0] ?? null;
    setPendingCategoryChanges((prev) => {
      const next = {...prev};
      if (nextTagId === originalTagId) {
        delete next[transactionId];
      } else {
        next[transactionId] = nextTagId;
      }
      return next;
    });
    setSaveState('idle');
  };

  const handleSaveToSystemAccount = async () => {
    if (!token) return;

    setSaveState('saving');
    setSaveError(null);
    try {
      const now = Math.floor(Date.now() / 1000);
      const transactionUpdates = Object.entries(pendingCategoryChanges)
          .map(([txId, tagId]) => {
            const original = transactionMap.get(txId);
            if (!original) return null;
            return {...original, tag: tagId ? [tagId] : null, changed: now} as ZenTransaction;
          })
          .filter((t): t is ZenTransaction => t !== null);

      await syncHiddenDataToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        assignments: manualAssignments,
        targets: goalTargets,
        transactionUpdates: transactionUpdates.length > 0 ? transactionUpdates : undefined,
      });
      await refresh();
      setPendingCategoryChanges({});
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : 'Failed to save data');
    }
  };

  return (
      <div className="goals-page">
        <header className="goals-header">
          <div className="goals-header-top">
            <div>
              <h1>Goals</h1>
              <p className="goals-wallet-name">{selectedAccount?.title}</p>
            </div>
            <div className="goals-header-actions">
              <button
                  className="btn-icon"
                  onClick={refresh}
                  disabled={loading || saveState === 'saving'}
                  title="Refresh"
              >
                🔄
              </button>
              <button
                  className="btn-text"
                  onClick={handleSaveToSystemAccount}
                  disabled={loading || saveState === 'saving'}
                  title="Save to [One-Zenwallet Data]"
              >
                {saveState === 'saving' ? 'Saving...' : 'Save Data'}
              </button>
              <button className="btn-text" onClick={handleChangeWallet}>
                Change Wallet
              </button>
              <button className="btn-text" onClick={logout}>
                Logout
              </button>
            </div>
          </div>
          {saveState === 'saved' && (
              <p className="save-banner save-ok">Saved to [One-Zenwallet Data]</p>
          )}
          {saveState === 'error' && (
              <p className="save-banner save-error">
                Failed to save to [One-Zenwallet Data]: {saveError}
              </p>
          )}
          <div className="goals-summary">
            <div className="goals-summary-total">
              <span className="label">Net Total</span>
              <span className={`amount ${totalAmount >= 0 ? 'positive' : 'negative'}`}>
              {formatAmount(totalAmount)}
            </span>
            </div>
            <div className="goals-summary-total">
              <span className="label">This month</span>
              <span className="amount positive">
              {formatAmount(thisMonthAddings)}
            </span>
            </div>
            <div className="goals-filters">
              <button
                  className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
                  onClick={() => setFilter('all')}
              >
                All ({goals.length})
              </button>
              <button
                  className={`filter-btn ${filter === 'positive' ? 'active' : ''}`}
                  onClick={() => setFilter('positive')}
              >
                Funded
              </button>
              <button
                  className={`filter-btn ${filter === 'negative' ? 'active' : ''}`}
                  onClick={() => setFilter('negative')}
              >
                Overspent
              </button>
            </div>
          </div>
        </header>

        {loading && <div className="goals-loading">Updating...</div>}

        <div className="goals-list">
          {filteredGoals.length === 0 && (
              <div className="goals-empty">
                No goals found for this wallet. Transactions with categories will
                appear here.
              </div>
          )}
          {filteredGoals.map((goal) => (
              <GoalCard
                  key={goal.categoryId}
                  goal={goal}
                  currency={currency}
                  expanded={expandedGoalId === goal.categoryId}
                  onToggle={() =>
                      setExpandedGoalId(
                          expandedGoalId === goal.categoryId ? null : goal.categoryId
                      )
                  }
                  target={goalTargets[goal.categoryId] ?? null}
                  onTargetChange={handleGoalTargetChange}
                  currentPeriodStart={currentPeriodStart}
                  onTransactionClick={handleTransactionClick}
              />
          ))}
        </div>

        <div className="goals-add-goal">
          {showAddGoalPicker ? (
              <div className="add-goal-picker">
                <select
                    className="add-goal-select"
                    value={addGoalTagId}
                    onChange={(e) => setAddGoalTagId(e.target.value)}
                >
                  <option value="">Select category…</option>
                  {availableTagsForGoal.map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
                <button className="btn-text" onClick={() => handleAddGoalCategory(addGoalTagId)}
                        disabled={!addGoalTagId}>
                  Add
                </button>
                <button className="btn-text" onClick={() => {
                  setShowAddGoalPicker(false);
                  setAddGoalTagId('');
                }}>
                  Cancel
                </button>
              </div>
          ) : (
              <button
                  className="btn-text add-goal-btn"
                  onClick={() => setShowAddGoalPicker(true)}
                  disabled={availableTagsForGoal.length === 0}
              >
                + Add goal category
              </button>
          )}
        </div>

        <section className="goal-feed-section">
          <h2>All Wallet Transactions</h2>
          <p className="goal-feed-subtitle">
            If goal is not detected automatically, set it manually.
          </p>

          {bulkSuggestion && (
              <div className="bulk-suggestion">
            <span>
              {bulkSuggestion.affectedTransactionIds.length} other unassigned transaction
              {bulkSuggestion.affectedTransactionIds.length !== 1 ? 's' : ''} share the same reminder — apply the same goal?
            </span>
                <div className="bulk-suggestion-actions">
                  <button className="btn-text" onClick={handleBulkApply}>Apply to all</button>
                  <button className="btn-text" onClick={() => setBulkSuggestion(null)}>Skip</button>
                </div>
              </div>
          )}

          <div className="feed-filters">
            <input
                className="feed-search"
                type="text"
                placeholder="Search by category, amount, comment…"
                value={feedSearch}
                onChange={(e) => setFeedSearch(e.target.value)}
            />
            <select
                className="feed-goal-select"
                value={feedGoalFilter}
                onChange={(e) => setFeedGoalFilter(e.target.value)}
            >
              <option value="">All goals</option>
              <option value="__unassigned__">Not assigned</option>
              {goals.map((g) => (
                  <option key={g.categoryId} value={g.categoryId}>
                    {g.categoryTitle}
                  </option>
              ))}
            </select>
            <button
                className={`filter-btn ${feedGoalFilter === '__unassigned__' ? 'active' : ''}`}
                onClick={() => setFeedGoalFilter(feedGoalFilter === '__unassigned__' ? '' : '__unassigned__')}
            >
              Unassigned ({unassignedCount})
            </button>
            {(feedSearch || feedGoalFilter) && (
                <button
                    className="feed-clear-btn"
                    onClick={() => {
                      setFeedSearch('');
                      setFeedGoalFilter('');
                    }}
                >
                  Clear
                </button>
            )}
          </div>

          <div className="batch-toolbar">
            <label className="batch-select-all">
              <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={handleToggleSelectAll}
                  disabled={filteredFeed.length === 0}
              />
              <span>
              {selectedTransactionIds.size > 0
                  ? `${selectedTransactionIds.size} selected`
                  : 'Select all'}
            </span>
            </label>
            <select
                className="batch-goal-select"
                value={batchTagId}
                onChange={(e) => setBatchTagId(e.target.value)}
            >
              <option value="">Pick goal…</option>
              <option value="__clear__">— Clear goal —</option>
              {goals.map((g) => (
                  <option key={g.categoryId} value={g.categoryId}>
                    {g.categoryTitle}
                  </option>
              ))}
            </select>
            <button
                className="btn-text"
                onClick={handleApplyToSelected}
                disabled={!batchTagId || selectedTransactionIds.size === 0}
            >
              Apply to {selectedTransactionIds.size} selected
            </button>
            <button
                className="btn-text"
                onClick={handleApplyToAllFiltered}
                disabled={!batchTagId || selectableItems.length === 0}
            >
              Apply to all {selectableItems.length} transfers
            </button>
          </div>

          <div className="goal-feed-list">
            {filteredFeed
                .slice()
                .reverse()
                .map((item) => (
                    <GoalFeedRow
                        key={item.id}
                        item={item}
                        tags={goalTags}
                        currency={currency}
                        manualTagId={manualAssignments[item.transactionId] ?? ''}
                        onManualChange={handleManualGoalChange}
                        selected={selectedTransactionIds.has(item.transactionId)}
                        onToggleSelect={handleToggleSelect}
                        pendingCategoryTagId={pendingCategoryChanges[item.transactionId]}
                        onCategoryChange={handleCategoryChange}
                        highlighted={highlightedTransactionId === item.transactionId}
                    />
                ))}
            {filteredFeed.length === 0 && (
                <div className="goals-empty">
                  {feed.length === 0
                      ? 'No transactions for this wallet yet.'
                      : 'No transactions match the current filters.'}
                </div>
            )}
          </div>
        </section>
      </div>
  );
}

function GoalFeedRow({
  item,
  tags,
  currency,
  manualTagId,
  onManualChange,
  selected,
  onToggleSelect,
  pendingCategoryTagId,
  onCategoryChange,
  highlighted,
}: {
  item: GoalFeedItem;
  tags: Array<{ id: string; title: string }>;
  currency: string;
  manualTagId: string;
  onManualChange: (transactionId: string, tagId: string) => void;
  selected: boolean;
  onToggleSelect: (transactionId: string) => void;
  pendingCategoryTagId: string | null | undefined;
  onCategoryChange: (transactionId: string, tagId: string) => void;
  highlighted?: boolean;
}) {
  const formatAmount = (n: number) =>
    `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency}`;

  return (
    <div
      id={`feed-row-${item.transactionId}`}
      className={`goal-feed-row${selected ? ' selected' : ''}${item.source === 'unassigned' ? ' unassigned' : ''}${highlighted ? ' highlight' : ''}`}
    >
      {(
        <input
          type="checkbox"
          className="feed-row-checkbox"
          checked={selected}
          onChange={() => onToggleSelect(item.transactionId)}
        />
      )}
      <div className="goal-feed-main">
        <div className="goal-feed-meta">
          <span className="goal-feed-date">{item.date}</span>
          <span className={`goal-feed-source source-${item.source}`}>{item.source}</span>
        </div>

        <div className="goal-feed-goal">
          {item.goalTitle ? (
            <span className="goal-feed-goal-title">Goal: {item.goalTitle}</span>
          ) : (
            <span className="goal-feed-goal-missing">Goal: not assigned</span>
          )}
        </div>

        {item.comment && <div className="goal-feed-comment">{item.comment}</div>}
      </div>

      <div className="goal-feed-side">
        <span className={`goal-feed-amount ${item.amount >= 0 ? 'positive' : 'negative'}`}>
          {formatAmount(item.amount)}
        </span>
        {item.isTransfer && (
          <label className="goal-feed-select-wrap">
            <span>Set goal</span>
            <select
              className="goal-feed-select"
              value={item.goalId ?? manualTagId}
              onChange={(e) => onManualChange(item.transactionId, e.target.value)}
            >
              <option value="">Unassigned</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {!item.isTransfer && (
          <label className="goal-feed-select-wrap">
            <span>Category{pendingCategoryTagId !== undefined ? ' *' : ''}</span>
            <select
              className="goal-feed-select"
              value={pendingCategoryTagId !== undefined ? (pendingCategoryTagId ?? '') : (item.goalId ?? '')}
              onChange={(e) => onCategoryChange(item.transactionId, e.target.value)}
            >
              <option value="">No category</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function computeMonthlyNeeded(
  currentAmount: number,
  targetAmount: number,
  targetDate: string,
  periodStart: string
): number | null {
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
  if (monthsLeft <= 0) return null;

  const remaining = targetAmount - currentAmount;
  if (remaining <= 0) return 0;

  return remaining / monthsLeft;
}

function GoalCard({
  goal,
  currency,
  expanded,
  onToggle,
  target,
  onTargetChange,
  currentPeriodStart,
  onTransactionClick,
}: {
  goal: Goal;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
  target: GoalTarget | null;
  onTargetChange: (categoryId: string, target: GoalTarget | null) => void;
  currentPeriodStart: string;
  onTransactionClick?: (transactionId: string) => void;
}) {
  const formatAmount = (n: number) =>
    `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

  const typeLabel = (type: string) => {
    switch (type) {
      case 'spending': return '📉 Spending';
      case 'income': return '📈 Income';
      case 'transfer_in': return '💸 Transfer In';
      default: return type;
    }
  };

  const monthlyNeeded = target?.date
    ? computeMonthlyNeeded(goal.amount, target.amount, target.date, currentPeriodStart)
    : null;

  const thisMonthAdded = goal.transactions
    .filter((tx) => tx.amount > 0 && tx.date >= currentPeriodStart)
    .reduce((sum, tx) => sum + tx.amount, 0);

  const leftAmount = target ? Math.max(0, target.amount - goal.amount) : null;

  const handleAmountChange = (raw: string) => {
    const amount = parseFloat(raw);
    if (!raw.trim() || isNaN(amount)) {
      onTargetChange(goal.categoryId, target?.date ? { amount: 0, date: target.date } : null);
    } else {
      onTargetChange(goal.categoryId, { amount, date: target?.date ?? '' });
    }
  };

  const handleDateChange = (date: string) => {
    if (!date && !target?.amount) {
      onTargetChange(goal.categoryId, null);
    } else {
      onTargetChange(goal.categoryId, { amount: target?.amount ?? 0, date });
    }
  };

  return (
    <div className={`goal-card ${goal.amount >= 0 ? 'funded' : 'overspent'}`}>
      <button className="goal-header" onClick={onToggle}>
        <div className="goal-info">
          <span className="goal-title">{goal.categoryTitle}</span>
          <span className="goal-tx-count">
            {goal.transactions.length} transaction
            {goal.transactions.length !== 1 ? 's' : ''}
          </span>
          <div className="goal-period-stats">
            {thisMonthAdded > 0 && (
              <span className="goal-period-stat positive">
                +{thisMonthAdded.toLocaleString(undefined, { maximumFractionDigits: 0 })} this month
              </span>
            )}
            {leftAmount !== null && leftAmount > 0 && (
              <span className="goal-period-stat">
                {leftAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} left
              </span>
            )}
            {leftAmount === 0 && (
              <span className="goal-period-stat positive">target reached</span>
            )}
          </div>
        </div>
        <div className="goal-amount-wrap">
          {monthlyNeeded !== null && monthlyNeeded > 0 && (
            <span className="goal-monthly-badge">
              ~{monthlyNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
            </span>
          )}
          {monthlyNeeded === 0 && (
            <span className="goal-monthly-badge goal-monthly-reached">On track</span>
          )}
          <span className={`goal-amount ${goal.amount >= 0 ? 'positive' : 'negative'}`}>
            {formatAmount(goal.amount)}
          </span>
          <span className={`goal-chevron ${expanded ? 'open' : ''}`}>▾</span>
        </div>
      </button>
      {expanded && (
        <>
          <div className="goal-target-section">
            <div className="goal-target-row">
              <label className="goal-target-field">
                <span className="goal-target-label">Target</span>
                <input
                  type="number"
                  className="goal-target-input"
                  placeholder="0"
                  value={target?.amount || ''}
                  onChange={(e) => handleAmountChange(e.target.value)}
                />
              </label>
              <label className="goal-target-field">
                <span className="goal-target-label">By date</span>
                <input
                  type="date"
                  className="goal-target-input"
                  value={target?.date ?? ''}
                  onChange={(e) => handleDateChange(e.target.value)}
                />
              </label>
              {monthlyNeeded !== null && (
                <div className="goal-monthly-needed">
                  {monthlyNeeded === 0
                    ? 'Target reached!'
                    : `~${monthlyNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}/mo needed`}
                </div>
              )}
              {monthlyNeeded === null && target?.date && (
                <div className="goal-monthly-needed goal-monthly-past">Target date passed</div>
              )}
            </div>
          </div>
          <div className="goal-transactions">
            {goal.transactions
              .slice()
              .reverse()
              .map((tx) => (
                <div
                  key={tx.id}
                  className={`goal-tx${onTransactionClick ? ' goal-tx-clickable' : ''}`}
                  onClick={() => onTransactionClick?.(tx.id)}
                >
                  <div className="goal-tx-left">
                    <span className="goal-tx-type">{typeLabel(tx.type)}</span>
                    <span className="goal-tx-date">{tx.date}</span>
                    {tx.comment && (
                      <span className="goal-tx-comment">{tx.comment}</span>
                    )}
                  </div>
                  <span className={`goal-tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                    {formatAmount(tx.amount)}
                  </span>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
