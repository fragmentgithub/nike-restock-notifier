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
  const availableCount = results.filter((result) => result.inStock).length;
  const monitorErrors = Array.isArray(state.errors)
    ? state.errors
    : state.lastError
      ? [state.lastError]
      : [];
  const stale = isStatusStale(state, config, products);

  sizeFiltersDisplay.textContent = config.sizeFilters || '全サイズ';
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

  productCount.textContent = String(products.length);
  availableProductCount.textContent = String(availableCount);
  lastChecked.textContent = latestCheckedAt
    ? formatDate(latestCheckedAt)
    : state.updatedAt
      ? formatDate(state.updatedAt)
      : '-';
  nextCheck.textContent = `巡回完了後 約${Math.max(1, Math.round(Number(config.intervalSeconds || 120) / 60))}分`;

  renderProducts(products);
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
  productGrid.innerHTML = `<p class="empty-state">ステータスを取得できません: ${escapeHtml(message)}</p>`;
  eventLog.innerHTML = '<li><span>-</span><strong>履歴を取得できません。</strong></li>';
}

function normalizedProducts(state) {
  if (Array.isArray(state.products) && state.products.length) {
    return state.products.map((item) => ({
      styleColor: item.styleColor || item.lastResult?.product?.styleColor || '',
      url: item.url || item.lastResult?.product?.url || '#',
      discoveredAt: item.discoveredAt || null,
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
    const status = item.lastError || result?.statusLabel || '初回確認待ち';
    const statusClass = result?.inStock ? 'available' : item.lastError || result?.ok === false ? 'error' : '';
    const sizeText = availableSizes.length
      ? availableSizes.map((size) => size.label).join(', ')
      : sizes.length
        ? '在庫ありサイズなし'
        : 'サイズ情報待ち';
    const url = safeUrl(product.url || item.url);

    return `
      <article class="product-card">
        <a class="product-card-image" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
          ${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" />` : '<span>NO IMAGE</span>'}
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
          <div class="product-card-footer">
            <span>${result?.checkedAt ? `確認 ${formatDate(result.checkedAt)}` : '未確認'}</span>
            <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">商品ページ</a>
          </div>
        </div>
      </article>`;
  }).join('');
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
  const lastCheckedAt = latestDate(products.map((item) => item.lastResult?.checkedAt)) || state.updatedAt;
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
  try {
    const url = new URL(value, 'https://www.nike.com');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // 不正なURLは下でフォールバックする。
  }
  return '#';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
