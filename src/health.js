export function evaluateMonitorHealth(status, { now = Date.now(), staleMinutes = 50 } = {}) {
  const configurationError = String(status?.config?.productConfigError || '').trim();
  if (configurationError) {
    return {
      healthy: false,
      reason: `監視設定エラー: ${configurationError}`,
      updatedAt: validIsoDate(status?.updatedAt),
      ageMinutes: null,
    };
  }
  const updatedAt = Date.parse(status?.updatedAt || '');
  if (!Number.isFinite(updatedAt)) {
    return { healthy: false, reason: 'status.json に有効な updatedAt がありません', updatedAt: null, ageMinutes: null };
  }
  const ageMinutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  const threshold = Math.max(5, Number(staleMinutes) || 50);
  return {
    healthy: ageMinutes <= threshold,
    reason: ageMinutes <= threshold ? '' : `監視ステータスが ${ageMinutes} 分更新されていません`,
    updatedAt: new Date(updatedAt).toISOString(),
    ageMinutes,
  };
}

export function shouldNotifyHealthTransition(previousStatus, currentStatus) {
  return currentStatus === 'unhealthy'
    ? previousStatus !== 'unhealthy'
    : previousStatus === 'unhealthy';
}

function validIsoDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
