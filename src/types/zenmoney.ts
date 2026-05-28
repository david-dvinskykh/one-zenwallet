export interface ZenAccount {
  id: string;
  title: string;
  type: string;
  role: number | null;
  private: boolean;
  savings: boolean;
  company: number | null;
  instrument: number;
  syncID: string[] | null;
  balance: number;
  startBalance: number;
  startDate: string | null;
  creditLimit: number;
  inBalance: boolean;
  enableCorrection: boolean;
  enableSMS: boolean;
  archive: boolean;
  capitalization: boolean | null;
  percent: number | null;
  endDateOffset: number | null;
  endDateOffsetInterval: string | null;
  payoffStep: number | null;
  payoffInterval: string | null;
  user: number;
}

export interface ZenTag {
  id: string;
  title: string;
  parent: string | null;
  icon: string | null;
  picture: string | null;
  color: number | null;
  staticId: string | null;
  budgetIncome: boolean;
  budgetOutcome: boolean;
  required: boolean | null;
  showIncome: boolean;
  showOutcome: boolean;
  user: number;
}

export interface ZenTransaction {
  id: string;
  date: string;
  income: number;
  incomeAccount: string;
  incomeInstrument: number;
  incomeBankID: number | null;
  outcome: number;
  outcomeAccount: string;
  outcomeInstrument: number;
  outcomeBankID: number | null;
  tag: string[] | null;
  merchant: string | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  hold: boolean | null;
  qrCode: string | null;
  mcc: number | null;
  reminderMarker: string | null;
  opIncome: number | null;
  opOutcome: number | null;
  opIncomeInstrument: number | null;
  opOutcomeInstrument: number | null;
  latitude: number | null;
  longitude: number | null;
  created: number;
  changed: number;
  user: number;
  deleted: boolean;
}

export interface ZenInstrument {
  id: number;
  title: string;
  shortTitle: string;
  symbol: string;
  rate: number;
}

export interface ZenReminder {
  id: string;
  incomeAccount: string;
  outcomeAccount: string;
  income: number;
  incomeInstrument: number;
  outcome: number;
  outcomeInstrument: number;
  tag: string[] | null;
  merchant: string | null;
  comment: string | null;
  payee: string | null;
  interval: string | null;
  step: number | null;
  points: number[] | null;
  startDate: string;
  endDate: string | null;
  notify: boolean;
  changed: number;
  user: number;
  deleted?: boolean;
}

export interface ZenUser {
  id: number;
  login: string;
  monthStartDay: number;
}

export type GoalTargetType = 'one_time' | 'recurring' | 'fixed_monthly';

export interface GoalTarget {
  type?: GoalTargetType; // defaults to 'one_time' for backward compat
  amount: number;
  date?: string; // YYYY-MM-DD, used by one_time and recurring
  repeatEvery?: number; // recurring: interval count
  repeatUnit?: 'days' | 'months'; // recurring: interval unit
}

export interface ZenDiffResponse {
  serverTimestamp: number;
  instrument?: ZenInstrument[];
  account?: ZenAccount[];
  tag?: ZenTag[];
  transaction?: ZenTransaction[];
  reminder?: ZenReminder[];
  user?: ZenUser[];
}

export interface Goal {
  categoryId: string;
  categoryTitle: string;
  amount: number;
  transactions: GoalTransaction[];
}

export interface GoalTransaction {
  id: string;
  date: string;
  amount: number;
  type: 'spending' | 'income' | 'transfer_in';
  comment: string | null;
}

export interface GoalFeedItem {
  id: string;
  date: string;
  amount: number;
  direction: 'income' | 'spending';
  transactionId: string;
  goalId: string | null;
  goalTitle: string | null;
  comment: string | null;
  source: 'tag' | 'transfer_comment' | 'linked_account' | 'manual' | 'unassigned';
  isTransfer: boolean;
}

export interface GoalsComputationResult {
  goals: Goal[];
  feed: GoalFeedItem[];
}
