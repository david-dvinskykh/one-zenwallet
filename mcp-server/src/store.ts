import { fetchZenmoneyDiff, pushZenmoneyDiff } from '../../src/api/zenmoney';
import { computeGoals, isTransferTransaction } from '../../src/utils/goals';
import {
  getDataAccount,
  parseGoalRemindersFromReminders,
  parseGoalTargetsFromReminders,
  parseManualAssignmentsFromReminders,
} from '../../src/utils/hiddenData';
import { syncHiddenDataToZenmoney } from '../../src/utils/hiddenDataSync';
import { syncGoalRemindersToZenmoney } from '../../src/utils/goalRemindersSync';
import { computeCurrentPeriodStart } from '../../src/utils/goalMath';
import {
  buildGoalReminderMap,
  buildMarkerToReminderMap,
  buildSuggestedReminderMap,
} from '../../src/utils/goalReminders';
import {
  applyLocalChanges,
  mergeZenData,
  nextChangedTimestamp,
  toZenDataDiff,
  type ZenData,
  type ZenLocalChanges,
} from '../../src/utils/zenData';
import type {
  Goal,
  GoalFeedItem,
  GoalTarget,
  ZenAccount,
  ZenReminder,
  ZenTag,
  ZenTransaction,
} from '../../src/types/zenmoney';
import {
  clearPersisted,
  emptyState,
  readCache,
  readState,
  writeCache,
  writeState,
  type PersistedState,
} from './state';

export class ZenError extends Error {}

export interface GoalsView {
  goals: Goal[];
  feed: GoalFeedItem[];
}

/**
 * Holds the session the way `AppContext` does in the web app: a cached ZenMoney
 * snapshot, the selected wallet, and edits staged until they are pushed back.
 */
export class ZenStore {
  private state: PersistedState;
  private snapshot: ZenData | null;

  private constructor(state: PersistedState, snapshot: ZenData | null) {
    this.state = state;
    this.snapshot = snapshot;
  }

  static async load(): Promise<ZenStore> {
    const [state, snapshot] = await Promise.all([readState(), readCache()]);
    return new ZenStore(state, snapshot);
  }

  // ---------------------------------------------------------------- session

  get token(): string | null {
    return this.state.token ?? process.env.ZENMONEY_TOKEN ?? null;
  }

  get tokenSource(): 'zen_login' | 'ZENMONEY_TOKEN' | null {
    if (this.state.token) return 'zen_login';
    if (process.env.ZENMONEY_TOKEN) return 'ZENMONEY_TOKEN';
    return null;
  }

  requireToken(): string {
    const token = this.token;
    if (!token) {
      throw new ZenError(
        'Not authenticated. Call zen_login with a ZenMoney API token, or set ZENMONEY_TOKEN in the server environment.'
      );
    }
    return token;
  }

  get selectedWalletId(): string | null {
    return this.state.selectedWalletId;
  }

  get serverTimestamp(): number {
    return this.snapshot?.serverTimestamp ?? this.state.serverTimestamp;
  }

  get pinnedGoalCategories(): string[] {
    return this.state.pinnedGoalCategories;
  }

  get pendingManualAssignments(): Record<string, string | null> {
    return this.state.pendingManualAssignments;
  }

  get pendingCategoryChanges(): Record<string, string | null> {
    return this.state.pendingCategoryChanges;
  }

  get pendingGoalTargets(): Record<string, GoalTarget | null> {
    return this.state.pendingGoalTargets;
  }

  hasPendingChanges(): boolean {
    return (
      Object.keys(this.state.pendingManualAssignments).length > 0 ||
      Object.keys(this.state.pendingCategoryChanges).length > 0 ||
      Object.keys(this.state.pendingGoalTargets).length > 0
    );
  }

