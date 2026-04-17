const STORAGE_KEY_TOKEN = 'zen_token';
const STORAGE_KEY_WALLET = 'zen_selected_wallet';
const STORAGE_KEY_DATA = 'zen_cached_data';
const STORAGE_KEY_TIMESTAMP = 'zen_server_timestamp';

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

export function getCachedData(): string | null {
  return localStorage.getItem(STORAGE_KEY_DATA);
}

export function setCachedData(data: string): void {
  localStorage.setItem(STORAGE_KEY_DATA, data);
}

export function getServerTimestamp(): number {
  const ts = localStorage.getItem(STORAGE_KEY_TIMESTAMP);
  return ts ? parseInt(ts, 10) : 0;
}

export function setServerTimestamp(ts: number): void {
  localStorage.setItem(STORAGE_KEY_TIMESTAMP, String(ts));
}

export function clearAll(): void {
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_WALLET);
  localStorage.removeItem(STORAGE_KEY_DATA);
  localStorage.removeItem(STORAGE_KEY_TIMESTAMP);
}
