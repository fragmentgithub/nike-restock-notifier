// nike.js と discovery.js で共有する小さなユーティリティ。
// 実装を1箇所に集約し、片方だけ直して挙動がずれる事故を防ぐ。

export function firstPresent(values) {
  return (
    values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || ''
  );
}

export async function fetchWithTimeout(url, { timeoutMs = 15000, fetchImpl = fetch, ...options } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseNextData(html) {
  const idIndex = html.indexOf('__NEXT_DATA__');
  if (idIndex === -1) return null;

  const scriptStart = html.lastIndexOf('<script', idIndex);
  const jsonStart = html.indexOf('>', scriptStart) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (scriptStart === -1 || jsonStart === 0 || jsonEnd === -1) return null;

  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
}
