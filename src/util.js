// nike.js と discovery.js で共有する小さなユーティリティ。
// 実装を1箇所に集約し、片方だけ直して挙動がずれる事故を防ぐ。

export function firstPresent(values) {
  const value = values.find(
    (candidate) => candidate !== undefined && candidate !== null && String(candidate).trim() !== '',
  );
  return value ?? '';
}

export async function fetchWithTimeout(
  url,
  { timeoutMs = 15000, fetchImpl = fetch, signal: parentSignal, ...options } = {},
) {
  const controller = new AbortController();
  const parsedTimeout = Number(timeoutMs);
  const durationMs = Number.isFinite(parsedTimeout) ? Math.max(1, parsedTimeout) : 15000;
  const timeout = setTimeout(() => controller.abort(), durationMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;

  try {
    return await fetchImpl(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseNextData(html) {
  const match = String(html || '').match(
    /<script\b(?=[^>]*\bid\s*=\s*["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i,
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function errorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error ?? '').trim();
  return message || fallback;
}
