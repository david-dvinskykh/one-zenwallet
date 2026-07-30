import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZenAccount } from '../../../src/types/zenmoney';
import { isDataAccountTitle } from '../../../src/utils/hiddenData';
import type { ZenStore } from '../store';
import { jsonTool } from '../result';

export function registerWalletTools(server: McpServer, store: ZenStore): void {
  server.registerTool(
    'zen_list_wallets',
    {
      title: 'List wallets',
      description:
        'Lists the accounts that can be tracked as a wallet, grouped by type with balances — the wallet picker of the app. Archived and debt accounts are hidden unless requested.',
      inputSchema: {
        includeArchived: z.boolean().optional().describe('Include archived accounts'),
        includeDebt: z.boolean().optional().describe('Include debt accounts'),
      },
    },
    jsonTool(async ({ includeArchived, includeDebt }) => {
      const data = await store.ensureData();
      const instruments = new Map(data.instruments.map((i) => [i.id, i]));

      const accounts = data.accounts.filter((a) => {
        if (!includeArchived && a.archive) return false;
        if (!includeDebt && a.type === 'debt') return false;
        return true;
      });

      const describe = (account: ZenAccount) => ({
        id: account.id,
        title: account.title,
        type: account.type,
        balance: account.balance,
        currency: instruments.get(account.instrument)?.symbol ?? '',
        archive: account.archive,
        savings: account.savings,
        isSelected: account.id === store.selectedWalletId,
        isHiddenDataAccount: account.archive && isDataAccountTitle(account.title),
      });

      const groups: Record<string, ReturnType<typeof describe>[]> = {};
      for (const account of accounts) {
        const type = account.type || 'other';
        (groups[type] ??= []).push(describe(account));
      }

      return {
        selectedWalletId: store.selectedWalletId,
        totalAccounts: accounts.length,
        groups,
      };
    })
  );

  server.registerTool(
    'zen_select_wallet',
    {
      title: 'Select wallet',
      description:
        'Picks the wallet all goal tools operate on. Accepts an account id or an exact account title. The choice is remembered between calls.',
      inputSchema: {
        wallet: z.string().min(1).describe('Account id or exact account title'),
      },
    },
    jsonTool(async ({ wallet }) => {
      await store.ensureData();
      const account = store.findAccount(wallet);
      await store.selectWallet(account.id);
      return {
        selected: {
          id: account.id,
          title: account.title,
          type: account.type,
          balance: account.balance,
          currency: store.currencySymbol(account.id),
        },
      };
    })
  );

  server.registerTool(
    'zen_list_categories',
    {
      title: 'List categories',
      description:
        'Lists ZenMoney categories (tags). Each category can be used as a savings goal. Optionally filtered by a title substring.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring of the category title'),
      },
    },
    jsonTool(async ({ search }) => {
      const data = await store.ensureData();
      const titleById = new Map(data.tags.map((t) => [t.id, t.title]));
      const query = search?.trim().toLowerCase();

      const categories = data.tags
        .filter((tag) => !query || tag.title.toLowerCase().includes(query))
        .map((tag) => ({
          id: tag.id,
          title: tag.title,
          parent: tag.parent,
          parentTitle: tag.parent ? titleById.get(tag.parent) ?? null : null,
          showIncome: tag.showIncome,
          showOutcome: tag.showOutcome,
        }))
        .sort((a, b) => a.title.localeCompare(b.title));

      return { total: categories.length, categories };
    })
  );
}
