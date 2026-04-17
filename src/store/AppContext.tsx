import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { fetchZenmoneyDiff } from '../api/zenmoney';
import * as storage from '../utils/storage';
import type {
  ZenAccount,
  ZenTag,
  ZenTransaction,
  ZenInstrument,
} from '../types/zenmoney';

interface ZenData {
  accounts: ZenAccount[];
  tags: ZenTag[];
  transactions: ZenTransaction[];
  instruments: ZenInstrument[];
  serverTimestamp: number;
}

interface AppState {
  token: string | null;
  selectedWalletId: string | null;
  data: ZenData | null;
  loading: boolean;
  error: string | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
  selectWallet: (id: string) => void;
  refresh: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

function mergeData(existing: ZenData | null, diff: Partial<ZenData> & { serverTimestamp: number }): ZenData {
  const base: ZenData = existing ?? {
    accounts: [],
    tags: [],
    transactions: [],
    instruments: [],
    serverTimestamp: 0,
  };

  function mergeArray<T extends { id: string | number }>(
    existing: T[],
    incoming: T[] | undefined
  ): T[] {
    if (!incoming) return existing;
    const map = new Map(existing.map((item) => [item.id, item]));
    for (const item of incoming) {
      map.set(item.id, item);
    }
    return Array.from(map.values());
  }

  return {
    accounts: mergeArray(base.accounts, diff.accounts),
    tags: mergeArray(base.tags, diff.tags),
    transactions: mergeArray(base.transactions, diff.transactions),
    instruments: mergeArray(base.instruments, diff.instruments),
    serverTimestamp: diff.serverTimestamp,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(storage.getToken);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(
    storage.getSelectedWallet
  );
  const [data, setData] = useState<ZenData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // Load cached data from IndexedDB on mount
  useEffect(() => {
    storage.getCachedData<ZenData>().then((cached) => {
      if (cached) setData(cached);
      setCacheLoaded(true);
    });
  }, []);

  const fetchData = useCallback(
    async (tok: string, timestamp: number = 0) => {
      setLoading(true);
      setError(null);
      try {
        const diff = await fetchZenmoneyDiff(tok, timestamp);
        setData((prev) => {
          const merged = mergeData(prev, {
            accounts: diff.account,
            tags: diff.tag,
            transactions: diff.transaction,
            instruments: diff.instrument,
            serverTimestamp: diff.serverTimestamp,
          });
          storage.setCachedData(merged);
          storage.setServerTimestamp(diff.serverTimestamp);
          return merged;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        setError(msg);
        if (msg.includes('Invalid or expired token')) {
          storage.clearAll();
          setToken(null);
          setSelectedWalletId(null);
          setData(null);
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const login = useCallback(
    async (newToken: string) => {
      storage.setToken(newToken);
      setToken(newToken);
      await fetchData(newToken, 0);
    },
    [fetchData]
  );

  const logout = useCallback(() => {
    storage.clearAll();
    setToken(null);
    setSelectedWalletId(null);
    setData(null);
    setError(null);
  }, []);

  const selectWallet = useCallback((id: string) => {
    storage.setSelectedWallet(id);
    setSelectedWalletId(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    const ts = storage.getServerTimestamp();
    await fetchData(token, ts);
  }, [token, fetchData]);

  // Auto-fetch when cache is loaded and we have a token but no data
  useEffect(() => {
    if (cacheLoaded && token && !data) {
      fetchData(token, 0);
    }
  }, [cacheLoaded, token, data, fetchData]);

  return (
    <AppContext.Provider
      value={{
        token,
        selectedWalletId,
        data,
        loading,
        error,
        login,
        logout,
        selectWallet,
        refresh,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
