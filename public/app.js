const DEFAULT_PRODUCT_URL =
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-c9CoQHlk/HQ4307-005';

const form = document.querySelector('#settingsForm');
const saveButton = form.querySelector('button[type="submit"]');
const productUrlInput = document.querySelector('#productUrl');
const sizeFiltersInput = document.querySelector('#sizeFilters');
const intervalInput = document.querySelector('#intervalSeconds');
const discordWebhookInput = document.querySelector('#discordWebhook');
const webhookHint = document.querySelector('#webhookHint');
const discoveryHint = document.querySelector('#discoveryHint');
const startButton = document.querySelector('#startButton');
const stopButton = document.querySelector('#stopButton');
const checkButton = document.querySelector('#checkButton');
const notifyButton = document.querySelector('#notifyButton');
const testDiscordButton = document.querySelector('#testDiscordButton');
const runStatus = document.querySelector('#runStatus');
const checkStatus = document.querySelector('#checkStatus');
const productCount = document.querySelector('#productCount');
const availableProductCount = document.querySelector('#availableProductCount');
const lastChecked = document.querySelector('#lastChecked');
const nextCheck = document.querySelector('#nextCheck');
const productGrid = document.querySelector('#productGrid');
const eventLog = document.querySelector('#eventLog');
const pagesLinks = document.querySelector('#pagesLinks');

let state = null;
let staticMode = false;
let eventStream = null;

refreshState().then(() => {
  if (!staticMode) connectEvents();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (staticMode) return showToast('GitHub Pages版の設定はGitHub Actions Variablesで管理します。');
  await saveConfig();
});

startButton.addEventListener('click', async () => {
  if (staticMode) return;
  await saveConfig(false);
  await api('/api/start', { method: 'POST' });
  showToast('監視を開始しました。');
});

stopButton.addEventListener('click', async () => {
  if (staticMode) return;
  await api('/api/stop', { method: 'POST' });
  showToast('監視を停止しました。');
});

checkButton.addEventListener('click', async () => {
  if (staticMode) return;
  await saveConfig(false);
  await api('/api/check', { method: 'POST' });
});

notifyButton.addEventListener('click', async () => {
  if (!('Notification' in window)) return showToast('このブラウザは通知に対応していません。');
  const permission = await Notification.requestPermission();
  showToast(permission === 'granted' ? 'ブラウザ通知を許可しました。' : 'ブラウザ通知は許可されていません。');
});

testDiscordButton.addEventListener('click', async () => {
  if (staticMode) return showToast('Discord通知はGitHub Actionsから送信されます。');
  await saveConfig(false);
  await api('/api/test-discord', { method: 'POST' });
  showToast('Discordへテスト通知を送りました。');
});

async function saveConfig(showSaved = true) {
  const payload = {
    productUrl: productUrlInput.value,
    sizeFilters: sizeFiltersInput.value,
    intervalSeconds: Number(intervalInput.value),
    running: state?.config?.running || false,
  };

  if (discordWebhookInput.value.trim() || !state?.config?.discordWebhookSet) {
    payload.discordWebhook = discordWebhookInput.value;
  }

  const nextState = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  render(nextState);
  if (showSaved) showToast('設定を保存しました。');
}

function connectEvents() {
  if (!('EventSource' in window) || eventStream) return;
  eventStream = new EventSource('/api/events');
  eventStream.addEventListener('state', (event) => render(JSON.parse(event.data)));
  eventStream.addEventListener('restock', (event) => {
    const payload = JSON.parse(event.data);
    showToast(`${payload.title}\n${payload.message}`);
    sendBrowserNotification(payload);
  });
  eventStream.addEventListener('event', () => refreshState());
}

async function refreshState() {
  try {
    const liveState = await api('/api/state', { suppressToast: true });
    staticMode = false;
    render(liveState);
  } catch {
    staticMode = true;
    render(await loadStaticState());
  }
}

