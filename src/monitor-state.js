export function stockKey(sizes = []) {
  return sizes
    .filter((size) => size.available)
    .map((size) => size.label || size.id)
    .sort()
    .join('|');
}

// 単発の inStock:false（パーサ・フォールバック不一致によるフリッカ）で通知キーを
// 即クリアすると、在庫が戻った次サイクルで同じ在庫に重複通知が出る。連続でこの回数
// 在庫なしを確認してから初めてキーをクリアする。
export const OOS_CLEAR_THRESHOLD = 2;

export function notificationDecision(entry, result) {
  const nextStockKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
  const previousStockKey = String(entry.lastStockKey || '');
  const previousSizes = new Set(previousStockKey.split('|').filter(Boolean));
  const nextSizes = nextStockKey.split('|').filter(Boolean);
  const hasNewSize =
    previousStockKey !== '__product__' &&
    nextStockKey !== '__product__' &&
    nextSizes.some((size) => !previousSizes.has(size));
  // 汎用の在庫あり(__product__)から、具体的な購入可能サイズが初めて判明した遷移も通知する。
  const firstConcreteSizes =
    previousStockKey === '__product__' && nextStockKey !== '__product__' && nextSizes.length > 0;
  const addedSizes = previousStockKey === '__product__'
    ? nextSizes
    : nextSizes.filter((size) => !previousSizes.has(size));
  return {
    nextStockKey,
    previousStockKey,
    addedSizes,
    shouldNotify:
      result.ok === true &&
      result.inStock === true &&
      Boolean(nextStockKey) &&
      (!previousStockKey || hasNewSize || firstConcreteSizes),
  };
}

export function applyCheckState(
  entry,
  result,
  { nextStockKey, shouldNotify, notified, webhookConfigured },
) {
  if (!result.ok) {
    // 取得失敗は「在庫なし」でも「在庫あり」でもない。直前までに得た OOS の
    // 確認回数を凍結し、断続的なボットブロックで再入荷通知の再武装を妨げない。
    return entry.lastStockKey || '';
  }

  if (!result.inStock) {
    entry.oosStreak = (Number(entry.oosStreak) || 0) + 1;
    if (entry.oosStreak >= OOS_CLEAR_THRESHOLD) {
      entry.lastStockKey = '';
    }
    return entry.lastStockKey || '';
  }

  entry.oosStreak = 0;
  if (!shouldNotify || notified || !webhookConfigured) {
    entry.lastStockKey = nextStockKey;
  }
  return entry.lastStockKey || '';
}

export function nextCycleDelayMs(intervalSeconds, consecutiveFailedCycles, maxSeconds = 600) {
  const baseSeconds = Math.max(30, Number(intervalSeconds) || 120);
  const failures = Math.max(0, Number(consecutiveFailedCycles) || 0);
  const multiplier = 2 ** Math.min(failures, 4);
  return Math.min(maxSeconds, baseSeconds * multiplier) * 1000;
}

export function nextFailureBackoffUntil(
  currentValue,
  {
    attempted = false,
    streak = 0,
    intervalSeconds = 120,
    now = Date.now(),
  } = {},
) {
  const currentTimestamp = Date.parse(currentValue || '');
  const current = Number.isFinite(currentTimestamp)
    ? new Date(currentTimestamp).toISOString()
    : null;
  if (!attempted) return current;
  if (Math.max(0, Number(streak) || 0) === 0) return null;

  const nowMs = timestampOrNow(now);
  return new Date(nowMs + nextCycleDelayMs(intervalSeconds, streak)).toISOString();
}

export function millisecondsUntilFailureBackoff(value, now = Date.now()) {
  const backoffUntil = Date.parse(value || '');
  if (!Number.isFinite(backoffUntil)) return 0;
  return Math.max(0, backoffUntil - timestampOrNow(now));
}

export function nextFailureWindowState(
  currentStreak,
  currentWindow,
  {
    attempts = [],
    activeProducts = [],
    totalProducts = 0,
    now = Date.now(),
    windowMinutes = 10,
    minimumProducts = 2,
  } = {},
) {
  const streak = Math.max(0, Number(currentStreak) || 0);
  const normalizedAttempts = (Array.isArray(attempts) ? attempts : [])
    .filter((attempt) => String(attempt?.styleColor || '').trim())
    .map((attempt) => ({
      styleColor: String(attempt.styleColor).toUpperCase(),
      ok: attempt.ok === true,
    }));

  const nowMs = timestampOrNow(now);
  const maxAgeMs = Math.max(1, Number(windowMinutes) || 10) * 60 * 1000;
  const previousWindow = normalizeFailureWindow(currentWindow);
  const previousStartedAt = Date.parse(previousWindow?.startedAt || '');
  const expired = !Number.isFinite(previousStartedAt) || nowMs - previousStartedAt > maxAgeMs;

  if (!normalizedAttempts.length) {
    return expired
      ? { streak: 0, window: null }
      : { streak, window: previousWindow };
  }

  // 1商品でも成功すればフリート全体の障害ではない。
  if (normalizedAttempts.some((attempt) => attempt.ok)) {
    return { streak: 0, window: null };
  }

  const activeProductSet = new Set(
    (Array.isArray(activeProducts) ? activeProducts : [])
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean),
  );
  const failedProducts = new Set(
    (expired ? [] : previousWindow.products)
      .filter((styleColor) => !activeProductSet.size || activeProductSet.has(styleColor)),
  );
  for (const attempt of normalizedAttempts) failedProducts.add(attempt.styleColor);

  const activeCount = activeProductSet.size || Math.max(0, Number(totalProducts) || 0);
  const requiredProducts = Math.min(
    activeCount,
    Math.max(1, Number(minimumProducts) || 2),
  );
  const confirmedFleetFailure = requiredProducts > 0 && failedProducts.size >= requiredProducts;
  const activeStreak = expired ? 0 : streak;

  return {
    streak: confirmedFleetFailure ? activeStreak + 1 : activeStreak,
    window: {
      startedAt: expired ? new Date(nowMs).toISOString() : previousWindow.startedAt,
      products: [...failedProducts].sort(),
    },
  };
}

export function shouldStopDuringSweep({ singleSweep, deadline, now = Date.now() }) {
  // LOOP_MINUTES=0 は時間制限ではなく「全商品を1巡して終了」の単発モード。
  return !singleSweep && now >= deadline;
}

export function collectMonitorErrors(products, discoveryError = '') {
  const errors = [];
  if (discoveryError) errors.push(`新カラー探索: ${discoveryError}`);

  for (const product of products || []) {
    if (product.lastRuntimeError?.message) {
      errors.push(`${product.styleColor}: ${product.lastRuntimeError.message}`);
    } else if (product.lastResult?.ok === false) {
      errors.push(`${product.styleColor}: ${product.lastResult.statusLabel || '確認できません'}`);
    }
  }
  return errors;
}

function normalizeFailureWindow(value) {
  const startedAt = Date.parse(value?.startedAt || '');
  if (!Number.isFinite(startedAt)) return null;
  return {
    startedAt: new Date(startedAt).toISOString(),
    products: [...new Set(
      (Array.isArray(value?.products) ? value.products : [])
        .map((item) => String(item || '').trim().toUpperCase())
        .filter(Boolean),
    )].sort(),
  };
}

function timestampOrNow(value) {
  if (value !== null && value !== undefined && value !== '') {
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
