#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ZenStore } from './store';
import { registerSessionTools } from './tools/session';
import { registerWalletTools } from './tools/wallets';
import { registerGoalTools } from './tools/goals';
import { registerTransactionTools } from './tools/transactions';
import { registerReminderTools } from './tools/reminders';
import { registerBackupTools } from './tools/backup';

const INSTRUCTIONS = `One-Zenwallet exposes the savings-goal workflow of the One-Zenwallet app on top of a ZenMoney account.

Typical flow:
1. zen_login (or set ZENMONEY_TOKEN) -> zen_list_wallets -> zen_select_wallet.
2. zen_list_goals / zen_get_goal / zen_list_feed to read the current state.
3. zen_assign_transactions and zen_set_goal_target stage changes locally; zen_save pushes them to ZenMoney.
4. Reminder tools write to ZenMoney immediately, no save needed.

A goal is a ZenMoney category (tag). Transactions are attributed to a goal by, in order: an app-side manual
assignment, the transaction's own category, the comment of an incoming transfer, or an account linked to the goal.
Manual assignments and targets are stored inside ZenMoney itself, in a hidden archived account named
[One-Zenwallet Data], so they follow the account across devices.`;

async function main(): Promise<void> {
  const store = await ZenStore.load();

  const server = new McpServer(
    { name: 'one-zenwallet', version: '1.0.0' },
    { instructions: INSTRUCTIONS }
  );

  registerSessionTools(server, store);
  registerWalletTools(server, store);
  registerGoalTools(server, store);
  registerTransactionTools(server, store);
  registerReminderTools(server, store);
  registerBackupTools(server, store);

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  // stdout carries the protocol, so diagnostics go to stderr.
  console.error('one-zenwallet MCP server failed to start:', error);
  process.exit(1);
});
