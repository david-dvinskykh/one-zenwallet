import { useState, useRef, type ChangeEvent } from 'react';
import { useApp } from '../store/AppContext';
import type { ZenAccount } from '../types/zenmoney';
import {
  createZenBackupAndDownload,
  restoreZenBackupFromFile,
} from '../utils/backupRestore';
import './WalletSelectPage.css';

export default function WalletSelectPage() {
  const { data, token, selectWallet, logout, loading, refresh } = useApp();

  const [backupState, setBackupState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleBackupOrRestore = async () => {
    if (!token || !data) return;

    const wantsRestore = window.confirm(
      'Press OK to restore from a backup file. Press Cancel to create and download a backup.'
    );

    if (wantsRestore) {
      restoreInputRef.current?.click();
      return;
    }

    setBackupState('working');
    setBackupMessage(null);

    try {
      const fileName = await createZenBackupAndDownload(token);
      setBackupState('done');
      setBackupMessage(`Backup downloaded: ${fileName}`);
    } catch (error) {
      setBackupState('error');
      setBackupMessage(
        error instanceof Error ? error.message : 'Failed to create backup'
      );
    }
  };

  const handleRestoreFileSelected = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || !token || !data) return;

    setBackupState('working');
    setBackupMessage(null);

    const currentUserId =
      data.accounts.find((account) => !account.archive)?.user ??
      data.accounts[0]?.user;

    try {
      await restoreZenBackupFromFile({
        token,
        currentServerTimestamp: data.serverTimestamp,
        file,
        currentUserId,
      });
      await refresh();
      setBackupState('done');
      setBackupMessage(`Restore completed from ${file.name}`);
    } catch (error) {
      setBackupState('error');
      setBackupMessage(
        error instanceof Error ? error.message : 'Failed to restore backup'
      );
    }
  };

  return (
    <div className="wallet-page">
      <header className="wallet-header">
        <h1>Select Wallet</h1>
        <div className="wallet-header-actions">
          <button className="btn-icon" onClick={refresh} disabled={loading || backupState === 'working'} title="Refresh">
            🔄
          </button>
          <button
            className="btn-text"
            onClick={handleBackupOrRestore}
            disabled={loading || backupState === 'working'}
            title="Create backup or restore from backup file"
          >
            {backupState === 'working' ? 'Working...' : 'Backup / Restore'}
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={handleRestoreFileSelected}
          />
          <button className="btn-text" onClick={logout}>
            Logout
          </button>
        </div>
      </header>
      {backupState === 'done' && backupMessage && (
        <p className="save-banner save-ok">{backupMessage}</p>
      )}
      {backupState === 'error' && backupMessage && (
        <p className="save-banner save-error">{backupMessage}</p>
      )}
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
