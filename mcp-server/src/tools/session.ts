import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZenStore } from '../store';
import { getStateDir } from '../state';
import { jsonTool } from '../result';

export function registerSessionTools(server: McpServer, store: ZenStore): void {
  server.registerTool(
    'zen_login',
    {
      title: 'Log in to ZenMoney',
      description:
        'Stores a ZenMoney API token and pulls a full snapshot. Resets any previously cached data, selected wallet and unsaved changes.',
      inputSchema: {
        token: z.string().min(1).describe('ZenMoney API bearer token'),
      },
    },
    jsonTool(async ({ token }) => {
      const data = await store.login(token);
      return {
        loggedIn: true,
        stateDir: getStateDir(),
        serverTimestamp: data.serverTimestamp,
        counts: {
          accounts: data.accounts.length,
          tags: data.tags.length,
          transactions: data.transactions.length,
          reminders: data.reminders.length,
        },
        nextStep: 'Call zen_list_wallets, then zen_select_wallet.',
      };
    })
  );

  server.registerTool(
    'zen_logout',
    {
      title: 'Log out',
      description:
        'Clears the stored token, cached snapshot, selected wallet and any unsaved changes from local state.',
      inputSchema: {},
    },
    jsonTool(async () => {
      await store.logout();
      return { loggedOut: true, stateDir: getStateDir() };
    })
  );

  server.registerTool(
    'zen_status',
    {
      title: 'Session status',
      description:
        'Reports authentication, selected wallet, cache freshness and how many local changes are waiting to be saved.',
      inputSchema: {},
    },
    jsonTool(async () => {
      const authenticated = store.token !== null;
      if (!authenticated) {
        return { authenticated: false, stateDir: getStateDir() };
      }

      const data = await store.ensureData();
      const wallet = store.selectedWalletId
        ? data.accounts.find((a) => a.id === store.selectedWalletId) ?? null
        : null;

      return {
        authenticated: true,
        stateDir: getStateDir(),
        tokenSource: store.tokenSource,
        selectedWallet: wallet ? { id: wallet.id, title: wallet.title } : null,
        serverTimestamp: data.serverTimestamp,
        user: data.user ? { id: data.user.id, login: data.user.login, monthStartDay: data.user.monthStartDay } : null,
        counts: {
          accounts: data.accounts.length,
          tags: data.tags.length,
          transactions: data.transactions.length,
          reminders: data.reminders.length,
          reminderMarkers: data.reminderMarkers.length,
        },
        pendingChanges: {
          manualAssignments: Object.keys(store.pendingManualAssignments).length,
          categoryChanges: Object.keys(store.pendingCategoryChanges).length,
          goalTargets: Object.keys(store.pendingGoalTargets).length,
        },
        pinnedGoalCategories: store.pinnedGoalCategories,
      };
    })
  );

  server.registerTool(
    'zen_sync',
    {
      title: 'Sync with ZenMoney',
      description:
        'Pulls changes from ZenMoney into the local cache. Incremental by default; pass full=true to re-download everything.',
      inputSchema: {
        full: z
          .boolean()
          .optional()
          .describe('Re-download the whole dataset instead of the diff since the last sync'),
      },
    },
    jsonTool(async ({ full }) => {
      const data = await store.sync({ full });
      return {
        synced: true,
        full: Boolean(full),
        serverTimestamp: data.serverTimestamp,
        counts: {
          accounts: data.accounts.length,
          tags: data.tags.length,
          transactions: data.transactions.length,
          reminders: data.reminders.length,
          reminderMarkers: data.reminderMarkers.length,
        },
      };
    })
  );
}
