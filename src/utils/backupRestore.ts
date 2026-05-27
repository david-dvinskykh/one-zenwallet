import { fetchZenmoneyDiff, pushZenmoneyDiff } from '../api/zenmoney';

const BACKUP_FILE_VERSION = 1;
const REMOVE_ALL_EXISTING_TAGS_BEFORE_RESTORE = true;
const IGNORED_RESTORE_ENTITY_KEYS = new Set([
  'user',
  'instrument', 
  'company',
  'country',
  'deleted',
]);

interface BackupFileEnvelope {
  version: number;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

function buildBackupFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `one-zenwallet-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

function downloadJsonFile(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== 'undefined' &&
    value !== 'null'
  );
}

function parseBackupEnvelope(rawText: string): BackupFileEnvelope {
  const parsed = JSON.parse(rawText) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Backup file must be a JSON object');
  }

  const snapshot = isRecord(parsed.snapshot)
    ? parsed.snapshot
    : parsed;

  if (typeof snapshot.serverTimestamp !== 'number') {
    throw new Error('Backup file has invalid format: serverTimestamp is missing');
  }

  return {
    version:
      typeof parsed.version === 'number' ? parsed.version : BACKUP_FILE_VERSION,
    createdAt:
      typeof parsed.createdAt === 'string'
        ? parsed.createdAt
        : new Date().toISOString(),
    snapshot,
  };
}

function collectEntityIdMap(
  snapshot: Record<string, unknown>,
  entityKeys: string[],
  preassigned?: Map<string, string>
): Map<string, string> {
  const idMap = new Map<string, string>(preassigned ?? []);

  for (const key of entityKeys) {
    const entities = snapshot[key];
    if (!Array.isArray(entities)) continue;

    for (const entity of entities) {
      if (!isRecord(entity)) continue;
      if (typeof entity.id !== 'string' || entity.id.length === 0) continue;
      if (!idMap.has(entity.id)) {
        idMap.set(entity.id, crypto.randomUUID());
      }
    }
  }

  return idMap;
}

function remapIdsInValue(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => remapIdsInValue(item, idMap));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    next[key] = remapIdsInValue(nestedValue, idMap);
  }
  return next;
}

function normalizeEntityItem(
  entity: unknown,
  now: number,
  fallbackUserId: number | null,
  allowedUserIds: Set<number> | null
): Record<string, unknown> {
  if (!isRecord(entity)) {
    throw new Error('Backup contains non-object entity items');
  }

  const normalized: Record<string, unknown> = {
    ...entity,
    changed: now,
    stamp: now,
  };

  if (typeof normalized.id !== 'string' || normalized.id.length === 0) {
    normalized.id = crypto.randomUUID();
  }

  if (fallbackUserId === null) {
    return normalized;
  }

  if (!('user' in normalized) || typeof normalized.user !== 'number') {
    normalized.user = fallbackUserId;
    return normalized;
  }

  if (allowedUserIds && !allowedUserIds.has(normalized.user)) {
    normalized.user = fallbackUserId;
  }

  return normalized;
}

function getEntityId(entity: unknown): string | null {
  if (!isRecord(entity)) return null;
  return typeof entity.id === 'string' && entity.id.length > 0 ? entity.id : null;
}

function isDebtAccountEntity(entity: unknown): boolean {
  if (!isRecord(entity)) return false;
  return typeof entity.type === 'string' && entity.type.trim().toLowerCase() === 'debt';
}

function hasUnknownAccountReference(
  entity: unknown,
  knownAccountIds: Set<string>
): boolean {
  if (!isRecord(entity)) return false;

  const incomeAccount =
    typeof entity.incomeAccount === 'string' ? entity.incomeAccount : null;
  const outcomeAccount =
    typeof entity.outcomeAccount === 'string' ? entity.outcomeAccount : null;

  if (incomeAccount !== null && !knownAccountIds.has(incomeAccount)) return true;
  return outcomeAccount !== null && !knownAccountIds.has(outcomeAccount);
}

const ACCOUNT_DEPENDENT_KEYS = ['transaction', 'reminder', 'reminderMarker'] as const;

function fillTransactionDefaults(entity: Record<string, unknown>): Record<string, unknown> {
  return {
    merchant: null,
    originalPayee: null,
    hold: null,
    qrCode: null,
    mcc: null,
    reminderMarker: null,
    incomeBankID: null,
    outcomeBankID: null,
    latitude: null,
    longitude: null,
    ...entity,
  };
}

function fillTagDefaults(entity: Record<string, unknown>): Record<string, unknown> {
  return {
    picture: null,
    color: null,
    staticId: null,
    ...entity,
  };
}

function fillReminderDefaults(entity: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: null,
    merchant: null,
    interval: null,
    step: null,
    points: null,
    startDate: '2020-01-01',
    endDate: null,
    notify: false,
    ...entity,
  };
}

function fillAccountDefaults(entity: Record<string, unknown>): Record<string, unknown> {
  return {
    role: null,
    private: false,
    savings: false,
    company: null,
    syncID: null,
    startBalance: 0,
    startDate: null,
    creditLimit: 0,
    inBalance: true,
    enableCorrection: false,
    enableSMS: false,
    capitalization: null,
    percent: null,
    endDateOffset: null,
    endDateOffsetInterval: null,
    payoffStep: null,
    payoffInterval: null,
    ...entity,
  };
}

function buildTagRemap(
  backupTags: unknown[],
  existingTags: Array<{ id: string; title: string }>
): Map<string, string> {
  const map = new Map<string, string>();

  const existingTitleMap = new Map(existingTags.map((tag) => [tag.title, tag.id]));

  for (const entity of backupTags) {
    if (!isRecord(entity)) continue;
    const backupId = getEntityId(entity);
    if (!backupId) continue;

    const backupTitle = typeof entity.title === 'string' ? entity.title : null;
    if (!backupTitle) continue;

    const existingId = existingTitleMap.get(backupTitle);
    if (existingId) {
      map.set(backupId, existingId);
    }
  }

  return map;
}

function sanitizeSnapshotForRestore(
  snapshot: Record<string, unknown>,
  preservedAccountIds: Set<string> = new Set()
): Record<string, unknown> {
  const accountEntities = Array.isArray(snapshot.account) ? snapshot.account : [];

  // Debt accounts are not sent during restore — they are matched against
  // existing debt accounts via the id map instead.
  const remainingAccounts = accountEntities
    .filter((entity) => !isDebtAccountEntity(entity))
    .map((entity) => isRecord(entity) ? fillAccountDefaults(entity) : entity);

  const knownAccountIds = new Set<string>();
  for (const entity of remainingAccounts) {
    const id = getEntityId(entity);
    if (id) knownAccountIds.add(id);
  }
  for (const preservedId of preservedAccountIds) {
    knownAccountIds.add(preservedId);
  }

  const budgetEntities = Array.isArray(snapshot.budget) ? snapshot.budget : [];
  const validBudgets = budgetEntities.filter(
    (b) => isRecord(b) && isValidId(b.tag)
  );

  const nextSnapshot: Record<string, unknown> = {
    ...snapshot,
    account: remainingAccounts,
    budget: validBudgets,
  };

  for (const key of ACCOUNT_DEPENDENT_KEYS) {
    const entities = nextSnapshot[key];
    if (!Array.isArray(entities)) continue;

    const filtered = entities.filter(
      (entity) => !hasUnknownAccountReference(entity, knownAccountIds)
    );

    nextSnapshot[key] = key === 'reminder' || key === 'reminderMarker'
      ? filtered.map((e) => isRecord(e) ? fillReminderDefaults(e) : e)
      : filtered;
  }

  return nextSnapshot;
}

async function removeAllExistingBudgetsAndTags(params: {
  token: string;
  serverTimestamp: number;
  existingBudgets: unknown[];
  existingTags: unknown[];
  fallbackUserId: number | null;
  allowedUserIds: Set<number> | null;
}): Promise<number> {
  const { token, existingBudgets, existingTags, fallbackUserId, allowedUserIds } = params;
  let serverTimestamp = params.serverTimestamp;

  const now = Math.floor(Date.now() / 1000);

  if (existingBudgets.length > 0) {
    const budgetChunks = chunkArray(existingBudgets, 100);
    for (const chunk of budgetChunks) {
      const deletePayload = chunk
        .filter(
          (budget) =>
            isRecord(budget) &&
            isValidId(budget.tag) &&
            isValidId(budget.date)
        )
        .map((budget) => {
          const b = budget as Record<string, unknown>;
          const rawUser = b.user;
          const user =
            typeof rawUser === 'number' && (!allowedUserIds || allowedUserIds.has(rawUser))
              ? rawUser
              : fallbackUserId;

          const entry: Record<string, unknown> = {
            id: `${b.tag}#${b.date}`,
            object: 'Budget',
            stamp: now,
          };

          if (typeof user === 'number') {
            entry.user = user;
          }

          return entry;
        });

      if (deletePayload.length === 0) continue;

      const response = await pushZenmoneyDiff(token, serverTimestamp, {
        deletion: deletePayload,
      });
      serverTimestamp = response.serverTimestamp;
    }
  }

  if (existingTags.length > 0) {
    const tagChunks = chunkArray(existingTags, 100);
    for (const chunk of tagChunks) {
      const deletePayload = chunk
        .filter((tag) => isRecord(tag) && typeof tag.id === 'string' && tag.id.length > 0)
        .map((tag) => {
          const tagRecord = tag as Record<string, unknown>;
          const rawUser = tagRecord.user;
          const user =
            typeof rawUser === 'number' && (!allowedUserIds || allowedUserIds.has(rawUser))
              ? rawUser
              : fallbackUserId;

          const entry: Record<string, unknown> = {
            id: tagRecord.id,
            object: 'Tag',
            stamp: now,
          };

          if (typeof user === 'number') {
            entry.user = user;
          }

          return entry;
        });

      if (deletePayload.length === 0) continue;

      const response = await pushZenmoneyDiff(token, serverTimestamp, {
        deletion: deletePayload,
      });
      serverTimestamp = response.serverTimestamp;
    }
  }

  return serverTimestamp;
}

