import { stockKey } from './monitor-state.js';

export function parseProductConfig(value) {
  if (!String(value || '').trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`PRODUCT_CONFIG_JSON is invalid JSON: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('PRODUCT_CONFIG_JSON must be a JSON object');
  }

  const normalized = {};
  for (const [key, rawSettings] of Object.entries(parsed)) {
    const styleColor = String(key || '').trim().toUpperCase();
    if (!styleColor) continue;
    const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
      ? rawSettings
      : { sizes: rawSettings };
    const normalizedSettings = {
      notify: settings.notify !== false,
      enabled: settings.enabled !== false,
      mention: normalizeDiscordMention(settings.mention),
    };
    if (Object.hasOwn(settings, 'sizes') || Object.hasOwn(settings, 'sizeFilters')) {
      normalizedSettings.sizeFilters = normalizeSizeFilters(settings.sizes ?? settings.sizeFilters);
    }
    normalized[styleColor] = normalizedSettings;
  }
  return normalized;
}

export function parseProductConfigSafely(value) {
  try {
    return { config: parseProductConfig(value), error: null };
  } catch (error) {
    return { config: {}, error: error.message || String(error) };
  }
}

export function settingsForProduct(productConfig, styleColor, globalSizeFilters = '', globalMention = '') {
  const settings = productConfig?.[String(styleColor || '').toUpperCase()] || {};
  return {
    sizeFilters: Object.hasOwn(settings, 'sizeFilters')
      ? settings.sizeFilters
      : String(globalSizeFilters || ''),
    notify: settings.notify !== false,
    enabled: settings.enabled !== false,
    mention: settings.mention || normalizeDiscordMention(globalMention),
  };
}

export function updateDelistState(entry, result, { threshold = 12, now = new Date().toISOString() } = {}) {
  if (result?.ok) {
    entry.missingStreak = 0;
    if (entry.pausedReason === 'delisted') {
      entry.pausedAt = null;
      entry.pausedReason = '';
      return 'resumed';
    }
    return null;
  }

  if (result?.notFound !== true) {
    if (!entry.pausedAt) entry.missingStreak = 0;
    return null;
  }

  entry.missingStreak = (Number(entry.missingStreak) || 0) + 1;
  if (!entry.pausedAt && entry.missingStreak >= Math.max(1, Number(threshold) || 12)) {
    entry.pausedAt = now;
    entry.pausedReason = 'delisted';
    return 'paused';
  }
  return null;
}

export function applyRuntimeFailure(
  entry,
  error,
  { checkedAt = new Date().toISOString(), durationMs = 0 } = {},
) {
  const message = error?.message || '監視処理でエラーが発生しました。';
  entry.lastSeenAt = checkedAt;
  entry.lastRuntimeError = { message, at: checkedAt };
  return {
    at: checkedAt,
    styleColor: entry.styleColor,
    ok: false,
    durationMs: Math.max(0, Number(durationMs) || 0),
    inStock: false,
  };
}

export function updateCatalogPresence(entries, discoveredProducts, checkedAt = new Date().toISOString()) {
  const discovered = new Set(
    (Array.isArray(discoveredProducts) ? discoveredProducts : [])
      .map((product) => String(product?.styleColor || '').toUpperCase())
      .filter(Boolean),
  );
  const reprobe = [];

  for (const entry of entries || []) {
    const present = discovered.has(String(entry.styleColor || '').toUpperCase());
    if (present) {
      // 初回観測や継続掲載では休止を解除しない。一度カタログから消えた商品が
      // 再出現した場合だけ、休止状態のまま即時PDP再確認を予約する。
      if (entry.catalogPresent === false && entry.pausedReason === 'delisted') {
        entry.lastSeenAt = null;
        reprobe.push(entry.styleColor);
      }
      entry.catalogPresent = true;
      entry.lastCatalogSeenAt = checkedAt;
    } else {
      entry.catalogPresent = false;
    }
  }
  return reprobe;
}

export function recordStockTransition(entry, result, { now = new Date().toISOString(), maxItems = 60 } = {}) {
  if (!result?.ok) return null;
  const nextKey = stockKey(result.availableSizes || []) || (result.inStock ? '__product__' : '');
  const previousKey = entry.lastObservedStockKey;
  entry.lastObservedStockKey = nextKey;
  if (previousKey === undefined || previousKey === nextKey) return null;

  const previous = splitStockKey(previousKey);
  const current = splitStockKey(nextKey);
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const added = current.filter((size) => !previousSet.has(size));
  const removed = previous.filter((size) => !currentSet.has(size));
  const transition = {
    at: now,
    styleColor: entry.styleColor,
    previous,
    current,
    added,
    removed,
    message: stockTransitionMessage(entry.styleColor, added, removed, current),
  };
  entry.stockHistory = [transition, ...(Array.isArray(entry.stockHistory) ? entry.stockHistory : [])]
    .slice(0, maxItems);
  return transition;
}

export function millisecondsUntilProductDue(
  entry,
  {
    now = Date.now(),
    normalIntervalSeconds = 120,
    upcomingIntervalSeconds = 30,
    upcomingWindowMinutes = 180,
    pausedRecheckHours = 24,
  } = {},
) {
  const lastChecked = Date.parse(entry.lastSeenAt || '');
  if (!Number.isFinite(lastChecked)) return 0;

  const intervalMs = entry.pausedAt
    ? Math.max(1, Number(pausedRecheckHours) || 24) * 3600 * 1000
    : isUpcomingPriority(entry, now, upcomingWindowMinutes)
      ? Math.max(15, Number(upcomingIntervalSeconds) || 30) * 1000
      : Math.max(30, Number(normalIntervalSeconds) || 120) * 1000;
  return Math.max(0, lastChecked + intervalMs - now);
}

export function shouldCheckProductNow(entry, { singleSweep = false, ...scheduleOptions } = {}) {
  if (singleSweep && !entry?.pausedAt) return true;
  return millisecondsUntilProductDue(entry, scheduleOptions) <= 0;
}

export function isUpcomingPriority(entry, now = Date.now(), upcomingWindowMinutes = 180) {
  if (entry?.lastResult?.availabilityState !== 'coming-soon') return false;
  const releaseAt = Date.parse(entry.lastResult.releaseAt || '');
  if (!Number.isFinite(releaseAt)) return true;
  const windowMs = Math.max(1, Number(upcomingWindowMinutes) || 180) * 60 * 1000;
  return releaseAt >= now - 60 * 60 * 1000 && releaseAt <= now + windowMs;
}

export function computeQualityMetrics(samples, { now = Date.now(), windowHours = 24 } = {}) {
  const cutoff = now - Math.max(1, Number(windowHours) || 24) * 3600 * 1000;
  const recent = (Array.isArray(samples) ? samples : []).filter((sample) => {
    const at = Date.parse(sample?.at || '');
    return Number.isFinite(at) && at >= cutoff && at <= now;
  });
  const successes = recent.filter((sample) => sample.ok === true);
  const durations = recent.map((sample) => Number(sample.durationMs)).filter(Number.isFinite);
  return {
    windowHours,
    checks: recent.length,
    successes: successes.length,
    failures: recent.length - successes.length,
    successRate: recent.length ? Math.round((successes.length / recent.length) * 1000) / 10 : null,
    averageResponseMs: durations.length
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : null,
    lastSuccessAt: successes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.at || null,
  };
}

export function normalizeDiscordMention(value) {
  const raw = String(value || '').trim();
  return /^(?:<@&\d+>|<@\d+>)$/.test(raw) ? raw : '';
}

function normalizeSizeFilters(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).join(',');
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).join(',');
}

function splitStockKey(value) {
  return String(value || '').split('|').filter(Boolean);
}

function stockTransitionMessage(styleColor, added, removed, current) {
  const addedLabels = formatStockLabels(added);
  const removedLabels = formatStockLabels(removed);
  if (added.length && removed.length) {
    return `${styleColor}: ${addedLabels} 入荷 / ${removedLabels} 在庫なし`;
  }
  if (added.length) return `${styleColor}: ${addedLabels} が入荷`;
  if (removed.length && current.length) return `${styleColor}: ${removedLabels} が在庫なし`;
  return `${styleColor}: 全サイズ在庫なし`;
}

function formatStockLabels(values) {
  return values.map((value) => value === '__product__' ? '商品' : value).join(', ');
}