  async login(token: string): Promise<ZenData> {
    const previousState = this.state;
    const previousSnapshot = this.snapshot;

    this.state = { ...emptyState(), token };
    this.snapshot = null;
    try {
      const data = await this.sync({ full: true });
      await this.persistState();
      return data;
    } catch (error) {
      // Never leave a token that does not work behind.
      this.state = previousState;
      this.snapshot = previousSnapshot;
      await this.persistState();
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.state = emptyState();
    this.snapshot = null;
    await clearPersisted();
  }

  private async persistState(): Promise<void> {
    await writeState(this.state);
  }

  // ------------------------------------------------------------------- data

  /** Cached snapshot, fetching a full one the first time it is needed. */
  async ensureData(): Promise<ZenData> {
    if (!this.snapshot) await this.sync({ full: true });
    if (!this.snapshot) throw new ZenError('No ZenMoney data available');
    return this.snapshot;
  }

  requireData(): ZenData {
    if (!this.snapshot) {
      throw new ZenError('No ZenMoney data cached yet. Call zen_sync first.');
    }
    return this.snapshot;
  }

  /** Incremental by default; `full` re-pulls everything from serverTimestamp 0. */
  async sync(options: { full?: boolean } = {}): Promise<ZenData> {
    const token = this.requireToken();
    const timestamp = options.full ? 0 : this.serverTimestamp;
    // A snapshot created before reminderMarker support has none cached; ask for
    // them explicitly so recurring-transaction grouping keeps working.
    const forceFetch =
      timestamp > 0 && !this.snapshot?.reminderMarkers?.length ? ['reminderMarker'] : undefined;

    const diff = await fetchZenmoneyDiff(token, timestamp, forceFetch);
    const merged = mergeZenData(options.full ? null : this.snapshot, toZenDataDiff(diff));

    this.snapshot = merged;
    this.state.serverTimestamp = merged.serverTimestamp;
    await Promise.all([writeCache(merged), this.persistState()]);
    return merged;
  }

  async push(patch: Record<string, unknown>): Promise<void> {
    const token = this.requireToken();
    await pushZenmoneyDiff(token, this.requireData().serverTimestamp, patch);
    await this.applyLocal({
      accounts: patch.account as ZenAccount[] | undefined,
      tags: patch.tag as ZenTag[] | undefined,
      transactions: patch.transaction as ZenTransaction[] | undefined,
      reminders: patch.reminder as ZenReminder[] | undefined,
    });
  }

  /**
   * Folds entities we just pushed into the cached snapshot. The following
   * incremental sync does not return our own writes, so without this the
   * snapshot — and every goal amount derived from it — stays on the pre-push
   * values. See `applyLocalChanges` in src/utils/zenData.ts.
   */
  async applyLocal(changes: ZenLocalChanges): Promise<void> {
    if (!this.snapshot) return;
    this.snapshot = applyLocalChanges(this.snapshot, changes);
    await writeCache(this.snapshot);
  }

  /** A `changed` stamp the ZenMoney server will not discard as stale. */
  nextChanged(previousChanged?: number | null): number {
    return nextChangedTimestamp(this.requireData().serverTimestamp, previousChanged);
  }

  // ---------------------------------------------------------------- lookups

  requireWalletId(): string {
    const walletId = this.state.selectedWalletId;
    if (!walletId) {
      throw new ZenError(
        'No wallet selected. Call zen_list_wallets to see the options, then zen_select_wallet.'
      );
    }
    return walletId;
  }

  async selectWallet(walletId: string): Promise<ZenAccount> {
    const data = await this.ensureData();
    const account = data.accounts.find((a) => a.id === walletId);
    if (!account) throw new ZenError(`No account with id ${walletId}`);
    this.state.selectedWalletId = walletId;
    await this.persistState();
    return account;
  }

  async clearWallet(): Promise<void> {
    this.state.selectedWalletId = null;
    await this.persistState();
  }

  findAccount(idOrTitle: string): ZenAccount {
    const data = this.requireData();
    const byId = data.accounts.find((a) => a.id === idOrTitle);
    if (byId) return byId;

    const normalized = idOrTitle.trim().toLowerCase();
    const matches = data.accounts.filter((a) => a.title.trim().toLowerCase() === normalized);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ZenError(
        `Several accounts are called "${idOrTitle}". Use the account id instead: ${matches.map((a) => a.id).join(', ')}`
      );
    }
    throw new ZenError(`No account matching "${idOrTitle}"`);
  }