function buildDebtAccountRemap(
  backupAccounts: unknown[],
  existingDebtAccounts: Array<{ id: string; instrument: number }>
): Map<string, string> {
  const map = new Map<string, string>();
  if (existingDebtAccounts.length === 0) return map;

  for (const entity of backupAccounts) {
    if (!isDebtAccountEntity(entity)) continue;
    const backupId = getEntityId(entity);
    if (!backupId) continue;

    const backupInstrument = isRecord(entity) && typeof entity.instrument === 'number'
      ? entity.instrument
      : null;

    const matched =
      (backupInstrument !== null
        ? existingDebtAccounts.find((acc) => acc.instrument === backupInstrument)
        : undefined) ??
      existingDebtAccounts[0];

    if (matched) {
      map.set(backupId, matched.id);
    }
  }

  return map;
}

export async function createZenBackupAndDownload(token: string): Promise<string> {
  const snapshot = (await fetchZenmoneyDiff(token, 0)) as unknown as Record<
    string,
    unknown
  >;
  const now = new Date();
  const envelope: BackupFileEnvelope = {
    version: BACKUP_FILE_VERSION,
    createdAt: now.toISOString(),
    snapshot,
  };

  const fileName = buildBackupFileName(now);
  downloadJsonFile(JSON.stringify(envelope, null, 2), fileName);
  return fileName;
}

