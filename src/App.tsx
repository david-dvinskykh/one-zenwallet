import { useApp } from './store/AppContext';
import LoginPage from './pages/LoginPage';
import WalletSelectPage from './pages/WalletSelectPage';
import GoalsPage from './pages/GoalsPage';

export default function App() {
  const { token, selectedWalletId, data } = useApp();

  if (!token) {
    return <LoginPage />;
  }

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <p>Loading data...</p>
      </div>
    );
  }

  if (!selectedWalletId) {
    return <WalletSelectPage />;
  }

  return <GoalsPage />;
}
