export interface ZenAccount {
  id: string;
  title: string;
  type: string;
  balance: number;
  instrument: number;
  archive: boolean;
  user: number;
}

export interface ZenTag {
  id: string;
  title: string;
  parent: string | null;
  icon: string | null;
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
  outcome: number;
  outcomeAccount: string;
  outcomeInstrument: number;
  tag: string[] | null;
  comment: string | null;
  payee: string | null;
  opIncome: number | null;
  opOutcome: number | null;
  opIncomeInstrument: number | null;
  opOutcomeInstrument: number | null;
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

export interface ZenDiffResponse {
  serverTimestamp: number;
  instrument?: ZenInstrument[];
  account?: ZenAccount[];
  tag?: ZenTag[];
  transaction?: ZenTransaction[];
  user?: Array<{ id: number; login: string }>;
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