export async function restoreZenBackupFromFile(params: {
  token: string;
  currentServerTimestamp: number;
  file: File;
  currentUserId?: number;
  chunkSize?: number;
}): Promise<void> {
  const {
    token,
    currentServerTimestamp,
    file,
    currentUserId,
    chunkSize = 100,
  } = params;

  if (chunkSize <= 0) {
    throw new Error('chunkSize must be greater than zero');
  }

  const initialDiff = await fetchZenmoneyDiff(token, 0);
  const allowedUserIds = initialDiff.user?.map((user) => user.id) ?? [];
  const allowedUserSet = allowedUserIds.length > 0 ? new Set(allowedUserIds) : null;
  const fallbackUserId =
    initialDiff.account?.[0]?.user ??
    currentUserId ??
    null;

  const existingDebtAccounts = (initialDiff.account ?? []).filter(
    (account) =>
      typeof account.type === 'string' && account.type.toLowerCase() === 'debt'
  );

  let serverTimestamp = currentServerTimestamp;
  if (REMOVE_ALL_EXISTING_TAGS_BEFORE_RESTORE) {
    const initialDiffRaw = initialDiff as unknown as Record<string, unknown>;
    const existingBudgets = Array.isArray(initialDiffRaw.budget) ? initialDiffRaw.budget : [];
    serverTimestamp = await removeAllExistingBudgetsAndTags({
      token,
      serverTimestamp,
      existingBudgets,
      existingTags: initialDiff.tag ?? [],
      fallbackUserId,
      allowedUserIds: allowedUserSet,
    });
  }

  const backup = parseBackupEnvelope(await file.text());
  const backupAccounts = Array.isArray(backup.snapshot.account)
    ? backup.snapshot.account
    : [];
  const backupTags = Array.isArray(backup.snapshot.tag)
    ? backup.snapshot.tag
    : [];

  const debtIdRemap = buildDebtAccountRemap(backupAccounts, existingDebtAccounts);
  const tagIdRemap = REMOVE_ALL_EXISTING_TAGS_BEFORE_RESTORE
    ? new Map<string, string>()
    : buildTagRemap(backupTags, initialDiff.tag ?? []);
  const preservedDebtIds = new Set(debtIdRemap.keys());

  const restorableSnapshot = sanitizeSnapshotForRestore(
    backup.snapshot,
    preservedDebtIds
  );
  const now = Math.floor(Date.now() / 1000);

  const entityKeys = Object.entries(restorableSnapshot)
    .filter(([key, value]) => Array.isArray(value) && !IGNORED_RESTORE_ENTITY_KEYS.has(key))
    .map(([key]) => key);

  const preassignedMap = new Map([...debtIdRemap, ...tagIdRemap]);
  const idMap = collectEntityIdMap(restorableSnapshot, entityKeys, preassignedMap);

  // Restore dependent entities first to reduce validation failures.
  const preferredOrder = ['merchant', 'tag', 'budget', 'account', 'reminder', 'reminderMarker', 'transaction'];
  const orderedKeys = [
    ...preferredOrder.filter((key) => entityKeys.includes(key)),
    ...entityKeys.filter((key) => !preferredOrder.includes(key)),
  ];


  for (const key of orderedKeys) {
    const entities = restorableSnapshot[key];
    if (!Array.isArray(entities) || entities.length === 0) {
      continue;
    }

    const activeEntities = entities.filter(
      (entity) => !isRecord(entity) || entity.deleted !== true
    );
    if (activeEntities.length === 0) continue;

    const filledEntities = activeEntities.map((entity) => {
      if (!isRecord(entity)) return entity;
      if (key === 'transaction') return fillTransactionDefaults(entity);
      if (key === 'tag') return fillTagDefaults(entity);
      return entity;
    });

    const normalizedEntities = filledEntities.map((entity) =>
      normalizeEntityItem(
        remapIdsInValue(entity, idMap),
        now,
        fallbackUserId,
        allowedUserSet
      )
    );

    const chunks = chunkArray(normalizedEntities, chunkSize);
    for (const chunk of chunks) {
      const response = await pushZenmoneyDiff(token, serverTimestamp, {
        [key]: chunk,
      });
      serverTimestamp = response.serverTimestamp;
    }
  }
}
