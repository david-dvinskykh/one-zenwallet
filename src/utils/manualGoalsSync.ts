import { pushZenmoneyDiff } from '../api/zenmoney';
import type { ZenAccount, ZenReminder } from '../types/zenmoney';
import {
  buildManualAssignmentsComment,
  findManualAssignmentsReminder,
  getDataAccount,
  ONE_ZENWALLET_DATA_ACCOUNT_NAME,
} from './hiddenData';

interface SyncInput {
  token: string;
  serverTimestamp: number;
  accounts: ZenAccount[];
  reminders: ZenReminder[];
  assignments: Record<string, string>;
}

export async function syncManualAssignmentsToZenmoney(input: SyncInput): Promise<void> {
  const { token, serverTimestamp, accounts, reminders, assignments } = input;
  const userAccount = accounts.find((acc) => !acc.archive) ?? accounts[0];
  if (!userAccount) {
    throw new Error('No account available to infer user settings');
  }

  const now = Math.floor(Date.now() / 1000);
  let dataAccount = getDataAccount(accounts);
  const patch: Record<string, unknown> = {};

  if (!dataAccount) {
    const accountId = crypto.randomUUID();
    dataAccount = {
      id: accountId,
      title: ONE_ZENWALLET_DATA_ACCOUNT_NAME,
      type: 'cash',
      role: null,
      private: false,
      savings: false,
      company: null,
      instrument: userAccount.instrument,
      syncID: null,
      balance: 0,
      startBalance: 0,
      startDate: null,
      creditLimit: 0,
      inBalance: false,
      enableCorrection: false,
      enableSMS: false,
      archive: true,
      capitalization: null,
      percent: null,
      endDateOffset: null,
      endDateOffsetInterval: null,
      payoffStep: null,
      payoffInterval: null,
      user: userAccount.user,
    };

    patch.account = [
      {
        id: accountId,
        changed: now,
        user: userAccount.user,
        instrument: userAccount.instrument,
        type: 'cash',
        role: null,
        private: false,
        savings: false,
        company: null,
        syncID: null,
        title: ONE_ZENWALLET_DATA_ACCOUNT_NAME,
        balance: 0,
        startBalance: 0,
        startDate: null,
        creditLimit: 0,
        inBalance: false,
        enableCorrection: false,
        enableSMS: false,
        archive: true,
        capitalization: null,
        percent: null,
        endDateOffset: null,
        endDateOffsetInterval: null,
        payoffStep: null,
        payoffInterval: null,
      },
    ];
  }

  const resolvedDataAccount = dataAccount!;
  const existingReminder = findManualAssignmentsReminder(reminders, resolvedDataAccount.id);
  const reminderId = existingReminder?.id ?? crypto.randomUUID();
  const reminderPatch = {
    id: reminderId,
    changed: now,
    user: userAccount.user,
    incomeInstrument: resolvedDataAccount.instrument,
    incomeAccount: resolvedDataAccount.id,
    income: 1,
    outcomeInstrument: resolvedDataAccount.instrument,
    outcomeAccount: resolvedDataAccount.id,
    outcome: 1,
    tag: null,
    merchant: null,
    comment: buildManualAssignmentsComment(assignments),
    payee: 'oneZenwallet',
    startDate: '2020-01-01',
    endDate: '2020-01-01',
    interval: null,
    step: null,
    points: null,
    notify: false,
  };

  patch.reminder = [reminderPatch];

  await pushZenmoneyDiff(token, serverTimestamp, patch);
}

