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
import { pushZenmoneyDiff } from '../api/zenmoney';
import type { Goal, GoalFeedItem, GoalTarget, ZenAccount, ZenReminder, ZenTransaction } from '../types/zenmoney';
import './GoalsPage.css';

interface GoalReminderConfig {
  type: 'transfer' | 'income';
  sourceAccountId: string;
  dayOfMonth: number;
  amount: number;
}

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

  const goalReminderMap = useMemo(() => {
    if (!data) return new Map<string, ZenReminder>();
    const dataAccountId = getDataAccount(data.accounts)?.id;
    const map = new Map<string, ZenReminder>();
    for (const r of data.reminders) {
      if (r.deleted) continue;
      if (dataAccountId && (r.incomeAccount === dataAccountId || r.outcomeAccount === dataAccountId)) continue;
      if (r.interval !== 'month') continue;
      if (!r.tag?.length) continue;
      for (const tagId of r.tag) {
        map.set(tagId, r);
      }
    }
    return map;
  }, [data]);

  const handleCreateReminder = async (categoryId: string, config: GoalReminderConfig) => {
    if (!token || !data || !selectedWalletId) return;
    const walletAccount = data.accounts.find((a) => a.id === selectedWalletId);
    if (!walletAccount) return;
    const sourceAccount = config.type === 'transfer'
      ? data.accounts.find((a) => a.id === config.sourceAccountId)
      : walletAccount;
    if (!sourceAccount) return;

    const now = Math.floor(Date.now() / 1000);
    const today = new Date();
    let startMonth = today.getMonth() + 1;
    let startYear = today.getFullYear();
    if (today.getDate() >= config.dayOfMonth) {
      startMonth++;
      if (startMonth > 12) { startMonth = 1; startYear++; }
    }
    const startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(config.dayOfMonth).padStart(2, '0')}`;

    const newReminder: ZenReminder = {
      id: crypto.randomUUID(),
      incomeAccount: selectedWalletId,
      outcomeAccount: config.type === 'transfer' ? config.sourceAccountId : selectedWalletId,
      income: config.amount,
      incomeInstrument: walletAccount.instrument,
      outcome: config.type === 'transfer' ? config.amount : 0,
      outcomeInstrument: sourceAccount.instrument,
      tag: [categoryId],
      merchant: null,
      comment: null,
      payee: null,
      interval: 'month',
      step: 1,
      points: [config.dayOfMonth],
      startDate,
      endDate: null,
      notify: true,
      changed: now,
      user: data.user?.id ?? 0,
    };

    const existing = goalReminderMap.get(categoryId);
    const reminderPatch = existing
      ? [{ ...existing, deleted: true, changed: now }, newReminder]
      : [newReminder];
    await pushZenmoneyDiff(token, data.serverTimestamp, { reminder: reminderPatch });
    await refresh();
  };

  const handleDeleteReminder = async (reminderId: string) => {
    if (!token || !data) return;
    const now = Math.floor(Date.now() / 1000);
    const reminder = data.reminders.find((r) => r.id === reminderId);
    if (!reminder) return;
    await pushZenmoneyDiff(token, data.serverTimestamp, {
      reminder: [{ ...reminder, deleted: true, changed: now }],
    });
    await refresh();
  };

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
        const abs = Math.abs(item.amount);
        const amountLocale = abs.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const amountRaw = abs.toFixed(2);
        return (
            item.goalTitle?.toLowerCase().includes(query) ||
            item.comment?.toLowerCase().includes(query) ||
            item.date.includes(query) ||
            amountLocale.includes(query) ||
            amountRaw.includes(query)
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

  const tagMap = useMemo(
      () => new Map((data?.tags ?? []).map((t) => [t.id, t])),
      [data?.tags]
  );

  const goalTags = useMemo(
      () => goals.map((g) => ({id: g.categoryId, title: g.categoryTitle, parent: tagMap.get(g.categoryId)?.parent ?? null})),
      [goals, tagMap]
  );

  const sortedGoalOptions = useMemo(() => buildHierarchicalOptions(goalTags), [goalTags]);

  const availableTagsForGoal = useMemo(() => {
    const goalIds = new Set(goals.map((g) => g.categoryId));
    return (data?.tags ?? []).filter((t) => !goalIds.has(t.id));
  }, [goals, data?.tags]);

  const sortedAvailableTagOptions = useMemo(() => buildHierarchicalOptions(availableTagsForGoal), [availableTagsForGoal]);

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

      const emptyPinnedIds = goals
        .filter((g) => g.transactions.length === 0 && pinnedGoalCategories.includes(g.categoryId))
        .map((g) => g.categoryId);
      if (emptyPinnedIds.length > 0) {
        const updated = pinnedGoalCategories.filter((id) => !emptyPinnedIds.includes(id));
        setPinnedGoalCategoriesState(updated);
        setPinnedGoalCategories(updated);
      }

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
                  accounts={data.accounts}
                  selectedWalletId={selectedWalletId}
                  monthStartDay={monthStartDay}
                  existingReminder={goalReminderMap.get(goal.categoryId) ?? null}
                  onCreateReminder={handleCreateReminder}
                  onDeleteReminder={handleDeleteReminder}
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
                  {sortedAvailableTagOptions.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
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
              {sortedGoalOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
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
              {sortedGoalOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
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
                        tags={sortedGoalOptions}
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
  tags: Array<{ id: string; label: string }>;
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

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'SELECT' || target.tagName === 'OPTION' || target.tagName === 'INPUT') return;
    onToggleSelect(item.transactionId);
  };

  return (
    <div
      id={`feed-row-${item.transactionId}`}
      className={`goal-feed-row${selected ? ' selected' : ''}${item.source === 'unassigned' ? ' unassigned' : ''}${highlighted ? ' highlight' : ''}`}
      onClick={handleRowClick}
    >
      <input
        type="checkbox"
        className="feed-row-checkbox"
        checked={selected}
        onChange={() => onToggleSelect(item.transactionId)}
      />
      <div className="goal-feed-main">
        <div className="goal-feed-meta">
          <span className="goal-feed-date">📅 {item.date}</span>
          <span className={`goal-feed-source source-${item.source}`}>{item.source}</span>
        </div>

        <div className="goal-feed-goal">
          {item.goalTitle ? (
            <span className="goal-feed-goal-title">🎯 {item.goalTitle}</span>
          ) : (
            <span className="goal-feed-goal-missing">🎯 not assigned</span>
          )}
        </div>

        {item.payee && <div className="goal-feed-payee">{item.isTransfer ? '🏦' : '🏪'} {item.payee}</div>}
        {item.comment && <div className="goal-feed-comment">💬 {item.comment}</div>}
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
                  {tag.label}
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
                  {tag.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function buildHierarchicalOptions(
  tags: Array<{ id: string; title: string; parent?: string | null }>
): Array<{ id: string; label: string }> {
  const tagIds = new Set(tags.map((t) => t.id));
  const byParent = new Map<string | null, typeof tags>();
  for (const tag of tags) {
    const key = tag.parent && tagIds.has(tag.parent) ? tag.parent : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(tag);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  const result: Array<{ id: string; label: string }> = [];
  function walk(parentId: string | null, depth: number) {
    for (const tag of byParent.get(parentId) ?? []) {
      result.push({ id: tag.id, label: ' '.repeat(depth * 3) + tag.title });
      walk(tag.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

function computeMonthlyNeeded(
  currentAmount: number,
  target: GoalTarget,
  periodStart: string
): number | null {
  const type = target.type ?? 'one_time';

  if (type === 'fixed_monthly') {
    return target.amount > 0 ? target.amount : null;
  }

  if (type === 'recurring') {
    const targetDate = target.date ?? '';
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
    const remaining = target.amount - currentAmount;
    if (remaining <= 0) return 0;
    return remaining / monthsLeft;
  }

  // one_time
  const targetDate = target.date ?? '';
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

  const remaining = target.amount - currentAmount;
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
  accounts,
  selectedWalletId,
  monthStartDay,
  existingReminder,
  onCreateReminder,
  onDeleteReminder,
}: {
  goal: Goal;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
  target: GoalTarget | null;
  onTargetChange: (categoryId: string, target: GoalTarget | null) => void;
  currentPeriodStart: string;
  onTransactionClick?: (transactionId: string) => void;
  accounts: ZenAccount[];
  selectedWalletId: string;
  monthStartDay: number;
  existingReminder: ZenReminder | null;
  onCreateReminder: (categoryId: string, config: GoalReminderConfig) => Promise<void>;
  onDeleteReminder: (reminderId: string) => Promise<void>;
}) {
  const [reminderType, setReminderType] = useState<'transfer' | 'income'>('transfer');
  const [reminderSourceId, setReminderSourceId] = useState('');
  const [reminderDay, setReminderDay] = useState(monthStartDay || 1);
  const [reminderAmount, setReminderAmount] = useState(0);
  const [reminderLoading, setReminderLoading] = useState(false);

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

  const targetType = target?.type ?? 'one_time';

  const monthlyNeeded = target ? computeMonthlyNeeded(goal.amount, target, currentPeriodStart) : null;

  const thisMonthAdded = goal.transactions
    .filter((tx) => tx.amount > 0 && tx.date >= currentPeriodStart)
    .reduce((sum, tx) => sum + tx.amount, 0);

  const leftAmount = target && targetType === 'one_time' ? Math.max(0, target.amount - goal.amount) : null;

  const updateTarget = (patch: Partial<GoalTarget>) => {
    const base = target ?? { type: 'one_time' as const, amount: 0 };
    onTargetChange(goal.categoryId, { ...base, ...patch });
  };

  const handleTypeChange = (type: string) => {
    const t = type as GoalTarget['type'];
    onTargetChange(goal.categoryId, { ...(target ?? { amount: 0 }), type: t });
  };

  const handleAmountChange = (raw: string) => {
    const amount = parseFloat(raw);
    if (!raw.trim() || isNaN(amount)) {
      if (!target?.date && !target?.repeatEvery) { onTargetChange(goal.categoryId, null); return; }
      updateTarget({ amount: 0 });
    } else {
      updateTarget({ amount });
    }
  };

  const handleDateChange = (date: string) => {
    if (!date && !target?.amount) { onTargetChange(goal.categoryId, null); return; }
    updateTarget({ date: date || undefined });
  };

  const handleRepeatEveryChange = (raw: string) => {
    const n = parseInt(raw, 10);
    updateTarget({ repeatEvery: isNaN(n) || n <= 0 ? undefined : n });
  };

  const handleRepeatUnitChange = (unit: string) => {
    updateTarget({ repeatUnit: unit as 'days' | 'months' });
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
            <div className="goal-target-type-row">
              {(['one_time', 'recurring', 'fixed_monthly'] as const).map((t) => (
                <button
                  key={t}
                  className={`goal-target-type-btn${targetType === t ? ' active' : ''}`}
                  onClick={() => handleTypeChange(t)}
                >
                  {t === 'one_time' ? 'Save by date' : t === 'recurring' ? 'Recurring' : 'Fixed monthly'}
                </button>
              ))}
            </div>
            <div className="goal-target-row">
              <label className="goal-target-field">
                <span className="goal-target-label">
                  {targetType === 'fixed_monthly' ? 'Amount/mo' : 'Amount'}
                </span>
                <input
                  type="number"
                  className="goal-target-input"
                  placeholder="0"
                  value={target?.amount || ''}
                  onChange={(e) => handleAmountChange(e.target.value)}
                />
              </label>
              {targetType === 'one_time' && (
                <label className="goal-target-field">
                  <span className="goal-target-label">By date</span>
                  <input
                    type="date"
                    className="goal-target-input"
                    value={target?.date ?? ''}
                    onChange={(e) => handleDateChange(e.target.value)}
                  />
                </label>
              )}
              {targetType === 'recurring' && (
                <>
                  <label className="goal-target-field">
                    <span className="goal-target-label">Every</span>
                    <input
                      type="number"
                      className="goal-target-input goal-target-input-sm"
                      placeholder="1"
                      min="1"
                      value={target?.repeatEvery ?? ''}
                      onChange={(e) => handleRepeatEveryChange(e.target.value)}
                    />
                  </label>
                  <label className="goal-target-field">
                    <span className="goal-target-label">Unit</span>
                    <select
                      className="goal-target-input"
                      value={target?.repeatUnit ?? 'months'}
                      onChange={(e) => handleRepeatUnitChange(e.target.value)}
                    >
                      <option value="months">months</option>
                      <option value="days">days</option>
                    </select>
                  </label>
                  <label className="goal-target-field">
                    <span className="goal-target-label">Next due</span>
                    <input
                      type="date"
                      className="goal-target-input"
                      value={target?.date ?? ''}
                      onChange={(e) => handleDateChange(e.target.value)}
                    />
                  </label>
                </>
              )}
              {monthlyNeeded !== null && (
                <div className="goal-monthly-needed">
                  {monthlyNeeded === 0
                    ? 'Target reached!'
                    : `~${monthlyNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}/mo`}
                </div>
              )}
              {monthlyNeeded === null && targetType === 'one_time' && target?.date && (
                <div className="goal-monthly-needed goal-monthly-past">Target date passed</div>
              )}
            </div>
          </div>

          <div className="goal-reminder-section">
            <div className="goal-reminder-header">
              <span>📋 Monthly reminder</span>
              {existingReminder && (
                <span className="goal-reminder-badge">
                  Day {existingReminder.points?.[0] ?? '?'} · {existingReminder.income.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo
                </span>
              )}
            </div>
            {existingReminder ? (
              <div className="goal-reminder-existing">
                <span>
                  {existingReminder.incomeAccount === existingReminder.outcomeAccount ? '➕ Income' : '🔄 Transfer'}
                  {' '}on day {existingReminder.points?.[0]} — {existingReminder.income.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo
                </span>
                <button
                  className="btn-text goal-reminder-delete"
                  disabled={reminderLoading}
                  onClick={async () => {
                    setReminderLoading(true);
                    try { await onDeleteReminder(existingReminder.id); } finally { setReminderLoading(false); }
                  }}
                >
                  {reminderLoading ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            ) : (
              <div className="goal-reminder-form">
                <div className="goal-reminder-row">
                  <label className="goal-target-field">
                    <span className="goal-target-label">Type</span>
                    <select
                      className="goal-target-input"
                      value={reminderType}
                      onChange={(e) => setReminderType(e.target.value as 'transfer' | 'income')}
                    >
                      <option value="transfer">Transfer</option>
                      <option value="income">Income</option>
                    </select>
                  </label>
                  {reminderType === 'transfer' && (
                    <label className="goal-target-field">
                      <span className="goal-target-label">From account</span>
                      <select
                        className="goal-target-input"
                        value={reminderSourceId}
                        onChange={(e) => setReminderSourceId(e.target.value)}
                      >
                        <option value="">Select…</option>
                        {accounts.filter((a) => a.id !== selectedWalletId && !a.archive).map((a) => (
                          <option key={a.id} value={a.id}>{a.title}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="goal-target-field">
                    <span className="goal-target-label">Day</span>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      className="goal-target-input goal-target-input-sm"
                      value={reminderDay}
                      onChange={(e) => setReminderDay(parseInt(e.target.value, 10) || 1)}
                    />
                  </label>
                  <label className="goal-target-field">
                    <span className="goal-target-label">Amount</span>
                    <input
                      type="number"
                      className="goal-target-input"
                      placeholder={String(Math.ceil(Math.max(0, reminderAmount || 0)))}
                      value={reminderAmount || ''}
                      onChange={(e) => setReminderAmount(parseFloat(e.target.value) || 0)}
                    />
                  </label>
                  <button
                    className="btn-text"
                    disabled={reminderLoading || reminderAmount <= 0 || (reminderType === 'transfer' && !reminderSourceId)}
                    onClick={async () => {
                      setReminderLoading(true);
                      try {
                        await onCreateReminder(goal.categoryId, {
                          type: reminderType,
                          sourceAccountId: reminderSourceId,
                          dayOfMonth: reminderDay,
                          amount: reminderAmount,
                        });
                      } finally { setReminderLoading(false); }
                    }}
                  >
                    {reminderLoading ? 'Creating…' : 'Create reminder'}
                  </button>
                </div>
              </div>
            )}
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
