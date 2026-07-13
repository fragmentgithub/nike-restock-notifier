export function stockKey(sizes = []) {
  return sizes
    .filter((size) => size.available)
    .map((size) => size.label || size.id)
    .sort()
    .join('|');
}

export function notificationDecision(entry, result) {
  const nextStockKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
  return {
    nextStockKey,
    shouldNotify:
      result.ok === true &&
      result.inStock === true &&
      Boolean(nextStockKey) &&
      nextStockKey !== String(entry.lastStockKey || ''),
  };
}

export function applyCheckState(
  entry,
  result,
  { nextStockKey, shouldNotify, notified, webhookConfigured },
) {
  if (!result.ok) return entry.lastStockKey || '';

  if (!result.inStock) {
    entry.lastStockKey = '';
    return entry.lastStockKey;
  }

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
