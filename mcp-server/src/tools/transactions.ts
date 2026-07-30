import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isTransferTransaction } from '../../../src/utils/goals';
import { findSameReminderUnassignedTransactions } from '../../../src/utils/goalReminders';
import type { ZenStore } from '../store';
import { ZenError } from '../store';
import { jsonTool } from '../result';

export function registerTransactionTools(server: McpServer, store: ZenStore): void {
  server.registerTool(
    'zen_list_feed',
    {
      title: 'List wallet feed',
      description:
        'Transactions of the selected wallet with the goal each one is attributed to, newest first. Filter by goal, by "unassigned", by text or by direction — the feed of the app.',
      inputSchema: {
        goal: z
          .string()
          .optional()
          .describe('Category id or exact title to filter by; use "unassigned" for items with no goal'),
        search: z.string().optional().describe('Case-insensitive text match on goal, comment, payee or amount'),
        direction: z.enum(['income', 'spending']).optional().describe('Keep only money in or money out'),
        from: z.string().optional().describe('Earliest date, YYYY-MM-DD'),
        to: z.string().optional().describe('Latest date, YYYY-MM-DD'),
        limit: z.number().int().positive().max(500).optional().describe('Max items (default 50)'),
        offset: z.number().int().nonnegative().optional().describe('Items to skip (default 0)'),
      },
    },
    jsonTool(async ({ goal, search, direction, from, to, limit = 50, offset = 0 }) => {
      await store.ensureData();
      const { feed } = store.computeGoalsView();
      const pendingCategories = store.pendingCategoryChanges;
      const pendingAssignments = store.pendingManualAssignments;

      let items = feed;

      if (goal) {
        if (goal.trim().toLowerCase() === 'unassigned') {
          items = items.filter((item) => item.goalId === null);
        } else {
          const tag = store.findTag(goal);
          items = items.filter((item) => item.goalId === tag.id);
        }
      }
      if (direction) items = items.filter((item) => item.direction === direction);
      if (from) items = items.filter((item) => item.date >= from);
      if (to) items = items.filter((item) => item.date <= to);

      if (search?.trim()) {
        const query = search.trim().toLowerCase();
        items = items.filter((item) => {
          const abs = Math.abs(item.amount);
          return (
            item.goalTitle?.toLowerCase().includes(query) ||
            item.comment?.toLowerCase().includes(query) ||
            item.payee?.toLowerCase().includes(query) ||
            abs.toFixed(2).includes(query) ||
            String(Math.round(abs)).includes(query)
          );
        });
      }

      const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
      const page = sorted.slice(offset, offset + limit);

      return {
        currency: store.currencySymbol(),
        total: sorted.length,
        offset,
        limit,
        items: page.map((item) => ({
          transactionId: item.transactionId,
          date: item.date,
          amount: item.amount,
          direction: item.direction,
          goalId: item.goalId,
          goalTitle: item.goalTitle,
          source: item.source,
          isTransfer: item.isTransfer,
          payee: item.payee,
          comment: item.comment,
          pendingCategoryId:
            item.transactionId in pendingCategories
              ? pendingCategories[item.transactionId]
              : item.transactionId in pendingAssignments
                ? pendingAssignments[item.transactionId]
                : undefined,
        })),
      };
    })
  );

  server.registerTool(
    'zen_assign_transactions',
    {
      title: 'Assign transactions to a goal',
      description:
        'Stages a goal category for one or more transactions. Transfers are recorded as app-side assignments (ZenMoney rejects categories on transfers), other transactions get their category changed. Call zen_save to push everything.',
      inputSchema: {
        transactionIds: z.array(z.string().min(1)).min(1).describe('Transaction ids, as returned by zen_list_feed'),
        category: z
          .string()
          .optional()
          .describe('Category id or exact title. Omit (or pass clear=true) to remove the assignment'),
        clear: z.boolean().optional().describe('Remove the goal assignment instead of setting one'),
      },
    },
    jsonTool(async ({ transactionIds, category, clear }) => {
      await store.ensureData();

      let tagId: string | null = null;
      let tagTitle: string | null = null;
      if (!clear) {
        if (!category) throw new ZenError('Pass a category, or clear=true to unassign');
        const tag = store.findTag(category);
        tagId = tag.id;
        tagTitle = tag.title;
      }

      const result = await store.assignTransactions(transactionIds, tagId);

      return {
        categoryId: tagId,
        categoryTitle: tagTitle,
        staged: {
          transfers: result.transfers.length,
          categoryChanges: result.regular.length,
        },
        unknownTransactionIds: result.unknown,
        pendingUnsavedChanges: store.hasPendingChanges(),
        nextStep: 'Call zen_save to push the changes to ZenMoney.',
      };
    })
  );

  server.registerTool(
    'zen_suggest_bulk_assignment',
    {
      title: 'Find sibling transactions',
      description:
        'Given one transaction, finds the other still-unassigned transactions created by the same recurring reminder — so a whole series can be assigned in one go.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction id to start from'),
      },
    },
    jsonTool(async ({ transactionId }) => {
      await store.ensureData();
      const { feed } = store.computeGoalsView();
      const transactionMap = store.transactionMap();
      if (!transactionMap.has(transactionId)) {
        throw new ZenError(`No transaction with id ${transactionId}`);
      }

      const related = findSameReminderUnassignedTransactions({
        transactionId,
        feed,
        transactionMap,
        markerToReminderId: store.markerToReminderId(),
        manualAssignments: store.manualAssignments(),
      });

      if (!related) {
        return {
          transactionId,
          reminderId: null,
          transactionIds: [],
          note: 'This transaction was not created by a reminder, so it has no series.',
        };
      }

      const feedById = new Map(feed.map((item) => [item.transactionId, item]));
      return {
        transactionId,
        reminderId: related.reminderId,
        reminderMarker: related.reminderMarker,
        transactionIds: related.transactionIds,
        transactions: related.transactionIds.map((id) => {
          const item = feedById.get(id);
          return { transactionId: id, date: item?.date ?? null, amount: item?.amount ?? null };
        }),
      };
    })
  );

  server.registerTool(
    'zen_pending_changes',
    {
      title: 'List unsaved changes',
      description: 'Shows the goal assignments, category changes and targets staged locally but not yet pushed to ZenMoney.',
      inputSchema: {},
    },
    jsonTool(async () => {
      await store.ensureData();
      const transactions = store.transactionMap();
      const tags = new Map(store.requireData().tags.map((t) => [t.id, t.title]));

      const describe = (txId: string, tagId: string | null) => {
        const tx = transactions.get(txId);
        return {
          transactionId: txId,
          date: tx?.date ?? null,
          amount: tx ? (isTransferTransaction(tx) ? tx.income : tx.income - tx.outcome) : null,
          categoryId: tagId,
          categoryTitle: tagId ? tags.get(tagId) ?? null : null,
        };
      };

      return {
        manualAssignments: Object.entries(store.pendingManualAssignments).map(([id, tagId]) =>
          describe(id, tagId)
        ),
        categoryChanges: Object.entries(store.pendingCategoryChanges).map(([id, tagId]) =>
          describe(id, tagId)
        ),
        goalTargets: Object.entries(store.pendingGoalTargets).map(([tagId, target]) => ({
          categoryId: tagId,
          categoryTitle: tags.get(tagId) ?? null,
          target,
        })),
        hasPendingChanges: store.hasPendingChanges(),
      };
    })
  );

  server.registerTool(
    'zen_save',
    {
      title: 'Save to ZenMoney',
      description:
        'Pushes staged goal assignments, targets and category changes to ZenMoney (assignments and targets live in the hidden [One-Zenwallet Data] account), then re-syncs.',
      inputSchema: {},
    },
    jsonTool(async () => {
      await store.ensureData();
      if (!store.hasPendingChanges()) {
        return { saved: false, note: 'Nothing to save.' };
      }
      const result = await store.save();
      return {
        saved: true,
        storedAssignments: result.assignments,
        storedTargets: result.targets,
        updatedTransactions: result.transactionUpdates,
        unpinnedEmptyGoals: result.unpinned,
      };
    })
  );

  server.registerTool(
    'zen_discard_changes',
    {
      title: 'Discard unsaved changes',
      description: 'Throws away every locally staged assignment, category change and target.',
      inputSchema: {},
    },
    jsonTool(async () => {
      await store.discardPendingChanges();
      return { discarded: true };
    })
  );
}
