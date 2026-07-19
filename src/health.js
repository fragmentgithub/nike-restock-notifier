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
  const configuredThreshold = Math.max(5, Number(staleMinutes) || 50);
  const loopMinutes = Math.max(0, Number(status?.config?.loopMinutes) || 0);
  // status.json はrun終了時に更新され、次runの実行時間とPages CDNの反映遅延も加わる。
  // 有効なLOOP_MINUTESより短い閾値を指定しても定常的な停止誤報にならないよう余裕を持たせる。
  const threshold = Math.max(configuredThreshold, loopMinutes > 0 ? loopMinutes + 20 : 0);
  return {
    healthy: ageMinutes <= threshold,
    reason: ageMinutes <= threshold ? '' : `監視ステータスが ${ageMinutes} 分更新されていません`,
    updatedAt: new Date(updatedAt).toISOString(),
    ageMinutes,
    thresholdMinutes: threshold,
  };
}

export function shouldNotifyHealthTransition(previousStatus, currentStatus) {
  return currentStatus === 'unhealthy'
    ? previousStatus !== 'unhealthy'
    : previousStatus === 'unhealthy';
}

export function evaluateStatusFetchFailure(
  previousState,
  error,
  { threshold = 2 } = {},
) {
  const fetchFailureStreak = Math.max(0, Number(previousState?.fetchFailureStreak) || 0) + 1;
  const requiredFailures = Math.max(1, Number(threshold) || 2);
  const confirmed = fetchFailureStreak >= requiredFailures;
  const wasUnhealthy = previousState?.status === 'unhealthy';
  const detail = error?.message || String(error || 'unknown error');

  return {
    fetchFailureStreak,
    health: {
      healthy: !confirmed && !wasUnhealthy,
      reason: confirmed || wasUnhealthy
        ? `ステータス取得に ${fetchFailureStreak} 回連続で失敗しました: ${detail}`
        : `ステータス取得の一時失敗 (${fetchFailureStreak}/${requiredFailures}): ${detail}`,
      updatedAt: null,
      ageMinutes: null,
    },
  };
}

function validIsoDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
