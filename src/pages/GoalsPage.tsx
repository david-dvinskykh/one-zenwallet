import { useState, useMemo } from 'react';
import { useApp } from '../store/AppContext';
import { computeGoals } from '../utils/goals';
import { clearSelectedWallet } from '../utils/storage';
import type { Goal } from '../types/zenmoney';
import './GoalsPage.css';

export default function GoalsPage() {
  const { data, selectedWalletId, selectWallet, logout, loading, refresh } =
    useApp();
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'positive' | 'negative'>('all');

  const selectedAccount = useMemo(
    () => data?.accounts.find((a) => a.id === selectedWalletId),
    [data, selectedWalletId]
  );

  const instrumentMap = useMemo(
    () => new Map(data?.instruments.map((i) => [i.id, i]) ?? []),
    [data]
  );

  const goals = useMemo(() => {
    if (!data || !selectedWalletId) return [];
    return computeGoals(
      data.transactions,
      data.tags,
      data.accounts,
      selectedWalletId
    );
  }, [data, selectedWalletId]);

  const filteredGoals = useMemo(() => {
    if (filter === 'positive') return goals.filter((g) => g.amount > 0);
    if (filter === 'negative') return goals.filter((g) => g.amount < 0);
    return goals;
  }, [goals, filter]);

  const totalAmount = useMemo(
    () => filteredGoals.reduce((sum, g) => sum + g.amount, 0),
    [filteredGoals]
  );

  if (!data || !selectedWalletId) return null;

  const currency =
    instrumentMap.get(selectedAccount?.instrument ?? 0)?.symbol ?? '';

  const formatAmount = (n: number) =>
    `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

  const handleChangeWallet = () => {
    clearSelectedWallet();
    selectWallet('');
  };

  return (
    <div className="goals-page">
      <header className="goals-header">
        <div className="goals-header-top">
          <div>
            <h1>Goals</h1>
            <p className="goals-wallet-name">{selectedAccount?.title}</p>
          </div>
          <div className="goals-header-actions">
            <button
              className="btn-icon"
              onClick={refresh}
              disabled={loading}
              title="Refresh"
            >
              🔄
            </button>
            <button className="btn-text" onClick={handleChangeWallet}>
              Change Wallet
            </button>
            <button className="btn-text" onClick={logout}>
              Logout
            </button>
          </div>
        </div>
        <div className="goals-summary">
          <div className="goals-summary-total">
            <span className="label">Net Total</span>
            <span className={`amount ${totalAmount >= 0 ? 'positive' : 'negative'}`}>
              {formatAmount(totalAmount)}
            </span>
          </div>
          <div className="goals-filters">
            <button
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({goals.length})
            </button>
            <button
              className={`filter-btn ${filter === 'positive' ? 'active' : ''}`}
              onClick={() => setFilter('positive')}
            >
              Funded
            </button>
            <button
              className={`filter-btn ${filter === 'negative' ? 'active' : ''}`}
              onClick={() => setFilter('negative')}
            >
              Overspent
            </button>
          </div>
        </div>
      </header>

      {loading && <div className="goals-loading">Updating...</div>}

      <div className="goals-list">
        {filteredGoals.length === 0 && (
          <div className="goals-empty">
            No goals found for this wallet. Transactions with categories will
            appear here.
          </div>
        )}
        {filteredGoals.map((goal) => (
          <GoalCard
            key={goal.categoryId}
            goal={goal}
            currency={currency}
            expanded={expandedGoalId === goal.categoryId}
            onToggle={() =>
              setExpandedGoalId(
                expandedGoalId === goal.categoryId ? null : goal.categoryId
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function GoalCard({
  goal,
  currency,
  expanded,
  onToggle,
}: {
  goal: Goal;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const formatAmount = (n: number) =>
    `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

  const typeLabel = (type: string) => {
    switch (type) {
      case 'spending':
        return '📉 Spending';
      case 'income':
        return '📈 Income';
      case 'transfer_in':
        return '💸 Transfer In';
      default:
        return type;
    }
  };

  return (
    <div className={`goal-card ${goal.amount >= 0 ? 'funded' : 'overspent'}`}>
      <button className="goal-header" onClick={onToggle}>
        <div className="goal-info">
          <span className="goal-title">{goal.categoryTitle}</span>
          <span className="goal-tx-count">
            {goal.transactions.length} transaction
            {goal.transactions.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="goal-amount-wrap">
          <span
            className={`goal-amount ${goal.amount >= 0 ? 'positive' : 'negative'}`}
          >
            {formatAmount(goal.amount)}
          </span>
          <span className={`goal-chevron ${expanded ? 'open' : ''}`}>▾</span>
        </div>
      </button>
      {expanded && (
        <div className="goal-transactions">
          {goal.transactions
            .slice()
            .reverse()
            .map((tx) => (
              <div key={tx.id} className="goal-tx">
                <div className="goal-tx-left">
                  <span className="goal-tx-type">{typeLabel(tx.type)}</span>
                  <span className="goal-tx-date">{tx.date}</span>
                  {tx.comment && (
                    <span className="goal-tx-comment">{tx.comment}</span>
                  )}
                </div>
                <span
                  className={`goal-tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}
                >
                  {formatAmount(tx.amount)}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
