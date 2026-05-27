import { pushZenmoneyDiff } from '../api/zenmoney';
import type { ZenAccount, ZenReminder, ZenTransaction, GoalTarget } from '../types/zenmoney';
import {
  buildManualAssignmentsComment,
  buildGoalTargetsComment,
  findManualAssignmentsReminder,
  findGoalTargetsReminder,
  getDataAccount,
  ONE_ZENWALLET_DATA_ACCOUNT_NAME,
} from './hiddenData';

interface SyncHiddenDataInput {
  token: string;
  serverTimestamp: number;
  accounts: ZenAccount[];
  reminders: ZenReminder[];
  assignments: Record<string, string>;
  targets: Record<string, GoalTarget>;
  transactionUpdates?: ZenTransaction[];
}

export async function syncHiddenDataToZenmoney(input: SyncHiddenDataInput): Promise<void> {
  const { token, serverTimestamp, accounts, reminders, assignments, targets, transactionUpdates } = input;
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
        id: dataAccount.id,
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

  const resolvedAccount = dataAccount;
  const baseReminder = {
    changed: now,
    user: userAccount.user,
    incomeInstrument: resolvedAccount.instrument,
    incomeAccount: resolvedAccount.id,
    income: 1,
    outcomeInstrument: resolvedAccount.instrument,
    outcomeAccount: resolvedAccount.id,
    outcome: 1,
    tag: null,
    merchant: null,
    payee: 'oneZenwallet',
    startDate: '2020-01-01',
    endDate: '2020-01-01',
    interval: null,
    step: null,
    points: null,
    notify: false,
  };

  const existingAssignmentsReminder = findManualAssignmentsReminder(reminders, resolvedAccount.id);
  const existingTargetsReminder = findGoalTargetsReminder(reminders, resolvedAccount.id);

  patch.reminder = [
    {
      ...baseReminder,
      id: existingAssignmentsReminder?.id ?? crypto.randomUUID(),
      comment: buildManualAssignmentsComment(assignments),
    },
    {
      ...baseReminder,
      id: existingTargetsReminder?.id ?? crypto.randomUUID(),
      comment: buildGoalTargetsComment(targets),
    },
  ];

  if (transactionUpdates && transactionUpdates.length > 0) {
    patch.transaction = transactionUpdates;
  }

  await pushZenmoneyDiff(token, serverTimestamp, patch);
}
