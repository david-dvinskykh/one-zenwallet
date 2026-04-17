const STORAGE_KEY_TOKEN = 'zen_token';
const STORAGE_KEY_WALLET = 'zen_selected_wallet';
const STORAGE_KEY_TIMESTAMP = 'zen_server_timestamp';

const DB_NAME = 'zenwallet';
const DB_VERSION = 1;
const STORE_NAME = 'cache';
const DATA_KEY = 'zen_cached_data';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedData<T>(): Promise<T | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DATA_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedData<T>(data: T): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(data, DATA_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // silently fail — data will be refetched
  }
}

async function clearCachedData(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(DATA_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

export function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY_TOKEN);
}

export function setToken(token: string): void {
  localStorage.setItem(STORAGE_KEY_TOKEN, token);
}

export function clearToken(): void {
  localStorage.removeItem(STORAGE_KEY_TOKEN);
}

export function getSelectedWallet(): string | null {
  return localStorage.getItem(STORAGE_KEY_WALLET);
}

export function setSelectedWallet(walletId: string): void {
  localStorage.setItem(STORAGE_KEY_WALLET, walletId);
}

export function clearSelectedWallet(): void {
  localStorage.removeItem(STORAGE_KEY_WALLET);
}

export function getServerTimestamp(): number {
  const ts = localStorage.getItem(STORAGE_KEY_TIMESTAMP);
  return ts ? parseInt(ts, 10) : 0;
}

export function setServerTimestamp(ts: number): void {
  localStorage.setItem(STORAGE_KEY_TIMESTAMP, String(ts));
}

export async function clearAll(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_WALLET);
  localStorage.removeItem(STORAGE_KEY_TIMESTAMP);
  await clearCachedData();
}
