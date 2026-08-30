import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Goal, GoalTarget, ZenReminder } from '../../../src/types/zenmoney';
import { computeGoalProgress, reminderDayOfMonth } from '../../../src/utils/goalMath';
import type { ZenStore } from '../store';
import { ZenError } from '../store';
import { jsonTool } from '../result';

export function describeReminder(reminder: ZenReminder, isTransfer: boolean) {
  return {
    id: reminder.id,
    dayOfMonth: reminderDayOfMonth(reminder),
    amount: reminder.income,
    type: isTransfer ? 'transfer' : 'income',
    sourceAccountId: isTransfer ? reminder.outcomeAccount : null,
    startDate: reminder.startDate,
    // Where the recurrence stops; null means it runs indefinitely.
    endDate: reminder.endDate,
    interval: reminder.interval,
  };
}

export function summarizeGoal(
  goal: Goal,
  target: GoalTarget | null,
  periodStart: string,
  reminder: ZenReminder | null,
  suggestedReminder: ZenReminder | null
) {
  const progress = computeGoalProgress(goal, target, periodStart);
  return {
    categoryId: goal.categoryId,
    categoryTitle: goal.categoryTitle,
    saved: goal.amount,
    transactionCount: goal.transactions.length,
    target: target ?? null,
    thisMonthAdded: progress.thisMonthAdded,
    monthlyNeeded: progress.monthlyNeeded,
    nextMonthNeeded: progress.nextMonthNeeded,
    leftAmount: progress.leftAmount,
    monthlyStatus: progress.monthlyStatus,
    reminder: reminder
      ? describeReminder(reminder, reminder.incomeAccount !== reminder.outcomeAccount)
      : null,
    suggestedReminder: suggestedReminder
      ? describeReminder(suggestedReminder, suggestedReminder.incomeAccount !== suggestedReminder.outcomeAccount)
      : null,
  };
}

