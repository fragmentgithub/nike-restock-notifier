export const DEFAULT_STATUS_PAGE_URL = 'https://nike-restock-viewer.only-this-moment.workers.dev/';

export function evaluateWorkerHealth(status, { now = Date.now() } = {}) {
  const updatedAt = validIsoDate(status?.lastCompletedAt);
  const ageMinutes = updatedAt ? Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60000)) : null;
  let reason = '';
  if (status?.mode !== 'active') reason = '本番監視が停止または検証モードになっています';
  else if (status.webhookConfigured !== true) reason = 'Discord通知先が設定されていません';
  else if (!updatedAt || Date.parse(updatedAt) > now + 300000) reason = '監視の完了時刻を確認できません';
  else if (status.monitorHealthy === false || !Number.isFinite(Date.parse(status.nextAlarmAt || '')) ||
      Date.parse(status.nextAlarmAt) < now - 120000) reason = '監視処理または次回起動の予約に異常があります';
  else if (status.backupHealthy !== true) reason = Number(status.backupFailureStreak) > 0
    ? '監視データのバックアップに継続的な失敗があります'
    : '監視データのバックアップが24時間以上成功していません';
  else if (status.healthy !== true) reason = '監視処理に異常があります';
  return { healthy: !reason, reason, updatedAt, ageMinutes };
}

export function resolveStatusPageUrl(value) {
  return privateHttpsRoot(value) || DEFAULT_STATUS_PAGE_URL;
}

export function createHealthNotificationPayload(result, pageUrl, { now = Date.now() } = {}) {
  const recovered = result.healthy;
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: recovered ? 'Nike監視が復旧しました' : 'Nike監視に異常があります',
      description: recovered ? '監視とバックアップが正常範囲へ戻りました。' : result.reason,
      url: resolveStatusPageUrl(pageUrl),
      color: recovered ? 0x26734d : 0xa43f3a,
      fields: result.updatedAt
        ? [{ name: '最終更新', value: `<t:${Math.floor(Date.parse(result.updatedAt) / 1000)}:R>` }]
        : [],
      timestamp: new Date(now).toISOString(),
    }],
  };
}

export function evaluateMonitorHealth(
  status,
  { now = Date.now(), staleMinutes = 50, futureToleranceMinutes = 5 } = {},
) {
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
  const futureToleranceMs = Math.max(0, Number(futureToleranceMinutes) || 0) * 60_000;
  if (updatedAt - now > futureToleranceMs) {
    return {
      healthy: false,
      reason: 'status.json の updatedAt が現在時刻より先になっています',
      updatedAt: new Date(updatedAt).toISOString(),
      ageMinutes: null,
    };
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

function privateHttpsRoot(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) return '';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}
