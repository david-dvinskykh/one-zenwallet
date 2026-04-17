import { useState, type FormEvent } from 'react';
import { useApp } from '../store/AppContext';
import './LoginPage.css';

export default function LoginPage() {
  const { login, loading, error } = useApp();
  const [tokenInput, setTokenInput] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    await login(trimmed);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-icon">💰</div>
        <h1>ZenWallet Goals</h1>
        <p className="login-subtitle">
          Connect your Zenmoney account to track category-based goals.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="token">Zenmoney API Token</label>
          <input
            id="token"
            type="password"
            placeholder="Enter your API token..."
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            disabled={loading}
            autoFocus
          />
          <p className="login-hint">
            Get your token from{' '}
            <a
              href="https://zerro.app/token"
              target="_blank"
              rel="noopener noreferrer"
            >
              zerro.app/token
            </a>{' '}
            or via{' '}
            <a
              href="https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API"
              target="_blank"
              rel="noopener noreferrer"
            >
              Zenmoney API
            </a>
          </p>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading || !tokenInput.trim()}>
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
