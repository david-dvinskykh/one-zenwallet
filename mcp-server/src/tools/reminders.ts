import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  applyGoalReminderConfig,
  buildGoalReminder,
  buildReminderMarkers,
  syncReminderMarkers,
  type GoalReminderConfig,
} from '../../../src/utils/goalReminders';
import { reminderDayOfMonth } from '../../../src/utils/goalMath';
import type { ZenStore } from '../store';
import { ZenError } from '../store';
import { jsonTool } from '../result';
import { describeReminder } from './goals';

const reminderConfigShape = {
  type: z
    .enum(['transfer', 'income'])
    .describe('transfer: money moves from another account into the wallet. income: money appears on the wallet itself'),
  sourceAccount: z
    .string()
    .optional()
    .describe('Account id or exact title money is transferred from (required for type=transfer)'),
  dayOfMonth: z.number().int().min(1).max(31).describe('Day of the month the reminder fires'),
  amount: z.number().positive().describe('Amount per month, in the wallet currency'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD')
    .nullish()
    .describe(
      'Date the reminder stops repeating (YYYY-MM-DD). Defaults to the goal target date, so the transfers stop when the goal is due; pass null for a reminder with no end. Ignored when it falls before the first run.'
    ),
};

export function registerReminderTools(server: McpServer, store: ZenStore): void {
  /**
   * The reminder's end date: what the caller asked for, or — when it said
   * nothing — the goal's own target date, so a funding transfer stops when the
   * goal it funds is due instead of running on for ever.
   */
  function resolveEndDate(
    endDate: string | null | undefined,
    categoryId: string | null
  ): string | null {
    if (endDate !== undefined) return endDate;
    if (!categoryId) return null;
    return store.goalTargets()[categoryId]?.date ?? null;
  }

  function resolveConfig(
    args: {
      type: 'transfer' | 'income';
      sourceAccount?: string;
      dayOfMonth: number;
      amount: number;
      endDate?: string | null;
    },
    categoryId: string | null
  ): { config: GoalReminderConfig; sourceInstrument: number } {
    const walletId = store.requireWalletId();
    const wallet = store.findAccount(walletId);
    const endDate = resolveEndDate(args.endDate, categoryId);

    if (args.type === 'income') {
      return {
        config: {
          type: 'income',
          sourceAccountId: walletId,
          dayOfMonth: args.dayOfMonth,
          amount: args.amount,
          endDate,
        },
        sourceInstrument: wallet.instrument,
      };
    }

    if (!args.sourceAccount) {
      throw new ZenError('sourceAccount is required when type is "transfer"');
    }
    const source = store.findAccount(args.sourceAccount);
    if (source.id === walletId) {
      throw new ZenError('A transfer reminder needs a source account other than the wallet itself');
    }
    return {
      config: {
        type: 'transfer',
        sourceAccountId: source.id,
        dayOfMonth: args.dayOfMonth,
        amount: args.amount,
        endDate,
      },
      sourceInstrument: source.instrument,
    };
  }

  server.registerTool(
    'zen_list_goal_reminders',
    {
      title: 'List goal reminders',
      description:
        'Monthly reminders that fund goals: the one linked to each goal, the one this app would suggest, and monthly reminders not linked to any goal yet.',
      inputSchema: {},
    },
    jsonTool(async () => {
      const data = await store.ensureData();
      const { goals } = store.computeGoalsView();
      const linked = store.goalReminderMap();
      const suggested = store.suggestedReminderMap(goals);
      const accountTitles = new Map(data.accounts.map((a) => [a.id, a.title]));
      const dataAccountId = store.dataAccountId();
      const linkedIds = new Set([...linked.values()].map((r) => r.id));

      const withAccounts = (reminder: ReturnType<typeof describeReminder>) => ({
        ...reminder,
        sourceAccountTitle: reminder.sourceAccountId
          ? accountTitles.get(reminder.sourceAccountId) ?? null
          : null,
      });

      const unlinked = data.reminders
        .filter((r) => !r.deleted && r.interval === 'month' && !linkedIds.has(r.id))
        .filter((r) => r.incomeAccount !== dataAccountId && r.outcomeAccount !== dataAccountId)
        .map((r) => ({
          ...withAccounts(describeReminder(r, r.incomeAccount !== r.outcomeAccount)),
          incomeAccountTitle: accountTitles.get(r.incomeAccount) ?? null,
          tags: r.tag,
        }));

      return {
        goals: goals.map((goal) => {
          const reminder = linked.get(goal.categoryId) ?? null;
          const suggestion = suggested.get(goal.categoryId) ?? null;
          return {
            categoryId: goal.categoryId,
            categoryTitle: goal.categoryTitle,
            reminder: reminder
              ? withAccounts(describeReminder(reminder, reminder.incomeAccount !== reminder.outcomeAccount))
              : null,
            suggestedReminder: suggestion
              ? withAccounts(describeReminder(suggestion, suggestion.incomeAccount !== suggestion.outcomeAccount))
              : null,
          };
        }),
        unlinkedMonthlyReminders: unlinked,
      };
    })
  );

  server.registerTool(
    'zen_create_goal_reminder',
    {
      title: 'Create goal reminder',
      description:
        'Creates a monthly ZenMoney reminder that funds a goal. Replaces the goal\'s existing reminder if it already has one. Transfer reminders are linked to the goal through the app\'s hidden data, since ZenMoney does not allow categories on transfers.',
      inputSchema: {
        category: z.string().min(1).describe('Category id or exact category title'),
        ...reminderConfigShape,
      },
    },
    jsonTool(async (args) => {
      const data = await store.ensureData();
      const walletId = store.requireWalletId();
      const wallet = store.findAccount(walletId);
      const tag = store.findTag(args.category);
      const { config, sourceInstrument } = resolveConfig(args, tag.id);

      const now = store.nextChanged();
      const reminder = buildGoalReminder({
        categoryId: tag.id,
        categoryTitle: tag.title,
        config,
        walletId,
        walletInstrument: wallet.instrument,
        sourceInstrument,
        userId: data.user?.id ?? 0,
        now,
      });

      const existing = store.goalReminderMap().get(tag.id);
      await store.push({
        reminder: existing
          ? [{ ...existing, deleted: true, changed: store.nextChanged(existing.changed) }, reminder]
          : [reminder],
        // ZenMoney does not expand the recurrence itself — see buildReminderMarkers.
        reminderMarker: buildReminderMarkers({ reminder, now }),
      });

      if (config.type === 'transfer') {
        await store.syncGoalReminderLinks({
          ...store.goalReminderLinks(),
          [tag.id]: reminder.id,
        });
      }

      await store.sync();
      return {
        created: describeReminder(reminder, config.type === 'transfer'),
        categoryId: tag.id,
        categoryTitle: tag.title,
        replacedReminderId: existing?.id ?? null,
      };
    })
  );

  server.registerTool(
    'zen_update_goal_reminder',
    {
      title: 'Update goal reminder',
      description: 'Changes the amount, day of month or funding account of an existing monthly reminder.',
      inputSchema: {
        reminderId: z.string().min(1).describe('Reminder id, from zen_list_goal_reminders'),
        ...reminderConfigShape,
      },
    },
    jsonTool(async (args) => {
      const data = await store.ensureData();
      const reminder = data.reminders.find((r) => r.id === args.reminderId && !r.deleted);
      if (!reminder) throw new ZenError(`No reminder with id ${args.reminderId}`);

      const links = store.goalReminderLinks();
      const linkedCategoryId = Object.entries(links).find(([, rid]) => rid === reminder.id)?.[0];
      const categoryId = linkedCategoryId ?? reminder.tag?.[0] ?? null;

      const { config, sourceInstrument } = resolveConfig(args, categoryId);
      const isTransfer = config.type === 'transfer';

      const walletId = store.requireWalletId();
      const wallet = store.findAccount(walletId);
      const base = applyGoalReminderConfig(
        reminder,
        config,
        {
          walletId,
          walletInstrument: wallet.instrument,
          sourceInstrument: isTransfer ? sourceInstrument : null,
          categoryTitle: categoryId ? store.findTag(categoryId).title : undefined,
        },
        store.nextChanged(reminder.changed)
      );
      // A transfer cannot carry its goal as a tag, so the association lives in
      // the goalReminders map instead. Switching type has to move it across.
      const updated =
        !isTransfer && categoryId
          ? { ...base, tag: Array.from(new Set([...(base.tag ?? []), categoryId])) }
          : base;

      await store.push({
        reminder: [updated],
        // Rewrites the occurrences in place and cancels the ones that fall past
        // a newly shortened end date — see syncReminderMarkers.
        reminderMarker: syncReminderMarkers({
          reminder: updated,
          now: updated.changed,
          markers: data.reminderMarkers,
        }),
      });
      if (categoryId && isTransfer !== (links[categoryId] === reminder.id)) {
        const next = { ...links };
        if (isTransfer) next[categoryId] = reminder.id;
        else delete next[categoryId];
        await store.syncGoalReminderLinks(next);
      }
      await store.sync();
      return { updated: describeReminder(updated, isTransfer) };
    })
  );

  server.registerTool(
    'zen_delete_goal_reminder',
    {
      title: 'Delete goal reminder',
      description:
        'Deletes a reminder. A transfer reminder that is only linked to a goal for display is unlinked instead of deleted, leaving the ZenMoney reminder untouched.',
      inputSchema: {
        reminderId: z.string().min(1).describe('Reminder id, from zen_list_goal_reminders'),
      },
    },
    jsonTool(async ({ reminderId }) => {
      const data = await store.ensureData();
      const links = store.goalReminderLinks();
      const linkedTag = Object.entries(links).find(([, rid]) => rid === reminderId)?.[0];

      if (linkedTag) {
        const rest = { ...links };
        delete rest[linkedTag];
        await store.syncGoalReminderLinks(rest);
        await store.sync();
        return { unlinked: true, deleted: false, reminderId, categoryId: linkedTag };
      }

      const reminder = data.reminders.find((r) => r.id === reminderId && !r.deleted);
      if (!reminder) throw new ZenError(`No reminder with id ${reminderId}`);

      await store.push({
        reminder: [{ ...reminder, deleted: true, changed: store.nextChanged(reminder.changed) }],
      });
      await store.sync();
      return { unlinked: false, deleted: true, reminderId };
    })
  );

  server.registerTool(
    'zen_link_goal_reminder',
    {
      title: 'Link reminder to goal',
      description:
        'Associates an existing monthly reminder with a goal. Non-transfer reminders get the category added; transfer reminders are linked through the app\'s hidden data.',
      inputSchema: {
        reminderId: z.string().min(1).describe('Reminder id, from zen_list_goal_reminders'),
        category: z.string().min(1).describe('Category id or exact category title'),
      },
    },
    jsonTool(async ({ reminderId, category }) => {
      const data = await store.ensureData();
      const reminder = data.reminders.find((r) => r.id === reminderId && !r.deleted);
      if (!reminder) throw new ZenError(`No reminder with id ${reminderId}`);
      const tag = store.findTag(category);

      const isTransfer = reminder.incomeAccount !== reminder.outcomeAccount;
      if (isTransfer) {
        await store.syncGoalReminderLinks({ ...store.goalReminderLinks(), [tag.id]: reminder.id });
        await store.sync();
        return {
          linked: true,
          via: 'hidden-data',
          reminderId,
          dayOfMonth: reminderDayOfMonth(reminder),
          categoryId: tag.id,
          categoryTitle: tag.title,
        };
      }

      const tags = Array.from(new Set([...(reminder.tag ?? []), tag.id]));
      await store.push({
        reminder: [{ ...reminder, tag: tags, changed: store.nextChanged(reminder.changed) }],
      });
      await store.sync();
      return {
        linked: true,
        via: 'reminder-tag',
        reminderId,
        dayOfMonth: reminderDayOfMonth(reminder),
        categoryId: tag.id,
        categoryTitle: tag.title,
      };
    })
  );
}
