import type { ZenDiffResponse } from '../types/zenmoney';

const ZEN_API_URL = 'https://api.zenmoney.ru/v8/diff';

export async function fetchZenmoneyDiff(
  token: string,
  serverTimestamp: number = 0
): Promise<ZenDiffResponse> {
  const response = await fetch(ZEN_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      currentClientTimestamp: Math.floor(Date.now() / 1000),
      serverTimestamp,
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or expired token');
    }
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
