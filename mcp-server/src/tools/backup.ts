import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildBackupFileName,
  createZenBackupSnapshot,
  restoreZenBackup,
} from '../../../src/utils/backupRestore';
import { getStateDir } from '../state';
import type { ZenStore } from '../store';
import { ZenError } from '../store';
import { jsonTool } from '../result';

export function registerBackupTools(server: McpServer, store: ZenStore): void {
  server.registerTool(
    'zen_create_backup',
    {
      title: 'Create backup',
      description:
        'Downloads a full ZenMoney snapshot and writes it as a JSON backup file. Defaults to a timestamped file in the backups folder of the server state directory.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Destination file or directory. Defaults to <state dir>/backups'),
      },
    },
    jsonTool(async (args) => {
      const token = store.requireToken();
      const now = new Date();
      const envelope = await createZenBackupSnapshot(token, now);
      const defaultName = buildBackupFileName(now);

      let target: string;
      if (!args.path) {
        target = path.join(getStateDir(), 'backups', defaultName);
      } else {
        const resolved = path.resolve(args.path);
        const isDirectory = await fs
          .stat(resolved)
          .then((stat) => stat.isDirectory())
          .catch(() => false);
        target = isDirectory || !path.extname(resolved)
          ? path.join(resolved, defaultName)
          : resolved;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(envelope, null, 2), { mode: 0o600 });

      const counts = Object.fromEntries(
        Object.entries(envelope.snapshot)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, (value as unknown[]).length])
      );

      return {
        path: target,
        createdAt: envelope.createdAt,
        version: envelope.version,
        serverTimestamp: envelope.snapshot.serverTimestamp,
        counts,
      };
    })
  );

  server.registerTool(
    'zen_restore_backup',
    {
      title: 'Restore backup',
      description:
        'DESTRUCTIVE. Re-uploads every entity of a backup file to ZenMoney under fresh ids and deletes all existing categories and budgets first. Requires confirm=true.',
      inputSchema: {
        path: z.string().min(1).describe('Path to a backup JSON file created by zen_create_backup'),
        confirm: z
          .boolean()
          .describe('Must be true. Restoring rewrites the ZenMoney account and cannot be undone'),
        chunkSize: z.number().int().positive().max(500).optional().describe('Entities per request (default 100)'),
      },
    },
    jsonTool(async ({ path: filePath, confirm, chunkSize }) => {
      if (!confirm) {
        throw new ZenError(
          'Restore refused: pass confirm=true. This deletes all existing categories and budgets and re-uploads the backup.'
        );
      }

      const token = store.requireToken();
      const data = await store.ensureData();
      const resolved = path.resolve(filePath);
      const backupText = await fs.readFile(resolved, 'utf8').catch(() => {
        throw new ZenError(`Cannot read backup file at ${resolved}`);
      });

      await restoreZenBackup({
        token,
        currentServerTimestamp: data.serverTimestamp,
        backupText,
        currentUserId: data.accounts.find((a) => !a.archive)?.user ?? data.accounts[0]?.user,
        chunkSize,
      });

      const synced = await store.sync({ full: true });
      return {
        restored: true,
        path: resolved,
        serverTimestamp: synced.serverTimestamp,
        counts: {
          accounts: synced.accounts.length,
          tags: synced.tags.length,
          transactions: synced.transactions.length,
          reminders: synced.reminders.length,
        },
      };
    })
  );
}
