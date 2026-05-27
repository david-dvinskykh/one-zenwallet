import type {
  ZenTransaction,
  ZenTag,
  ZenAccount,
  ZenReminder,
  Goal,
  GoalFeedItem,
  GoalTransaction,
  GoalsComputationResult,
} from '../types/zenmoney';
import { getDataAccount } from './hiddenData';

interface ComputeGoalsOptions {
  reminders?: ZenReminder[];
  manualAssignments?: Record<string, string>;
  pinnedCategoryIds?: string[];
}

export function computeGoals(
  transactions: ZenTransaction[],
  tags: ZenTag[],
  accounts: ZenAccount[],
  selectedWalletId: string,
  options: ComputeGoalsOptions = {}
): GoalsComputationResult {
  const { reminders = [], manualAssignments = {} } = options;

  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const linkedAccountGoalMap = extractLinkedAccountGoalMap(reminders, accounts, tags);

  function normalizeText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  const tagTitleMatchers = tags
    .map((tag) => ({ id: tag.id, title: normalizeText(tag.title) }))
    .sort((a, b) => b.title.length - a.title.length);

  function findTagIdByComment(comment: string | null): string | null {
    if (!comment) return null;

    const normalizedComment = normalizeText(comment);
    const exact = tagTitleMatchers.find((tag) => tag.title === normalizedComment);
    if (exact) return exact.id;

    for (const tag of tagTitleMatchers) {
      if (normalizedComment.includes(tag.title)) {
        return tag.id;
      }
    }

    return null;
  }

  const goalMap = new Map<string, Goal>();
  const feed: GoalFeedItem[] = [];

  function getGoal(tagId: string): Goal {
    let goal = goalMap.get(tagId);
    if (!goal) {
      const tag = tagMap.get(tagId);
      goal = {
        categoryId: tagId,
        categoryTitle: tag?.title ?? 'Unknown',
        amount: 0,
        transactions: [],
      };
      goalMap.set(tagId, goal);
    }
    return goal;
  }

  function pushTransaction(goal: Goal, transaction: GoalTransaction): void {
    goal.amount += transaction.amount;
    goal.transactions.push(transaction);
  }

  function addFeedItem(
    tx: ZenTransaction,
    amount: number,
    goalId: string | null,
    source: GoalFeedItem['source'],
    comment: string | null,
    isTransfer: boolean
  ): void {
    const goalTitle = goalId ? tagMap.get(goalId)?.title ?? 'Unknown' : null;
    feed.push({
      id: `${tx.id}:${goalId ?? 'none'}:${source}:${feed.length}`,
      date: tx.date,
      amount,
      direction: amount >= 0 ? 'income' : 'spending',
      transactionId: tx.id,
      goalId,
      goalTitle,
      comment,
      source,
      isTransfer,
    });
  }

  const sorted = [...transactions]
    .filter((t) => !t.deleted)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const tx of sorted) {
    const isOutcomeFromWallet = tx.outcomeAccount === selectedWalletId;
    const isIncomeToWallet = tx.incomeAccount === selectedWalletId;

    if (!isOutcomeFromWallet && !isIncomeToWallet) continue;

    const isTransfer =
      tx.outcomeAccount !== tx.incomeAccount &&
      tx.income > 0 &&
      tx.outcome > 0;

    const manualTagId = manualAssignments[tx.id] ?? null;
    const directionAmount =
      isIncomeToWallet && isOutcomeFromWallet
        ? tx.income - tx.outcome
        : isIncomeToWallet
        ? tx.income
        : -tx.outcome;

    // 1) Manual override — only for transfers (spending/income use category only).
    if (isTransfer && manualTagId && tagMap.has(manualTagId)) {
      const goal = getGoal(manualTagId);
      pushTransaction(goal, {
        id: tx.id,
        date: tx.date,
        amount: directionAmount,
        type: directionAmount >= 0 ? 'income' : 'spending',
        comment: tx.comment,
      });
      addFeedItem(tx, directionAmount, manualTagId, 'manual', tx.comment, true);
      continue;
    }

    // 2) Native tags from ZenMoney transaction.
    if (tx.tag?.length) {
      for (const tagId of tx.tag) {
        const goal = getGoal(tagId);
        pushTransaction(goal, {
          id: tx.id,
          date: tx.date,
          amount: directionAmount,
          type: directionAmount >= 0 ? 'income' : 'spending',
          comment: tx.comment,
        });
        addFeedItem(tx, directionAmount, tagId, 'tag', tx.comment, isTransfer);
      }
      continue;
    }

    // 3) Incoming transfer to selected wallet: infer by comment.
    if (isTransfer && isIncomeToWallet && tx.income > 0) {
      const sourceAccount = accountMap.get(tx.outcomeAccount);
      const sourceTitle = sourceAccount?.title ?? 'unknown';

      const matchedByComment = findTagIdByComment(tx.comment);
      if (matchedByComment) {
        const goal = getGoal(matchedByComment);
        const details = tx.comment?.trim();
        const comment = details
          ? `Transfer from ${sourceTitle}. ${details}`
          : `Transfer from ${sourceTitle}`;
        pushTransaction(goal, {
          id: tx.id,
          date: tx.date,
          amount: tx.income,
          type: 'income',
          comment,
        });
        addFeedItem(tx, tx.income, matchedByComment, 'transfer_comment', comment, true);
        continue;
      }

      const matchedByLinkedAccount = linkedAccountGoalMap.get(tx.outcomeAccount) ?? null;
      if (matchedByLinkedAccount && tagMap.has(matchedByLinkedAccount)) {
        const goal = getGoal(matchedByLinkedAccount);
        const comment = `Transfer from ${sourceTitle}`;
        pushTransaction(goal, {
          id: tx.id,
          date: tx.date,
          amount: tx.income,
          type: 'income',
          comment,
        });
        addFeedItem(tx, tx.income, matchedByLinkedAccount, 'linked_account', comment, true);
        continue;
      }
    }

    addFeedItem(tx, directionAmount, null, 'unassigned', tx.comment, isTransfer);
  }

  for (const tagId of options.pinnedCategoryIds ?? []) {
    if (!goalMap.has(tagId)) {
      const tag = tagMap.get(tagId);
      if (tag) {
        goalMap.set(tagId, { categoryId: tagId, categoryTitle: tag.title, amount: 0, transactions: [] });
      }
    }
  }

  const goals = Array.from(goalMap.values()).sort((a, b) =>
    a.categoryTitle.localeCompare(b.categoryTitle)
  );

  feed.sort((a, b) => a.date.localeCompare(b.date));

  return { goals, feed };
}

