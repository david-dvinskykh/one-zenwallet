import type { ZenDiffResponse } from '../types/zenmoney';

const ZEN_API_URL = 'https://api.zenmoney.ru/v8/diff';

async function callZenmoneyDiff(
  token: string,
  payload: Record<string, unknown>
): Promise<ZenDiffResponse> {
  const response = await fetch(ZEN_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Invalid or expired token');
    }
    // ZenMoney explains a rejected entity in the body; without it a failed push
    // is indistinguishable from one that silently did nothing.
    const detail = await response.text().catch(() => '');
    throw new Error(
      `API error: ${response.status}${detail ? ` — ${detail.trim().slice(0, 300)}` : ''}`
    );
  }

  return response.json();
}

export async function fetchZenmoneyDiff(
  token: string,
  serverTimestamp: number = 0,
  forceFetch?: string[]
): Promise<ZenDiffResponse> {
  return callZenmoneyDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp,
    ...(forceFetch && forceFetch.length ? { forceFetch } : {}),
  });
}

export async function pushZenmoneyDiff(
  token: string,
  serverTimestamp: number,
  patch: Record<string, unknown>
): Promise<ZenDiffResponse> {
  return callZenmoneyDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp,
    ...patch,
  });
}