  findTag(idOrTitle: string): ZenTag {
    const data = this.requireData();
    const byId = data.tags.find((t) => t.id === idOrTitle);
    if (byId) return byId;

    const normalized = idOrTitle.trim().toLowerCase();
    const matches = data.tags.filter((t) => t.title.trim().toLowerCase() === normalized);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ZenError(
        `Several categories are called "${idOrTitle}". Use the category id instead: ${matches.map((t) => t.id).join(', ')}`
      );
    }
    throw new ZenError(`No category matching "${idOrTitle}"`);
  }

  transactionMap(): Map<string, ZenTransaction> {
    return new Map(this.requireData().transactions.map((t) => [t.id, t]));
  }

  currencySymbol(walletId = this.state.selectedWalletId): string {
    const data = this.snapshot;
    if (!data || !walletId) return '';
    const account = data.accounts.find((a) => a.id === walletId);
    if (!account) return '';
    return data.instruments.find((i) => i.id === account.instrument)?.symbol ?? '';
  }

  dataAccountId(): string | null {
    return getDataAccount(this.requireData().accounts)?.id ?? null;
  }

  currentPeriodStart(): string {
    return computeCurrentPeriodStart(this.requireData().user?.monthStartDay ?? 1);
  }

  // ------------------------------------------------- hidden data + staging

  cloudManualAssignments(): Record<string, string> {
    const data = this.requireData();
    return parseManualAssignmentsFromReminders(data.reminders, this.dataAccountId());
  }

  /** Cloud assignments with the staged edits applied. */
  manualAssignments(): Record<string, string> {
    const merged: Record<string, string> = { ...this.cloudManualAssignments() };
    for (const [txId, tagId] of Object.entries(this.state.pendingManualAssignments)) {
      if (tagId) merged[txId] = tagId;
      else delete merged[txId];
    }
    return merged;
  }

  cloudGoalTargets(): Record<string, GoalTarget> {
    const data = this.requireData();
    return parseGoalTargetsFromReminders(data.reminders, this.dataAccountId());
  }

  goalTargets(): Record<string, GoalTarget> {
    const merged: Record<string, GoalTarget> = { ...this.cloudGoalTargets() };
    for (const [tagId, target] of Object.entries(this.state.pendingGoalTargets)) {
      if (target) merged[tagId] = target;
      else delete merged[tagId];
    }
    return merged;
  }

  goalReminderLinks(): Record<string, string> {
    const data = this.requireData();
    return parseGoalRemindersFromReminders(data.reminders, this.dataAccountId());
  }

  async setGoalTarget(categoryId: string, target: GoalTarget | null): Promise<void> {
    const cloud = this.cloudGoalTargets();
    const unchanged =
      target === null
        ? !(categoryId in cloud)
        : JSON.stringify(cloud[categoryId]) === JSON.stringify(target);

    if (unchanged) delete this.state.pendingGoalTargets[categoryId];
    else this.state.pendingGoalTargets[categoryId] = target;

    await this.persistState();
  }

  /**
   * Stages a category for the given transactions. Mirrors the app: transfers are
   * recorded as app-side manual assignments (ZenMoney refuses categories on
   * transfers), everything else edits the transaction's own tag.
   */
  async assignTransactions(
    transactionIds: string[],
    tagId: string | null
  ): Promise<{ transfers: string[]; regular: string[]; unknown: string[] }> {
    const transactions = this.transactionMap();
    const cloudAssignments = this.cloudManualAssignments();
    const result = { transfers: [] as string[], regular: [] as string[], unknown: [] as string[] };

    for (const txId of transactionIds) {
      const tx = transactions.get(txId);
      if (!tx) {
        result.unknown.push(txId);
        continue;
      }

      if (isTransferTransaction(tx)) {
        const cloudTagId = cloudAssignments[txId] ?? null;
        if (tagId === cloudTagId) delete this.state.pendingManualAssignments[txId];
        else this.state.pendingManualAssignments[txId] = tagId;
        result.transfers.push(txId);
      } else {
        const originalTagId = tx.tag?.[0] ?? null;
        if (tagId === originalTagId) delete this.state.pendingCategoryChanges[txId];
        else this.state.pendingCategoryChanges[txId] = tagId;
        result.regular.push(txId);
      }
    }

    await this.persistState();
    return result;
  }

  async discardPendingChanges(): Promise<void> {
    this.state.pendingManualAssignments = {};
    this.state.pendingCategoryChanges = {};
    this.state.pendingGoalTargets = {};
    await this.persistState();
  }

  async pinGoalCategory(categoryId: string): Promise<void> {
    if (!this.state.pinnedGoalCategories.includes(categoryId)) {
      this.state.pinnedGoalCategories = [...this.state.pinnedGoalCategories, categoryId];
      await this.persistState();
    }
  }

  async unpinGoalCategory(categoryId: string): Promise<void> {
    this.state.pinnedGoalCategories = this.state.pinnedGoalCategories.filter(
      (id) => id !== categoryId
    );
    await this.persistState();
  }

  /**
   * Pushes staged assignments, targets and category changes to ZenMoney — the
   * "Save Data" button of the web app — then re-syncs.
   */
  async save(): Promise<{
    assignments: number;
    targets: number;
    transactionUpdates: number;
    unpinned: string[];
  }> {
    const token = this.requireToken();
    const data = this.requireData();
    const transactions = this.transactionMap();

    const transactionUpdates = Object.entries(this.state.pendingCategoryChanges)
      .map(([txId, tagId]) => {
        const original = transactions.get(txId);
        if (!original) return null;
        return {
          ...original,
          tag: tagId ? [tagId] : null,
          changed: nextChangedTimestamp(data.serverTimestamp, original.changed),
        } as ZenTransaction;
      })
      .filter((t): t is ZenTransaction => t !== null);

    const assignments = this.manualAssignments();
    const targets = this.goalTargets();

    const changes = await syncHiddenDataToZenmoney({
      token,
      serverTimestamp: data.serverTimestamp,
      accounts: data.accounts,
      reminders: data.reminders,
      assignments,
      targets,
      transactionUpdates: transactionUpdates.length > 0 ? transactionUpdates : undefined,
    });

    this.state.pendingManualAssignments = {};
    this.state.pendingCategoryChanges = {};
    this.state.pendingGoalTargets = {};
    await this.persistState();
    await this.sync();
    // The sync does not echo our own push back — fold it in so the goal amounts
    // computed below reflect what was just saved.
    await this.applyLocal(changes);

    // A pinned category that stayed empty was only a placeholder — drop it, as
    // the web app does after a successful save.
    const { goals } = this.computeGoalsView();
    const unpinned = goals
      .filter((g) => g.transactions.length === 0 && this.state.pinnedGoalCategories.includes(g.categoryId))
      .map((g) => g.categoryId);
    if (unpinned.length > 0) {
      this.state.pinnedGoalCategories = this.state.pinnedGoalCategories.filter(
        (id) => !unpinned.includes(id)
      );
      await this.persistState();
    }

    return {
      assignments: Object.keys(assignments).length,
      targets: Object.keys(targets).length,
      transactionUpdates: transactionUpdates.length,
      unpinned,
    };
  }

  async syncGoalReminderLinks(links: Record<string, string>): Promise<void> {
    const token = this.requireToken();
    const data = this.requireData();
    const changes = await syncGoalRemindersToZenmoney({
      token,
      serverTimestamp: data.serverTimestamp,
      accounts: data.accounts,
      reminders: data.reminders,
      links,
    });
    await this.applyLocal(changes);
  }

  // ------------------------------------------------------------------ goals

  computeGoalsView(): GoalsView {
    const data = this.requireData();
    const walletId = this.requireWalletId();
    return computeGoals(data.transactions, data.tags, data.accounts, walletId, {
      reminders: data.reminders,
      manualAssignments: this.manualAssignments(),
      pinnedCategoryIds: this.state.pinnedGoalCategories,
    });
  }

  goalReminderMap(): Map<string, ZenReminder> {
    const data = this.requireData();
    return buildGoalReminderMap(data.reminders, data.accounts);
  }

  markerToReminderId(): Map<string, string> {
    return buildMarkerToReminderMap(this.requireData().reminderMarkers);
  }

  suggestedReminderMap(goals: Goal[]): Map<string, ZenReminder> {
    const data = this.requireData();
    return buildSuggestedReminderMap({
      goals,
      reminders: data.reminders,
      transactionMap: this.transactionMap(),
      markerToReminderId: this.markerToReminderId(),
      goalReminderMap: this.goalReminderMap(),
    });
  }
}
