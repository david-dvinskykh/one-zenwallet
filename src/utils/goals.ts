import type {
  ZenTransaction,
  ZenTag,
  ZenAccount,
  Goal,
  GoalTransaction,
} from '../types/zenmoney';

export function computeGoals(
  transactions: ZenTransaction[],
  tags: ZenTag[],
  accounts: ZenAccount[],
  selectedWalletId: string
): Goal[] {
  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  // Build a map: category title (lowercase) -> tag id for reverse lookup
  const tagTitleToId = new Map<string, string>();
  for (const tag of tags) {
    tagTitleToId.set(tag.title.toLowerCase(), tag.id);
  }

  const goalMap = new Map<string, Goal>();

  // Helper to get or create a goal for a tag
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

  // Sort transactions by date
  const sorted = [...transactions]
    .filter((t) => !t.deleted)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const tx of sorted) {
    const isOutcomeFromWallet = tx.outcomeAccount === selectedWalletId;
    const isIncomeToWallet = tx.incomeAccount === selectedWalletId;
    const isTransfer =
      tx.outcomeAccount !== tx.incomeAccount &&
      tx.income > 0 &&
      tx.outcome > 0;

    // Case 1: Spending from selected wallet with a category tag
    if (isOutcomeFromWallet && !isTransfer && tx.outcome > 0 && tx.tag?.length) {
      for (const tagId of tx.tag) {
        const goal = getGoal(tagId);
        const gt: GoalTransaction = {
          id: tx.id,
          date: tx.date,
          amount: -tx.outcome,
          type: 'spending',
          comment: tx.comment,
        };
        goal.amount -= tx.outcome;
        goal.transactions.push(gt);
      }
    }

    // Case 2: Income to selected wallet with a category tag
    if (isIncomeToWallet && !isTransfer && tx.income > 0 && tx.tag?.length) {
      for (const tagId of tx.tag) {
        const goal = getGoal(tagId);
        const gt: GoalTransaction = {
          id: tx.id,
          date: tx.date,
          amount: tx.income,
          type: 'income',
          comment: tx.comment,
        };
        goal.amount += tx.income;
        goal.transactions.push(gt);
      }
    }

    // Case 3: Transfer TO selected wallet from another account with category name in comment
    if (isTransfer && isIncomeToWallet && tx.comment) {
      const commentLower = tx.comment.toLowerCase().trim();
      const matchedTagId = tagTitleToId.get(commentLower);
      if (matchedTagId) {
        const goal = getGoal(matchedTagId);
        const sourceAccount = accountMap.get(tx.outcomeAccount);
        const gt: GoalTransaction = {
          id: tx.id,
          date: tx.date,
          amount: tx.income,
          type: 'transfer_in',
          comment: `Transfer from ${sourceAccount?.title ?? 'unknown'}`,
        };
        goal.amount += tx.income;
        goal.transactions.push(gt);
      }
    }
  }

  return Array.from(goalMap.values()).sort((a, b) =>
    a.categoryTitle.localeCompare(b.categoryTitle)
  );
}
