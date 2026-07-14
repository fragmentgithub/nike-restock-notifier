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

await refreshState();
setInterval(refreshState, 60000);

async function refreshState() {
  try {
    const response = await fetch('status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`status.json: ${response.status}`);
    render(await response.json());
  } catch (error) {
    renderUnavailable(error.message);
  }
}

function render(state) {
  const config = state.config || {};
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
  const stale = isStatusStale(state, config, products);

  const overrideCount = Object.keys(config.productOverrides || {}).length;
  sizeFiltersDisplay.textContent = overrideCount
    ? `${config.sizeFilters || '全サイズ'} / 商品別${overrideCount}件`
    : config.sizeFilters || '全サイズ';
  intervalDisplay.textContent = `${Number(config.intervalSeconds || 120)}秒`;
  loopDisplay.textContent = `${Number(config.loopMinutes || 25)}分`;
  discordDisplay.textContent = config.discordWebhookSet ? '通知設定済み' : '未設定';

  const discoveryAt = state.discovery?.lastCheckedAt;
  discoveryHint.textContent = state.discovery?.lastError
    ? `新カラー探索でエラー（既知商品は監視継続）: ${state.discovery.lastError}`
    : discoveryAt
      ? `新カラー自動追尾: 有効 / 最終探索 ${formatDate(discoveryAt)}`
      : '新カラー自動追尾: 初回探索待ち';

  runStatus.textContent = stale ? '更新遅延' : '自動監視中';
  runStatus.className = `status-pill ${stale ? 'error' : 'running'}`;
  checkStatus.textContent = monitorErrors.length ? `${monitorErrors.length}件エラー` : '正常';
  checkStatus.className = `small-status ${monitorErrors.length ? 'error' : 'ok'}`;
  monitorErrorHint.hidden = monitorErrors.length === 0;
  monitorErrorHint.textContent = monitorErrors.join(' / ');

  productCount.textContent = String(products.length);
  availableProductCount.textContent = String(availableCount);
  lastChecked.textContent = latestCheckedAt
    ? formatDate(latestCheckedAt)
    : state.updatedAt
      ? formatDate(state.updatedAt)
      : '-';
  nextCheck.textContent = `巡回完了後 約${Math.max(1, Math.round(Number(config.intervalSeconds || 120) / 60))}分`;

  renderProducts(products);
  renderQuality(state.metrics || {});
  renderStockHistory(state.history || []);
  renderEvents(state.events || []);
}

function renderUnavailable(message) {
  runStatus.textContent = '取得失敗';
  runStatus.className = 'status-pill error';
  checkStatus.textContent = 'エラー';
  checkStatus.className = 'small-status error';
  productCount.textContent = '-';
  availableProductCount.textContent = '-';
  lastChecked.textContent = '-';
  nextCheck.textContent = '-';
  monitorErrorHint.hidden = false;
  monitorErrorHint.textContent = `ステータス取得エラー: ${message}`;
  productGrid.innerHTML = `<p class="empty-state">ステータスを取得できません: ${escapeHtml(message)}</p>`;
  qualityStatus.textContent = '取得失敗';
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

function renderProducts(products) {
  if (!products.length) {
    productGrid.innerHTML = '<p class="empty-state">商品データはまだありません。</p>';
    return;
  }

  productGrid.innerHTML = products.map((item) => {
    const result = item.lastResult;
    const product = result?.product || {};
    const sizes = result?.sizes || [];
    const availableSizes = sizes.filter((size) => size.available);
    const title = product.title || `Nike Mind 001 ${item.styleColor}`;
    const subtitle = [product.subtitle, item.styleColor, product.price].filter(Boolean).join(' / ');
    const disabled = item.settings?.enabled === false;
    const paused = Boolean(item.pausedAt);
    const status = disabled
      ? '設定で無効'
      : paused
        ? '販売終了候補・自動休止'
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
    const notifyLabel = item.settings?.notify === false ? '通知OFF' : '通知ON';

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

function renderQuality(metrics) {
  const hasChecks = Number(metrics.checks) > 0;
  const healthy = hasChecks && Number(metrics.successRate) >= 90;
  qualityStatus.textContent = hasChecks ? (healthy ? '良好' : '要確認') : '集計待ち';
  qualityStatus.className = `small-status ${healthy ? 'ok' : hasChecks ? 'error' : ''}`;
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
  if (!lastCheckedAt) return false;
  const intervalSeconds = Number(config.intervalSeconds || 120);
  const loopMinutes = Number(config.loopMinutes || 25);
  const staleAfterSeconds = Math.max(intervalSeconds * 3, loopMinutes * 60 * 2);
  return Date.now() - new Date(lastCheckedAt).getTime() > staleAfterSeconds * 1000;
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
