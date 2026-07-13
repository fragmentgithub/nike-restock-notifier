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
  return {
    nextStockKey,
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
  if (!result.ok) return entry.lastStockKey || '';

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
