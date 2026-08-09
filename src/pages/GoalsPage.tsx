import { useState, useMemo, useEffect, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { computeGoals, isTransferTransaction } from '../utils/goals';
import {
  clearSelectedWallet,
  setManualGoalAssignment,
  getPinnedGoalCategories,
  setPinnedGoalCategories,
  getDismissedReminderSuggestions,
  setDismissedReminderSuggestions,
  getReminderDefaults,
  setReminderDefaults,
  type ReminderDefaults,
} from '../utils/storage';
import {
  getDataAccount,
  parseManualAssignmentsFromReminders,
  parseGoalTargetsFromReminders,
  parseGoalRemindersFromReminders,
} from '../utils/hiddenData';
import { syncHiddenDataToZenmoney } from '../utils/hiddenDataSync';
import { syncGoalRemindersToZenmoney } from '../utils/goalRemindersSync';
import {
  computeCurrentPeriodStart,
  computeGoalProgress,
  plannedMonthlyContribution,
  reminderDayOfMonth,
} from '../utils/goalMath';
import {
  applyGoalReminderConfig,
  buildGoalReminder,
  buildGoalReminderMap,
  buildMarkerToReminderMap,
  buildReminderMarkers,
  buildSuggestedReminderMap,
  findSameReminderUnassignedTransactions,
  plannedMarkersFor,
  type GoalReminderConfig,
} from '../utils/goalReminders';
import { pushZenmoneyDiff } from '../api/zenmoney';
import { nextChangedTimestamp, type ZenLocalChanges } from '../utils/zenData';
import { StatusDialog, type WriteStatus } from '../components/StatusDialog';
import { ReminderSyncDialog, type ReminderPlan } from '../components/ReminderSyncDialog';
import type {
  Goal,
  GoalFeedItem,
  GoalTarget,
  ZenAccount,
  ZenReminder,
  ZenReminderMarker,
  ZenTransaction,
} from '../types/zenmoney';
import './GoalsPage.css';

interface BulkSuggestion {
  tagId: string;
  reminderMarker: string;
  affectedTransactionIds: string[];
}

export function GoalsPage() {
  const {token, data, selectedWalletId, selectWallet, logout, loading, refresh, applyLocalChanges} =
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
  const [dismissedSuggestions, setDismissedSuggestionsState] = useState<string[]>(
      () => getDismissedReminderSuggestions()
  );
  const [showAddGoalPicker, setShowAddGoalPicker] = useState(false);
  const [addGoalTagId, setAddGoalTagId] = useState('');
  const [highlightedTransactionId, setHighlightedTransactionId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [writeStatus, setWriteStatus] = useState<WriteStatus | null>(null);
  const [showReminderSync, setShowReminderSync] = useState(false);
  const [reminderDefaults, setReminderDefaultsState] = useState<ReminderDefaults>(
      () => getReminderDefaults()
  );

  // Stable, so the dialog's auto-dismiss timer is not restarted by every render.
  const closeWriteStatus = useCallback(() => setWriteStatus(null), []);

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

  const currentPeriodStart = useMemo(
      () => computeCurrentPeriodStart(monthStartDay),
      [monthStartDay]
  );

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
    return buildGoalReminderMap(data.reminders, data.accounts);
  }, [data]);

  const markerToReminderId = useMemo(
      () => buildMarkerToReminderMap(data?.reminderMarkers ?? []),
      [data]
  );

  const suggestedReminderMap = useMemo(() => {
    if (!data) return new Map<string, ZenReminder>();
    return buildSuggestedReminderMap({
      goals,
      reminders: data.reminders,
      transactionMap,
      markerToReminderId,
      goalReminderMap,
      dismissedReminderIds: dismissedSuggestions,
    });
  }, [data, goals, goalReminderMap, transactionMap, markerToReminderId, dismissedSuggestions]);

  const handleDismissSuggestion = (reminderId: string) => {
    setDismissedSuggestionsState((prev) => {
      if (prev.includes(reminderId)) return prev;
      const next = [...prev, reminderId];
      setDismissedReminderSuggestions(next);
      return next;
    });
  };

  const reminderPlans = useMemo<ReminderPlan[]>(() => {
    if (!data) return [];
    const accountTitleOf = (id: string) =>
        data.accounts.find((a) => a.id === id)?.title ?? 'unknown account';

    return goals.map((goal) => {
      const existing = goalReminderMap.get(goal.categoryId) ?? null;
      const current = existing
          ? {
              dayOfMonth: reminderDayOfMonth(existing),
              amount: existing.income,
              sourceTitle: accountTitleOf(existing.outcomeAccount),
            }
          : null;

      const amount = plannedMonthlyContribution(
          goal,
          goalTargets[goal.categoryId] ?? null,
          currentPeriodStart
      );
      if (amount === null) {
        return {
          categoryId: goal.categoryId,
          categoryTitle: goal.categoryTitle,
          action: 'skip' as const,
          amount: null,
          current,
          reason: goalTargets[goal.categoryId]
              ? 'Target already reached — nothing to transfer'
              : 'No target set, so there is no monthly amount to plan',
        };
      }

      const alreadyRight =
          existing != null &&
          existing.income === amount &&
          reminderDayOfMonth(existing) === reminderDefaults.dayOfMonth &&
          existing.outcomeAccount === reminderDefaults.sourceAccountId &&
          existing.incomeAccount === selectedWalletId;

      return {
        categoryId: goal.categoryId,
        categoryTitle: goal.categoryTitle,
        action: alreadyRight ? ('unchanged' as const) : existing ? ('update' as const) : ('create' as const),
        amount,
        current,
      };
    });
  }, [data, goals, goalTargets, goalReminderMap, currentPeriodStart, reminderDefaults, selectedWalletId]);

  const handleReminderDefaultsChange = (next: ReminderDefaults) => {
    setReminderDefaultsState(next);
    setReminderDefaults(next);
  };

  /**
   * Creates or refreshes many goals' funding transfers in one push, rather than
   * one round trip per goal. Amounts come from each goal's target; the source
   * account and the day are shared.
   */
  const handleSyncReminders = (categoryIds: string[]) =>
    runZenWrite(`Sync ${categoryIds.length} recurring transfer${categoryIds.length === 1 ? '' : 's'}`,
      async () => {
        if (!token || !data || !selectedWalletId) return;
        const walletAccount = data.accounts.find((a) => a.id === selectedWalletId);
        if (!walletAccount) throw new Error('The selected wallet is no longer available');
        const sourceAccount = data.accounts.find((a) => a.id === reminderDefaults.sourceAccountId);
        if (!sourceAccount) throw new Error('Pick the account the transfers come from');
        const userId = data.user?.id;
        if (!userId) throw new Error('User profile not loaded yet — refresh and try again');

        const planById = new Map(reminderPlans.map((p) => [p.categoryId, p]));
        const now = nextChangedTimestamp(data.serverTimestamp);
        const dataAccountId = getDataAccount(data.accounts)?.id ?? null;
        const links = { ...parseGoalRemindersFromReminders(data.reminders, dataAccountId) };

        const reminders: ZenReminder[] = [];
        const markers: ZenReminderMarker[] = [];
        let linksChanged = false;

        for (const categoryId of categoryIds) {
          const amount = planById.get(categoryId)?.amount;
          if (!amount) continue;
          const config: GoalReminderConfig = {
            type: 'transfer',
            sourceAccountId: sourceAccount.id,
            dayOfMonth: reminderDefaults.dayOfMonth,
            amount,
          };

          const existing = goalReminderMap.get(categoryId);
          const reminder = existing
              ? applyGoalReminderConfig(
                  existing,
                  config,
                  {
                    walletId: selectedWalletId,
                    walletInstrument: walletAccount.instrument,
                    sourceInstrument: sourceAccount.instrument,
                  },
                  nextChangedTimestamp(data.serverTimestamp, existing.changed)
                )
              : buildGoalReminder({
                  categoryId,
                  config,
                  walletId: selectedWalletId,
                  walletInstrument: walletAccount.instrument,
                  sourceInstrument: sourceAccount.instrument,
                  userId,
                  now,
                });

          reminders.push(reminder);
          markers.push(
            ...buildReminderMarkers({
              reminder,
              now,
              reuseIds: plannedMarkersFor(data.reminderMarkers, reminder.id).map((m) => m.id),
            })
          );

          // A transfer cannot carry its goal as a tag, so the association lives
          // in the goalReminders map.
          if (links[categoryId] !== reminder.id) {
            links[categoryId] = reminder.id;
            linksChanged = true;
          }
        }

        if (reminders.length === 0) throw new Error('Nothing to apply');

        await pushZenmoneyDiff(token, data.serverTimestamp, {
          reminder: reminders,
          reminderMarker: markers,
        });
        const changes: ZenLocalChanges = { reminders, reminderMarkers: markers };

        if (linksChanged) {
          const linkChanges = await syncGoalRemindersToZenmoney({
            token,
            serverTimestamp: data.serverTimestamp,
            accounts: data.accounts,
            reminders: data.reminders,
            links,
          });
          changes.accounts = linkChanges.accounts;
          changes.reminders = [...reminders, ...(linkChanges.reminders ?? [])];
        }

        await refresh();
        applyLocalChanges(changes);
        setShowReminderSync(false);
      });

  /**
   * Reminder edits push straight to ZenMoney rather than going through the
   * "Save Data" button, so they report their own outcome in a dialog — a
   * rejected push used to leave no trace at all. Returns false when it failed.
   */
  const runZenWrite = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    setWriteStatus({ label, state: 'saving' });
    try {
      await action();
      setWriteStatus({ label, state: 'ok' });
      return true;
    } catch (e) {
      setWriteStatus({
        label,
        state: 'error',
        detail: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  };

  const handleCreateReminder = (categoryId: string, config: GoalReminderConfig) =>
    runZenWrite('Create reminder', async () => {
      await createReminder(categoryId, config);
    });

  const createReminder = async (categoryId: string, config: GoalReminderConfig) => {
    if (!token || !data || !selectedWalletId) return;
    const walletAccount = data.accounts.find((a) => a.id === selectedWalletId);
    if (!walletAccount) throw new Error('The selected wallet is no longer available');
    const sourceAccount = config.type === 'transfer'
      ? data.accounts.find((a) => a.id === config.sourceAccountId)
      : walletAccount;
    if (!sourceAccount) throw new Error('Pick the account the transfer comes from');

    // ZenMoney rejects an entity without a real owner, and a cache written
    // before the user entity was fetched has none.
    const userId = data.user?.id;
    if (!userId) throw new Error('User profile not loaded yet — refresh and try again');

    const now = nextChangedTimestamp(data.serverTimestamp);
    const newReminder = buildGoalReminder({
      categoryId,
      config,
      walletId: selectedWalletId,
      walletInstrument: walletAccount.instrument,
      sourceInstrument: sourceAccount.instrument,
      userId,
      now,
    });

    const existing = goalReminderMap.get(categoryId);
    const reminderPatch: ZenReminder[] = existing
      ? [
          {
            ...existing,
            deleted: true,
            changed: nextChangedTimestamp(data.serverTimestamp, existing.changed),
          },
          newReminder,
        ]
      : [newReminder];
    // Without markers ZenMoney stores the rule and schedules nothing.
    const markers = buildReminderMarkers({ reminder: newReminder, now });
    await pushZenmoneyDiff(token, data.serverTimestamp, {
      reminder: reminderPatch,
      reminderMarker: markers,
    });
    const changes: ZenLocalChanges = { reminders: reminderPatch, reminderMarkers: markers };

    // The tag set above will not persist on a transfer reminder, so also record
    // the link in the goalReminders map so the goal recognizes it.
    if (config.type === 'transfer') {
      const dataAccountId = getDataAccount(data.accounts)?.id ?? null;
      const links = {
        ...parseGoalRemindersFromReminders(data.reminders, dataAccountId),
        [categoryId]: newReminder.id,
      };
      const linkChanges = await syncGoalRemindersToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        links,
      });
      changes.accounts = linkChanges.accounts;
      changes.reminders = [...reminderPatch, ...(linkChanges.reminders ?? [])];
    }
    await refresh();
    applyLocalChanges(changes);
  };

  const handleDeleteReminder = (reminderId: string) =>
    runZenWrite('Delete reminder', async () => {
      await deleteReminder(reminderId);
    });

  const deleteReminder = async (reminderId: string) => {
    if (!token || !data) return;
    const dataAccountId = getDataAccount(data.accounts)?.id ?? null;
    const goalReminders = parseGoalRemindersFromReminders(data.reminders, dataAccountId);
    const linkedTag = Object.entries(goalReminders).find(([, rid]) => rid === reminderId)?.[0];

    // A transfer reminder linked for display only is not owned by us — just unlink
    // it (remove the goalReminders entry) rather than deleting the real reminder.
    if (linkedTag) {
      const rest = { ...goalReminders };
      delete rest[linkedTag];
      const changes = await syncGoalRemindersToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        links: rest,
      });
      await refresh();
      applyLocalChanges(changes);
      return;
    }

    const reminder = data.reminders.find((r) => r.id === reminderId);
    if (!reminder) throw new Error('That reminder no longer exists');
    const deleted: ZenReminder = {
      ...reminder,
      deleted: true,
      changed: nextChangedTimestamp(data.serverTimestamp, reminder.changed),
    };
    await pushZenmoneyDiff(token, data.serverTimestamp, { reminder: [deleted] });
    await refresh();
    applyLocalChanges({ reminders: [deleted] });
  };

  const handleUpdateReminder = (
    reminderId: string,
    config: GoalReminderConfig,
    categoryId: string
  ) =>
    runZenWrite('Save reminder', async () => {
      await updateReminder(reminderId, config, categoryId);
    });

  const updateReminder = async (
    reminderId: string,
    config: GoalReminderConfig,
    categoryId: string
  ) => {
    if (!token || !data || !selectedWalletId) return;
    const reminder = data.reminders.find((r) => r.id === reminderId);
    if (!reminder) throw new Error('That reminder no longer exists');

    const walletAccount = data.accounts.find((a) => a.id === selectedWalletId);
    if (!walletAccount) throw new Error('The selected wallet is no longer available');

    const isTransfer = config.type === 'transfer';
    const sourceAccount = isTransfer
      ? data.accounts.find((a) => a.id === config.sourceAccountId)
      : null;
    if (isTransfer && !sourceAccount) throw new Error('Pick the account the transfer comes from');

    const now = nextChangedTimestamp(data.serverTimestamp, reminder.changed);
    const base = applyGoalReminderConfig(
      reminder,
      config,
      {
        walletId: selectedWalletId,
        walletInstrument: walletAccount.instrument,
        sourceInstrument: sourceAccount?.instrument ?? null,
      },
      now
    );
    // An income reminder carries its goal as a tag; a transfer cannot, so it is
    // associated through the goalReminders map instead. Switching type has to
    // move the association across, or the reminder drops off the goal entirely.
    const updated: ZenReminder = isTransfer
      ? base
      : { ...base, tag: Array.from(new Set([...(base.tag ?? []), categoryId])) };

    // The markers carry their own copy of the amount, accounts and dates, so an
    // edit has to rewrite them too — in place, reusing the existing ids, or the
    // old occurrences would linger with the old figures.
    const markers = buildReminderMarkers({
      reminder: updated,
      now,
      reuseIds: plannedMarkersFor(data.reminderMarkers, updated.id).map((m) => m.id),
    });
    await pushZenmoneyDiff(token, data.serverTimestamp, {
      reminder: [updated],
      reminderMarker: markers,
    });
    const changes: ZenLocalChanges = { reminders: [updated], reminderMarkers: markers };

    const dataAccountId = getDataAccount(data.accounts)?.id ?? null;
    const currentLinks = parseGoalRemindersFromReminders(data.reminders, dataAccountId);
    const isLinked = currentLinks[categoryId] === reminderId;
    if (isTransfer !== isLinked) {
      const links = { ...currentLinks };
      if (isTransfer) links[categoryId] = reminderId;
      else delete links[categoryId];
      const linkChanges = await syncGoalRemindersToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        links,
      });
      changes.accounts = linkChanges.accounts;
      changes.reminders = [updated, ...(linkChanges.reminders ?? [])];
    }

    await refresh();
    applyLocalChanges(changes);
  };

  const handleLinkReminder = (reminderId: string, categoryId: string) =>
    runZenWrite('Link reminder', async () => {
      await linkReminder(reminderId, categoryId);
    });

  const linkReminder = async (reminderId: string, categoryId: string) => {
    if (!token || !data) return;
    const reminder = data.reminders.find((r) => r.id === reminderId);
    if (!reminder) throw new Error('That reminder no longer exists');

    // ZenMoney does not allow categories/tags on transfer reminders, so linking a
    // transfer is persisted via the goalReminders map (goal tag -> reminder id).
    const isTransfer = reminder.incomeAccount !== reminder.outcomeAccount;
    if (isTransfer) {
      const dataAccountId = getDataAccount(data.accounts)?.id ?? null;
      const links = {
        ...parseGoalRemindersFromReminders(data.reminders, dataAccountId),
        [categoryId]: reminder.id,
      };
      const changes = await syncGoalRemindersToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        links,
      });
      await refresh();
      applyLocalChanges(changes);
      return;
    }

    const updatedTags = Array.from(new Set([...(reminder.tag ?? []), categoryId]));
    const updated: ZenReminder = {
      ...reminder,
      tag: updatedTags,
      changed: nextChangedTimestamp(data.serverTimestamp, reminder.changed),
    };
    await pushZenmoneyDiff(token, data.serverTimestamp, { reminder: [updated] });
    await refresh();
    applyLocalChanges({ reminders: [updated] });
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
      const related = findSameReminderUnassignedTransactions({
        transactionId,
        feed,
        transactionMap,
        markerToReminderId,
        manualAssignments,
      });
      if (related && related.transactionIds.length > 0) {
        setBulkSuggestion({
          tagId: nextTagId,
          reminderMarker: related.reminderMarker,
          affectedTransactionIds: related.transactionIds,
        });
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
      if (tx != null && isTransferTransaction(tx)) transferIds.push(txId);
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
      const transactionUpdates = Object.entries(pendingCategoryChanges)
          .map(([txId, tagId]) => {
            const original = transactionMap.get(txId);
            if (!original) return null;
            return {
              ...original,
              tag: tagId ? [tagId] : null,
              changed: nextChangedTimestamp(data.serverTimestamp, original.changed),
            } as ZenTransaction;
          })
          .filter((t): t is ZenTransaction => t !== null);

      const changes = await syncHiddenDataToZenmoney({
        token,
        serverTimestamp: data.serverTimestamp,
        accounts: data.accounts,
        reminders: data.reminders,
        assignments: manualAssignments,
        targets: goalTargets,
        transactionUpdates: transactionUpdates.length > 0 ? transactionUpdates : undefined,
      });
      await refresh();
      // The incremental sync above does not echo our own push back, so the new
      // categories (and the assignments reminder the goals are re-parsed from)
      // have to be folded in explicitly — otherwise goal amounts snap back to
      // their pre-save values.
      applyLocalChanges(changes);
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
      setSaveError(
        `Failed to save to [One-Zenwallet Data]: ${e instanceof Error ? e.message : 'unknown error'}`
      );
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
              <button
                  className="btn-text"
                  onClick={() => setShowReminderSync(true)}
                  disabled={loading || goals.length === 0}
                  title="Create or refresh the monthly transfer that funds each goal"
              >
                Transfers…
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
              <p className="save-banner save-error">{saveError}</p>
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
                  suggestedReminder={suggestedReminderMap.get(goal.categoryId) ?? null}
                  onCreateReminder={handleCreateReminder}
                  onUpdateReminder={handleUpdateReminder}
                  onDeleteReminder={handleDeleteReminder}
                  onLinkReminder={handleLinkReminder}
                  onDismissSuggestion={handleDismissSuggestion}
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

        {showReminderSync && (
            <ReminderSyncDialog
                plans={reminderPlans}
                accounts={data.accounts}
                walletId={selectedWalletId}
                walletTitle={selectedAccount?.title ?? 'the wallet'}
                currency={currency}
                defaults={reminderDefaults}
                onDefaultsChange={handleReminderDefaultsChange}
                onApply={handleSyncReminders}
                onClose={() => setShowReminderSync(false)}
                busy={writeStatus?.state === 'saving'}
            />
        )}

        <StatusDialog status={writeStatus} onClose={closeWriteStatus} />
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
  suggestedReminder,
  onCreateReminder,
  onUpdateReminder,
  onDeleteReminder,
  onLinkReminder,
  onDismissSuggestion,
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
  suggestedReminder: ZenReminder | null;
  onCreateReminder: (categoryId: string, config: GoalReminderConfig) => Promise<boolean>;
  onUpdateReminder: (
    reminderId: string,
    config: GoalReminderConfig,
    categoryId: string
  ) => Promise<boolean>;
  onDeleteReminder: (reminderId: string) => Promise<boolean>;
  onLinkReminder: (reminderId: string, categoryId: string) => Promise<boolean>;
  onDismissSuggestion: (reminderId: string) => void;
}) {
  const [reminderType, setReminderType] = useState<'transfer' | 'income'>('transfer');
  const [reminderSourceId, setReminderSourceId] = useState('');
  const [reminderDay, setReminderDay] = useState(monthStartDay || 1);
  const [reminderAmount, setReminderAmount] = useState(0);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderEditing, setReminderEditing] = useState(false);
  // Deleting a suggested reminder removes a real ZenMoney entity the app does
  // not own, so it asks first.
  const [confirmDropSuggestion, setConfirmDropSuggestion] = useState(false);

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

  const accountTitle = (id: string) => accounts.find((a) => a.id === id)?.title ?? 'unknown account';
  const walletTitle = accountTitle(selectedWalletId);

  const { thisMonthAdded, monthlyNeeded, nextMonthNeeded, leftAmount, monthlyStatus } =
    computeGoalProgress(goal, target, currentPeriodStart);

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
          {monthlyNeeded !== null && (
            <span className={`goal-monthly-badge goal-monthly-${monthlyStatus}`}>
              ~{monthlyNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
            </span>
          )}
          <span className={`goal-amount ${goal.amount === 0 ? 'zero' : goal.amount > 0 ? 'positive' : 'negative'}`}>
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
                    : `~${monthlyNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}/mo this month`}
                </div>
              )}
              {nextMonthNeeded !== null &&
                nextMonthNeeded > 0 &&
                targetType !== 'fixed_monthly' && (
                  <div className="goal-monthly-needed goal-monthly-next">
                    ~{nextMonthNeeded.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo from next month
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
                  Day {reminderDayOfMonth(existingReminder)} · {existingReminder.income.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo
                </span>
              )}
            </div>
            {existingReminder ? (
              reminderEditing ? (
                <div className="goal-reminder-form">
                  <div className="goal-reminder-row">
                    {reminderType === 'transfer' && (
                      <label className="goal-target-field">
                        <span className="goal-target-label">From account → {walletTitle}</span>
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
                          const saved = await onUpdateReminder(
                            existingReminder.id,
                            {
                              type: reminderType,
                              sourceAccountId: reminderSourceId,
                              dayOfMonth: reminderDay,
                              amount: reminderAmount,
                            },
                            goal.categoryId
                          );
                          // Keep the form open on failure so the edit is not lost.
                          if (saved) setReminderEditing(false);
                        } finally { setReminderLoading(false); }
                      }}
                    >
                      {reminderLoading ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      className="btn-text"
                      disabled={reminderLoading}
                      onClick={() => setReminderEditing(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="goal-reminder-existing">
                  <span>
                    {existingReminder.incomeAccount === existingReminder.outcomeAccount ? '➕ Income' : '🔄 Transfer'}
                    {' '}on day {reminderDayOfMonth(existingReminder)} — {existingReminder.income.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo
                    {existingReminder.incomeAccount !== existingReminder.outcomeAccount && (
                      <span className="goal-reminder-route">
                        {' '}({accountTitle(existingReminder.outcomeAccount)} → {accountTitle(existingReminder.incomeAccount)})
                      </span>
                    )}
                  </span>
                  <button
                    className="btn-text"
                    disabled={reminderLoading}
                    onClick={() => {
                      const isTransfer = existingReminder.incomeAccount !== existingReminder.outcomeAccount;
                      setReminderType(isTransfer ? 'transfer' : 'income');
                      // The funding account is whichever side is not the goal
                      // wallet. A reminder that was linked rather than created
                      // here may run the other way, and prefilling the wallet
                      // itself would leave an unpickable value in the select.
                      const counterpart =
                        existingReminder.outcomeAccount === selectedWalletId
                          ? existingReminder.incomeAccount
                          : existingReminder.outcomeAccount;
                      setReminderSourceId(
                        isTransfer && counterpart !== selectedWalletId ? counterpart : ''
                      );
                      setReminderDay(reminderDayOfMonth(existingReminder));
                      setReminderAmount(existingReminder.income || 0);
                      setReminderEditing(true);
                    }}
                  >
                    Edit
                  </button>
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
              )
            ) : (
              <div className="goal-reminder-form">
                {suggestedReminder && (
                  <div className="goal-reminder-suggestion">
                    <span>
                      {suggestedReminder.incomeAccount === suggestedReminder.outcomeAccount ? '➕' : '🔄'}{' '}
                      Reminder found (day {reminderDayOfMonth(suggestedReminder)} · {suggestedReminder.income.toLocaleString(undefined, { maximumFractionDigits: 0 })} {currency}/mo)
                      {suggestedReminder.incomeAccount !== suggestedReminder.outcomeAccount && (
                        <span className="goal-reminder-route">
                          {' '}({accountTitle(suggestedReminder.outcomeAccount)} → {accountTitle(suggestedReminder.incomeAccount)})
                        </span>
                      )}
                    </span>
                    {confirmDropSuggestion ? (
                      <div className="goal-reminder-suggestion-actions">
                        <span className="goal-reminder-confirm">Delete it from ZenMoney?</span>
                        <button
                          className="btn-text goal-reminder-delete"
                          disabled={reminderLoading}
                          onClick={async () => {
                            setReminderLoading(true);
                            try {
                              const deleted = await onDeleteReminder(suggestedReminder.id);
                              if (deleted) setConfirmDropSuggestion(false);
                            } finally { setReminderLoading(false); }
                          }}
                        >
                          {reminderLoading ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button
                          className="btn-text"
                          disabled={reminderLoading}
                          onClick={() => setConfirmDropSuggestion(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="goal-reminder-suggestion-actions">
                        <button
                          className="btn-text"
                          disabled={reminderLoading}
                          onClick={async () => {
                            setReminderLoading(true);
                            try { await onLinkReminder(suggestedReminder.id, goal.categoryId); } finally { setReminderLoading(false); }
                          }}
                        >
                          {reminderLoading ? 'Linking…' : 'Link'}
                        </button>
                        <button
                          className="btn-text"
                          disabled={reminderLoading}
                          title="Stop offering this reminder on this device. The reminder itself is left alone."
                          onClick={() => onDismissSuggestion(suggestedReminder.id)}
                        >
                          Hide
                        </button>
                        <button
                          className="btn-text goal-reminder-delete"
                          disabled={reminderLoading}
                          title="Delete this reminder from ZenMoney"
                          onClick={() => setConfirmDropSuggestion(true)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}
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
                      <span className="goal-target-label">From account → {walletTitle}</span>
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
            {(() => {
              const txs = goal.transactions;
              let running = 0;
              const balances = txs.map((tx) => { running += tx.amount; return running; });
              const reversedTxs = txs.slice().reverse();
              const reversedBalances = balances.slice().reverse();
              return reversedTxs.map((tx, i) => (
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
                  <div className="goal-tx-right">
                    <span className={`goal-tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                      {formatAmount(tx.amount)}
                    </span>
                    <span className="goal-tx-balance">{formatAmount(reversedBalances[i])}</span>
                  </div>
                </div>
              ));
            })()}
          </div>
        </>
      )}
    </div>
  );
}
