const runStatus = document.querySelector('#runStatus');
const checkStatus = document.querySelector('#checkStatus');
const sizeFiltersDisplay = document.querySelector('#sizeFiltersDisplay');
const intervalDisplay = document.querySelector('#intervalDisplay');
const loopDisplay = document.querySelector('#loopDisplay');
const discordDisplay = document.querySelector('#discordDisplay');
const discoveryHint = document.querySelector('#discoveryHint');
const productCount = document.querySelector('#productCount');
const availableProductCount = document.querySelector('#availableProductCount');
const lastChecked = document.querySelector('#lastChecked');
const nextCheck = document.querySelector('#nextCheck');
const productGrid = document.querySelector('#productGrid');
const eventLog = document.querySelector('#eventLog');
const stockHistory = document.querySelector('#stockHistory');
const qualityStatus = document.querySelector('#qualityStatus');
const successRate = document.querySelector('#successRate');
const averageResponse = document.querySelector('#averageResponse');
const checks24h = document.querySelector('#checks24h');
const lastSuccess = document.querySelector('#lastSuccess');
const activeProductCount = document.querySelector('#activeProductCount');
const pausedProductCount = document.querySelector('#pausedProductCount');
const monitorErrorHint = document.querySelector('#monitorErrorHint');
const appShell = document.querySelector('#appShell');
const platformDisplay = document.querySelector('#platformDisplay');
const loopLabel = document.querySelector('#loopLabel');

const REFRESH_INTERVAL_MS = 60000;
const STATUS_TIMEOUT_MS = 15000;
let refreshInFlight = false;
let lastGoodState = null;

await refreshState();
setInterval(() => void refreshState(), REFRESH_INTERVAL_MS);

async function refreshState() {
  if (refreshInFlight) return;

  refreshInFlight = true;
  appShell.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

  try {
    const response = await fetch('status.json', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`status.json: ${response.status}`);
    const state = await response.json();
    validateStatusPayload(state);
    render(state);
    lastGoodState = state;
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `${STATUS_TIMEOUT_MS / 1000}秒以内に応答がありませんでした`
      : error?.message || '不明なエラー';
    renderUnavailable(message, { preserveData: Boolean(lastGoodState) });
  } finally {
    clearTimeout(timeoutId);
    refreshInFlight = false;
    appShell.setAttribute('aria-busy', 'false');
  }
}

