import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GoalTarget } from '../../src/types/zenmoney';
import type { ZenData } from '../../src/utils/zenData';

/**
 * Node-side equivalent of the web app's localStorage + IndexedDB tiers:
 * small scalars in `state.json`, the full ZenMoney snapshot in `cache.json`.
 */
export interface PersistedState {
  token: string | null;
  selectedWalletId: string | null;
  serverTimestamp: number;
  pinnedGoalCategories: string[];
  /** transaction id -> tag id, or null to drop a cloud assignment. Staged until `zen_save`. */
  pendingManualAssignments: Record<string, string | null>;
  /** transaction id -> tag id (null clears the category). Staged until `zen_save`. */
  pendingCategoryChanges: Record<string, string | null>;
  /** tag id -> target, or null to delete it. Staged until `zen_save`. */
  pendingGoalTargets: Record<string, GoalTarget | null>;
}

export function emptyState(): PersistedState {
  return {
    token: null,
    selectedWalletId: null,
    serverTimestamp: 0,
    pinnedGoalCategories: [],
    pendingManualAssignments: {},
    pendingCategoryChanges: {},
    pendingGoalTargets: {},
  };
}

export function getStateDir(): string {
  const configured = process.env.ONE_ZENWALLET_MCP_STATE_DIR;
  if (configured && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.one-zenwallet-mcp');
}

const STATE_FILE = 'state.json';
const CACHE_FILE = 'cache.json';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(getStateDir(), file), 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown, mode: number): Promise<void> {
  const dir = getStateDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, file);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode });
  await fs.rename(temp, target);
}

export async function readState(): Promise<PersistedState> {
  const stored = await readJson<Partial<PersistedState>>(STATE_FILE);
  return { ...emptyState(), ...(stored ?? {}) };
}

// The token lives here, so keep the file owner-only.
export async function writeState(state: PersistedState): Promise<void> {
  await writeJson(STATE_FILE, state, 0o600);
}

export async function readCache(): Promise<ZenData | null> {
  return readJson<ZenData>(CACHE_FILE);
}

export async function writeCache(data: ZenData): Promise<void> {
  await writeJson(CACHE_FILE, data, 0o600);
}

export async function clearPersisted(): Promise<void> {
  const dir = getStateDir();
  await Promise.all(
    [STATE_FILE, CACHE_FILE].map((file) =>
      fs.rm(path.join(dir, file), { force: true })
    )
  );
}