async function loadStaticState() {
  try {
    const response = await fetch('status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('status.json not found');
    const payload = await response.json();
    return {
      config: {
        ...(payload.config || {}),
        productUrl: payload.config?.productUrl || DEFAULT_PRODUCT_URL,
        intervalSeconds: payload.config?.intervalSeconds || 120,
        discordWebhook: '',
        discordWebhookSet: Boolean(payload.config?.discordWebhookSet),
        running: false,
      },
      discovery: payload.discovery || null,
      products: payload.products || [],
      lastResult: payload.lastResult || null,
      lastError: payload.lastError || null,
      checking: false,
      nextCheckAt: null,
      events: payload.events || [],
      pagesUpdatedAt: payload.updatedAt || null,
    };
  } catch {
    return {
      config: { productUrl: DEFAULT_PRODUCT_URL, sizeFilters: '', intervalSeconds: 120 },
      products: [],
      lastResult: null,
      lastError: null,
      checking: false,
      events: [],
    };
  }
}

async function api(path, options = {}) {
  const { suppressToast = false, ...fetchOptions } = options;
  setBusy(true);
  try {
    const response = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...fetchOptions,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(payload.error || 'リクエストに失敗しました。');
    return payload;
  } catch (error) {
    if (!suppressToast) showToast(error.message);
    throw error;
  } finally {
    setBusy(false);
  }
}

function render(nextState) {
  state = nextState;
  const config = state.config || {};
  const products = normalizedProducts(state);
  const results = products.map((item) => item.lastResult).filter(Boolean);
  const latestCheckedAt = latestDate(results.map((result) => result.checkedAt));
  const availableCount = results.filter((result) => result.inStock).length;

  productUrlInput.value = config.productUrl || DEFAULT_PRODUCT_URL;
  sizeFiltersInput.value = config.sizeFilters || '';
  intervalInput.value = config.intervalSeconds || 120;
  discordWebhookInput.value = '';
  webhookHint.textContent = staticMode
    ? 'Discord webhookはGitHub Actions Secretsで管理されています。'
    : config.discordWebhookSet
      ? 'Discord webhookは設定済みです。変更する場合だけ入力してください。'
      : 'Discord webhookは未設定です。';

  const discoveryAt = state.discovery?.lastCheckedAt;
  discoveryHint.textContent = state.discovery?.lastError
    ? `新カラー探索でエラー（既知の商品は監視継続）: ${state.discovery.lastError}`
    : discoveryAt
      ? `新カラー自動追尾: 有効 / 最終探索 ${formatDate(discoveryAt)}`
      : '新カラー自動追尾: 初回探索待ち';

  runStatus.textContent = staticMode ? '自動監視中' : config.running ? '監視中' : '停止中';
  runStatus.className = `status-pill ${config.running || staticMode ? 'running' : ''}`;

  const stale = staticMode && isStaticStatusStale(state, config);
  checkStatus.textContent = stale ? '更新遅延' : state.checking ? '確認中' : state.lastError ? '一部エラー' : '稼働中';
  checkStatus.className = `small-status ${state.lastError || stale ? 'error' : 'ok'}`;

  productCount.textContent = String(products.length);
  availableProductCount.textContent = String(availableCount);
  lastChecked.textContent = latestCheckedAt
    ? formatDate(latestCheckedAt)
    : state.pagesUpdatedAt
      ? formatDate(state.pagesUpdatedAt)
      : '-';
  nextCheck.textContent = nextCheckText(state, config);
  renderProducts(products);
  renderEvents(state.events || []);
  setStaticControls();
}

function normalizedProducts(currentState) {
  if (Array.isArray(currentState.products) && currentState.products.length) {
    return currentState.products.map((item) => ({
      styleColor: item.styleColor || item.lastResult?.product?.styleColor || '',
      url: item.url || item.lastResult?.product?.url || '#',
      discoveredAt: item.discoveredAt || null,
      lastResult: item.lastResult || null,
    }));
  }

  if (currentState.lastResult) {
    return [{
      styleColor: currentState.lastResult.product?.styleColor || '',
      url: currentState.lastResult.product?.url || currentState.config?.productUrl || '#',
      discoveredAt: null,
      lastResult: currentState.lastResult,
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
    const status = result?.statusLabel || '初回確認待ち';
    const statusClass = result?.inStock ? 'available' : result?.ok === false ? 'error' : '';
    const sizeText = availableSizes.length
      ? availableSizes.map((size) => size.label).join(', ')
      : sizes.length
        ? '在庫ありサイズなし'
        : 'サイズ情報待ち';

    return `
      <article class="product-card">
        <a class="product-card-image" href="${escapeHtml(product.url || item.url)}" target="_blank" rel="noreferrer">
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
            <a href="${escapeHtml(product.url || item.url)}" target="_blank" rel="noreferrer">商品ページ</a>
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

function sendBrowserNotification(payload) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(payload.title, {
    body: payload.message,
    icon: payload.product?.imageUrl || undefined,
    tag: `nike-restock-${payload.product?.styleColor || 'product'}`,
  });
}

function setBusy(isBusy) {
  for (const button of [saveButton, startButton, stopButton, checkButton, testDiscordButton]) {
    button.disabled = staticMode || isBusy;
  }
}

function setStaticControls() {
  if (pagesLinks) pagesLinks.hidden = !staticMode;
  for (const input of [productUrlInput, sizeFiltersInput, intervalInput, discordWebhookInput]) {
    input.disabled = staticMode;
  }
  for (const button of [saveButton, startButton, stopButton, checkButton, testDiscordButton]) {
    button.disabled = staticMode;
  }
}

function nextCheckText(currentState, config) {
  if (currentState.nextCheckAt) return formatDate(currentState.nextCheckAt);
  if (!staticMode) return '-';
  const intervalSeconds = Number(config.intervalSeconds || 120);
  const loopMinutes = Number(config.loopMinutes || 0);
  return loopMinutes
    ? `各商品 約${Math.max(1, Math.round(intervalSeconds / 60))}分ごと`
    : `${Math.max(1, Math.round(intervalSeconds / 60))}分ごと`;
}

function isStaticStatusStale(currentState, config) {
  const products = normalizedProducts(currentState);
  const lastCheckedAt = latestDate(products.map((item) => item.lastResult?.checkedAt)) || currentState.pagesUpdatedAt;
  if (!lastCheckedAt) return false;
  const intervalSeconds = Number(config.intervalSeconds || 120);
  const loopMinutes = Number(config.loopMinutes || 0);
  const staleAfterSeconds = Math.max(intervalSeconds * 3, loopMinutes * 60 * 2);
  return Date.now() - new Date(lastCheckedAt).getTime() > staleAfterSeconds * 1000;
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