function render(state) {
  const config = state.config || {};
  const cloudflare = config.runtime === 'cloudflare' || state.platform?.runtime === 'cloudflare';
  const mode = state.meta?.mode || state.platform?.mode || state.mode || 'active';
  const paused = cloudflare && mode === 'paused';
  const shadow = cloudflare && mode === 'shadow';
  const products = normalizedProducts(state);
  const results = products.map((item) => item.lastResult).filter(Boolean);
  const latestCheckedAt = latestDate(results.map((result) => result.checkedAt));
  const availableCount = products.filter((item) =>
    item.settings?.enabled !== false && !item.pausedAt && item.lastResult?.inStock,
  ).length;
  const monitorErrors = Array.isArray(state.errors)
    ? state.errors
    : state.lastError
      ? [state.lastError]
      : [];
  const stale = !paused && isStatusStale(state, config, products);
  const configuredLoopMinutes = Number(config.loopMinutes);
  const loopMinutesValue = Number.isFinite(configuredLoopMinutes) ? configuredLoopMinutes : 25;

  const overrideCount = Object.keys(config.productOverrides || {}).length;
  sizeFiltersDisplay.textContent = overrideCount
    ? `${config.sizeFilters || '全サイズ'} / 商品別${overrideCount}件`
    : config.sizeFilters || '全サイズ';
  intervalDisplay.textContent = `${Number(config.intervalSeconds || 120)}秒`;
  platformDisplay.textContent = cloudflare ? 'Cloudflare' : 'GitHub Actions';
  loopLabel.textContent = cloudflare ? '稼働方式' : '実行時間';
  loopDisplay.textContent = cloudflare ? '時刻に合わせて自動確認' : `${loopMinutesValue}分`;
  discordDisplay.textContent = paused
    ? '停止中'
    : shadow
      ? '検証中・通知OFF'
      : config.discordWebhookSet ? '通知設定済み' : '未設定';

  const discoveryAt = state.discovery?.lastCheckedAt;
  discoveryHint.textContent = paused
    ? `新商品自動追尾: 停止中${discoveryAt ? ` / 最終探索 ${formatDate(discoveryAt)}` : ''}`
    : state.discovery?.lastError
      ? `商品探索でエラー（既知商品は監視継続）: ${state.discovery.lastError}`
      : discoveryAt
        ? `新商品自動追尾: 有効 / 最終探索 ${formatDate(discoveryAt)}`
        : '新商品自動追尾: 初回探索待ち';

  setText(runStatus, paused ? '一時停止中' : stale ? '更新遅延' : shadow ? '検証中・通知OFF' : '自動監視中');
  runStatus.className = `status-pill ${stale ? 'error' : paused ? '' : 'running'}`;
  const statusMessages = stale
    ? ['ステータスの更新が遅延しています。表示内容は最新でない可能性があります。', ...monitorErrors]
    : monitorErrors;
  setText(checkStatus, stale
    ? '状態不明'
    : monitorErrors.length
      ? `${monitorErrors.length}件エラー`
      : paused ? '一時停止' : '正常');
  checkStatus.className = `small-status ${stale || monitorErrors.length ? 'error' : paused ? '' : 'ok'}`;
  monitorErrorHint.setAttribute('role', 'status');
  monitorErrorHint.setAttribute('aria-live', 'polite');
  monitorErrorHint.hidden = statusMessages.length === 0;
  setText(monitorErrorHint, statusMessages.join(' / '));

  productCount.textContent = String(products.length);
  availableProductCount.textContent = String(availableCount);
  lastChecked.textContent = latestCheckedAt
    ? formatDate(latestCheckedAt)
    : state.updatedAt
      ? formatDate(state.updatedAt)
      : '-';
  const monitorableCount = products.filter((item) => item.settings?.enabled !== false).length;
  nextCheck.textContent = paused
    ? '停止中'
    : stale
      ? '更新遅延のため不明'
      : state.nextCheckAt
        ? formatDate(state.nextCheckAt)
        : monitorableCount > 0
          ? `商品ごと 約${Math.max(1, Math.round(Number(config.intervalSeconds || 120) / 60))}分`
          : '監視対象なし';

  renderProducts(products, { notificationsStopped: paused || shadow });
  renderQuality(state.metrics || {}, { stale });
  renderStockHistory(state.history || []);
  renderEvents(state.events || []);
}

function validateStatusPayload(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('status.json の形式が不正です');
  }
  if (!Number.isFinite(Date.parse(state.updatedAt || ''))) {
    throw new Error('status.json に有効な更新時刻がありません');
  }
  if (state.products !== undefined && !Array.isArray(state.products)) {
    throw new Error('status.json の商品データ形式が不正です');
  }
}

function renderUnavailable(message, { preserveData = false } = {}) {
  setText(runStatus, '取得失敗');
  runStatus.className = 'status-pill error';
  setText(checkStatus, preserveData ? '更新エラー' : 'エラー');
  checkStatus.className = 'small-status error';
  monitorErrorHint.setAttribute('role', 'alert');
  monitorErrorHint.setAttribute('aria-live', 'assertive');
  monitorErrorHint.hidden = false;
  setText(monitorErrorHint, preserveData
    ? `最新ステータスを取得できません。前回取得したデータを表示しています: ${message}`
    : `ステータス取得エラー: ${message}`);

  if (preserveData) {
    nextCheck.textContent = '最新情報を取得できません';
    setText(qualityStatus, '更新エラー');
    qualityStatus.className = 'small-status error';
    return;
  }

  productCount.textContent = '-';
  availableProductCount.textContent = '-';
  lastChecked.textContent = '-';
  nextCheck.textContent = '-';
  discoveryHint.textContent = '新商品自動追尾: ステータス取得失敗';
  productGrid.innerHTML = `<p class="empty-state">ステータスを取得できません: ${escapeHtml(message)}</p>`;
  setText(qualityStatus, '取得失敗');
  qualityStatus.className = 'small-status error';
  for (const element of [successRate, averageResponse, checks24h, lastSuccess, activeProductCount, pausedProductCount]) {
    element.textContent = '-';
  }
  stockHistory.innerHTML = '<li><span>-</span><strong>履歴を取得できません。</strong></li>';
  eventLog.innerHTML = '<li><span>-</span><strong>履歴を取得できません。</strong></li>';
}

