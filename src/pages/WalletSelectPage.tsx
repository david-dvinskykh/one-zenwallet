import { useApp } from '../store/AppContext';
import type { ZenAccount } from '../types/zenmoney';
import './WalletSelectPage.css';

export default function WalletSelectPage() {
  const { data, selectWallet, logout, loading, refresh } = useApp();

  if (!data) return null;

  const activeAccounts = data.accounts.filter(
    (a) => !a.archive && a.type !== 'debt'
  );

  const instrumentMap = new Map(data.instruments.map((i) => [i.id, i]));

  const formatBalance = (account: ZenAccount) => {
    const inst = instrumentMap.get(account.instrument);
    const symbol = inst?.symbol ?? '';
    return `${account.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
  };

  const accountTypes: Record<string, string> = {
    cash: '💵 Cash',
    ccard: '💳 Cards',
    checking: '🏦 Checking',
    deposit: '🏦 Deposits',
    emoney: '📱 E-Money',
    loan: '🏠 Loans',
    investment: '📈 Investments',
  };

  const grouped = activeAccounts.reduce(
    (acc, account) => {
      const type = account.type || 'other';
      if (!acc[type]) acc[type] = [];
      acc[type].push(account);
      return acc;
    },
    {} as Record<string, ZenAccount[]>
  );

  return (
    <div className="wallet-page">
      <header className="wallet-header">
        <h1>Select Wallet</h1>
        <div className="wallet-header-actions">
          <button className="btn-icon" onClick={refresh} disabled={loading} title="Refresh">
            🔄
          </button>
          <button className="btn-text" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      <p className="wallet-subtitle">
        Choose the wallet you want to track goals for:
      </p>
      <div className="wallet-groups">
        {Object.entries(grouped).map(([type, accounts]) => (
          <div key={type} className="wallet-group">
            <h2>{accountTypes[type] ?? `📂 ${type}`}</h2>
            <div className="wallet-list">
              {accounts.map((account) => (
                <button
                  key={account.id}
                  className="wallet-card"
                  onClick={() => selectWallet(account.id)}
                >
                  <span className="wallet-title">{account.title}</span>
                  <span className="wallet-balance">
                    {formatBalance(account)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