function extractLinkedAccountGoalMap(
  reminders: ZenReminder[],
  accounts: ZenAccount[],
  tags: ZenTag[]
): Map<string, string> {
  const result = new Map<string, string>();
  if (!reminders.length) return result;

  const validTagIds = new Set(tags.map((t) => t.id));
  const dataAccount = getDataAccount(accounts);
  if (!dataAccount) return result;

  for (const reminder of reminders) {
    if (reminder.deleted) continue;
    if (
      reminder.incomeAccount !== dataAccount.id ||
      reminder.outcomeAccount !== dataAccount.id
    ) {
      continue;
    }

    const parsed = parseJson(reminder.comment);
    if (!parsed || typeof parsed !== 'object') continue;

    // Newer format: { type: 'linkedAccounts', payload: { [accountId]: tagId } }
    if (
      'type' in parsed &&
      parsed.type === 'linkedAccounts' &&
      'payload' in parsed &&
      parsed.payload &&
      typeof parsed.payload === 'object'
    ) {
      for (const [accountId, tagId] of Object.entries(parsed.payload as Record<string, string>)) {
        if (validTagIds.has(tagId)) {
          result.set(accountId, tagId);
        }
      }
    }

    // Legacy format: reminder.payee = 'accLinks', comment = JSON map.
    if (reminder.payee === 'accLinks') {
      for (const [accountId, tagId] of Object.entries(parsed as Record<string, string>)) {
        if (validTagIds.has(tagId)) {
          result.set(accountId, tagId);
        }
      }
    }
  }

  return result;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}