function normalizedProducts(state) {
  if (Array.isArray(state.products) && state.products.length) {
    return state.products.map((item) => ({
      styleColor: item.styleColor || item.lastResult?.product?.styleColor || '',
      url: item.url || item.lastResult?.product?.url || '#',
      discoveredAt: item.discoveredAt || null,
      pausedAt: item.pausedAt || null,
      pausedReason: item.pausedReason || '',
      settings: item.settings || { sizeFilters: '', notify: true, enabled: true },
      stockHistory: item.stockHistory || [],
      metrics: item.metrics || {},
      lastError: item.lastError || null,
      lastResult: item.lastResult || null,
    }));
  }

  if (state.lastResult) {
    return [{
      styleColor: state.lastResult.product?.styleColor || '',
      url: state.lastResult.product?.url || state.config?.productUrl || '#',
      discoveredAt: null,
      lastError: state.lastError || null,
      lastResult: state.lastResult,
    }];
  }
  return [];
}

function renderProducts(products, { notificationsStopped = false } = {}) {
  if (!products.length) {
    productGrid.innerHTML = '<p class="empty-state">商品データはまだありません。</p>';
    return;
  }

  productGrid.innerHTML = products.map((item) => {
    const result = item.lastResult;
    const product = result?.product || {};
    const sizes = result?.sizes || [];
    const availableSizes = sizes.filter((size) => size.available);
    const title = product.title || `Nike商品 ${item.styleColor}`;
    const subtitle = [product.subtitle, item.styleColor, product.price].filter(Boolean).join(' / ');
    const disabled = item.settings?.enabled === false;
    const paused = Boolean(item.pausedAt);
    const status = disabled
      ? '設定で無効'
      : paused
        ? item.pausedReason === 'unreachable'
          ? '長時間確認不能・自動休止'
          : '販売終了候補・自動休止'
        : item.lastError || result?.statusLabel || '初回確認待ち';
    const statusClass = result?.inStock && !paused && !disabled
      ? 'available'
      : item.lastError || result?.ok === false || paused || disabled
        ? 'error'
        : '';
    const sizeText = availableSizes.length
      ? availableSizes.map((size) => size.label).join(', ')
      : sizes.length
        ? '在庫ありサイズなし'
        : 'サイズ情報待ち';
    const url = safeUrl(product.url || item.url);
    const imageUrl = safeUrl(product.imageUrl || '');
    const configuredSizes = item.settings?.sizeFilters || '全サイズ';
    const notifyLabel = notificationsStopped || item.settings?.notify === false ? '通知OFF' : '通知ON';

    return `
      <article class="product-card">
        <a class="product-card-image" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
          ${imageUrl !== '#' ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" />` : '<span>NO IMAGE</span>'}
        </a>
        <div class="product-card-body">
          <div class="product-card-heading">
            <div>
              <p class="style-code">${escapeHtml(item.styleColor || product.styleColor || '-')}</p>
              <h3>${escapeHtml(title)}</h3>
            </div>
            <span class="stock-badge ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <p class="product-subtitle">${escapeHtml(subtitle)}</p>
          <p class="size-summary"><strong>在庫サイズ</strong> ${escapeHtml(sizeText)}</p>
          <p class="product-policy"><strong>監視対象</strong> ${escapeHtml(configuredSizes)} / ${escapeHtml(notifyLabel)} / 成功率 ${formatPercent(item.metrics?.successRate)}</p>
          <div class="product-card-footer">
            <span>${result?.checkedAt ? `確認 ${formatDate(result.checkedAt)}` : '未確認'}</span>
            <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">商品ページ</a>
          </div>
        </div>
      </article>`;
  }).join('');
}

function renderQuality(metrics, { stale = false } = {}) {
  const hasChecks = Number(metrics.checks) > 0;
  const healthy = hasChecks && Number(metrics.successRate) >= 90;
  setText(
    qualityStatus,
    stale ? '更新遅延' : hasChecks ? (healthy ? '良好' : '要確認') : '集計待ち',
  );
  qualityStatus.className = `small-status ${stale ? 'error' : healthy ? 'ok' : hasChecks ? 'error' : ''}`;
  successRate.textContent = formatPercent(metrics.successRate);
  averageResponse.textContent = metrics.averageResponseMs !== null
    && metrics.averageResponseMs !== undefined
    && Number.isFinite(Number(metrics.averageResponseMs))
    ? `${Number(metrics.averageResponseMs).toLocaleString('ja-JP')}ms`
    : '-';
  checks24h.textContent = Number(metrics.checks || 0).toLocaleString('ja-JP');
  lastSuccess.textContent = metrics.lastSuccessAt ? formatDate(metrics.lastSuccessAt) : '-';
  activeProductCount.textContent = String(metrics.activeProducts ?? '-');
  pausedProductCount.textContent = String(metrics.pausedProducts ?? '-');
}

function renderStockHistory(items) {
  if (!items.length) {
    stockHistory.innerHTML = '<li><span>-</span><strong>在庫変化はまだありません。</strong></li>';
    return;
  }
  stockHistory.innerHTML = items.slice(0, 50).map((item) => `
    <li>
      <span>${formatDate(item.at)}</span>
      <strong>${escapeHtml(item.message)}</strong>
    </li>`).join('');
}

function renderEvents(events) {
  if (!events.length) {
    eventLog.innerHTML = '<li><span>-</span><strong>履歴はまだありません。</strong></li>';
    return;
  }

  eventLog.innerHTML = events.slice(0, 40).map((event) => `
    <li>
      <span>${formatDate(event.at)}</span>
      <strong>${escapeHtml(event.message)}</strong>
    </li>`).join('');
}

function isStatusStale(state, config, products) {
  const lastCheckedAt = state.updatedAt || latestDate(products.map((item) => item.lastResult?.checkedAt));
  if (!lastCheckedAt) return true;
  const lastCheckedTimestamp = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastCheckedTimestamp)) return true;
  const configuredIntervalSeconds = Number(config.intervalSeconds);
  const intervalSeconds = Number.isFinite(configuredIntervalSeconds) && configuredIntervalSeconds > 0
    ? configuredIntervalSeconds
    : 120;
  const configuredLoopMinutes = Number(config.loopMinutes);
  const loopMinutes = Number.isFinite(configuredLoopMinutes) && configuredLoopMinutes >= 0
    ? configuredLoopMinutes
    : 25;
  const cloudflare = config.runtime === 'cloudflare' || state.platform?.runtime === 'cloudflare';
  const staleAfterSeconds = cloudflare
    ? Math.max(intervalSeconds * 3, 600)
    : Math.max(intervalSeconds * 3, loopMinutes * 60 * 2);
  // Backoff and automatically paused products can have a later scheduled check.
  // Allow two minutes after that check is due before treating the status as stale.
  const nextCheckTimestamp = cloudflare ? Date.parse(state.nextCheckAt || '') : Number.NaN;
  const staleAt = Math.max(
    lastCheckedTimestamp + staleAfterSeconds * 1000,
    Number.isFinite(nextCheckTimestamp) && nextCheckTimestamp >= lastCheckedTimestamp
      ? nextCheckTimestamp + 2 * 60 * 1000
      : 0,
  );
  const ageMs = Date.now() - lastCheckedTimestamp;
  // A materially future timestamp is just as untrustworthy as an old one.
  return ageMs < -5 * 60 * 1000 || Date.now() > staleAt;
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function safeUrl(value) {
  if (!String(value || '').trim()) return '#';
  try {
    const url = new URL(value, 'https://www.nike.com');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // 不正なURLは下でフォールバックする。
  }
  return '#';
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '-';
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : '-';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setText(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}