export function registerGoalTools(server: McpServer, store: ZenStore): void {
  server.registerTool(
    'zen_list_goals',
    {
      title: 'List goals',
      description:
        'Goals for the selected wallet: amount saved, target, what is still needed this month and the linked monthly reminder. This is the main view of the app.',
      inputSchema: {
        includeEmpty: z
          .boolean()
          .optional()
          .describe('Keep goals with no transactions and no target (default true)'),
      },
    },
    jsonTool(async ({ includeEmpty = true }) => {
      await store.ensureData();
      const { goals, feed } = store.computeGoalsView();
      const targets = store.goalTargets();
      const periodStart = store.currentPeriodStart();
      const reminderMap = store.goalReminderMap();
      const suggestedMap = store.suggestedReminderMap(goals);

      const summaries = goals
        .filter((goal) => includeEmpty || goal.transactions.length > 0 || targets[goal.categoryId])
        .map((goal) =>
          summarizeGoal(
            goal,
            targets[goal.categoryId] ?? null,
            periodStart,
            reminderMap.get(goal.categoryId) ?? null,
            suggestedMap.get(goal.categoryId) ?? null
          )
        );

      const thisMonthAddings = feed
        .filter((item) => item.amount > 0 && item.date >= periodStart)
        .reduce((sum, item) => sum + item.amount, 0);

      return {
        wallet: {
          id: store.requireWalletId(),
          currency: store.currencySymbol(),
        },
        currentPeriodStart: periodStart,
        totalSaved: summaries.reduce((sum, g) => sum + g.saved, 0),
        thisMonthAddings,
        unassignedTransactions: feed.filter((item) => item.goalId === null).length,
        pendingUnsavedChanges: store.hasPendingChanges(),
        goals: summaries,
      };
    })
  );

  server.registerTool(
    'zen_get_goal',
    {
      title: 'Goal details',
      description:
        'One goal with its attributed transactions, newest first. Accepts a category id or exact title.',
      inputSchema: {
        category: z.string().min(1).describe('Category id or exact category title'),
        limit: z.number().int().positive().max(500).optional().describe('Max transactions (default 50)'),
      },
    },
    jsonTool(async ({ category, limit = 50 }) => {
      await store.ensureData();
      const tag = store.findTag(category);
      const { goals } = store.computeGoalsView();
      const goal = goals.find((g) => g.categoryId === tag.id);
      if (!goal) {
        throw new ZenError(
          `Category "${tag.title}" has no transactions in this wallet. Use zen_pin_goal_category to track it as an empty goal.`
        );
      }

      const targets = store.goalTargets();
      const periodStart = store.currentPeriodStart();
      const summary = summarizeGoal(
        goal,
        targets[goal.categoryId] ?? null,
        periodStart,
        store.goalReminderMap().get(goal.categoryId) ?? null,
        store.suggestedReminderMap(goals).get(goal.categoryId) ?? null
      );

      const transactions = [...goal.transactions]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);

      return {
        ...summary,
        currency: store.currencySymbol(),
        transactions,
      };
    })
  );

  server.registerTool(
    'zen_set_goal_target',
    {
      title: 'Set goal target',
      description:
        'Stages a savings target for a category. Call zen_save to push it to ZenMoney. Pass clear=true to remove the target.',
      inputSchema: {
        category: z.string().min(1).describe('Category id or exact category title'),
        clear: z.boolean().optional().describe('Remove the target instead of setting one'),
        type: z
          .enum(['one_time', 'recurring', 'fixed_monthly'])
          .optional()
          .describe(
            'one_time (default): save `amount` by `date`. recurring: the same, repeating. fixed_monthly: put `amount` aside every month'
          ),
        amount: z.number().optional().describe('Target amount, in the wallet currency'),
        date: z.string().optional().describe('Target date, YYYY-MM-DD (one_time and recurring)'),
        repeatEvery: z.number().int().positive().optional().describe('Recurring interval count'),
        repeatUnit: z.enum(['days', 'months']).optional().describe('Recurring interval unit'),
      },
    },
    jsonTool(async (args) => {
      await store.ensureData();
      const tag = store.findTag(args.category);

      if (args.clear) {
        await store.setGoalTarget(tag.id, null);
        return { categoryId: tag.id, categoryTitle: tag.title, target: null, staged: true };
      }

      if (typeof args.amount !== 'number') {
        throw new ZenError('amount is required unless clear=true');
      }

      const type = args.type ?? 'one_time';
      if (type !== 'fixed_monthly' && !args.date) {
        throw new ZenError(`A ${type} target needs a date (YYYY-MM-DD)`);
      }

      const target: GoalTarget = {
        type,
        amount: args.amount,
        ...(args.date ? { date: args.date } : {}),
        ...(args.repeatEvery ? { repeatEvery: args.repeatEvery } : {}),
        ...(args.repeatUnit ? { repeatUnit: args.repeatUnit } : {}),
      };

      await store.setGoalTarget(tag.id, target);
      return {
        categoryId: tag.id,
        categoryTitle: tag.title,
        target,
        staged: true,
        nextStep: 'Call zen_save to store the target in ZenMoney.',
      };
    })
  );

  server.registerTool(
    'zen_pin_goal_category',
    {
      title: 'Pin category as goal',
      description:
        'Shows a category as a goal even when it has no transactions yet — the "Add goal" button of the app. Stored locally.',
      inputSchema: {
        category: z.string().min(1).describe('Category id or exact category title'),
      },
    },
    jsonTool(async ({ category }) => {
      await store.ensureData();
      const tag = store.findTag(category);
      await store.pinGoalCategory(tag.id);
      return { pinned: store.pinnedGoalCategories, categoryId: tag.id, categoryTitle: tag.title };
    })
  );

  server.registerTool(
    'zen_unpin_goal_category',
    {
      title: 'Unpin category',
      description: 'Stops showing an empty category as a goal.',
      inputSchema: {
        category: z.string().min(1).describe('Category id or exact category title'),
      },
    },
    jsonTool(async ({ category }) => {
      await store.ensureData();
      const tag = store.findTag(category);
      await store.unpinGoalCategory(tag.id);
      return { pinned: store.pinnedGoalCategories, categoryId: tag.id, categoryTitle: tag.title };
    })
  );
}
