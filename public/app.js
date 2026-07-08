const DEFAULT_PRODUCT_URL =
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005';

const form = document.querySelector('#settingsForm');
const saveButton = form.querySelector('button[type="submit"]');
const productUrlInput = document.querySelector('#productUrl');
const sizeFiltersInput = document.querySelector('#sizeFilters');
const intervalInput = document.querySelector('#intervalSeconds');
const discordWebhookInput = document.querySelector('#discordWebhook');
const webhookHint = document.querySelector('#webhookHint');
const startButton = document.querySelector('#startButton');
const stopButton = document.querySelector('#stopButton');
const checkButton = document.querySelector('#checkButton');
const notifyButton = document.querySelector('#notifyButton');
const testDiscordButton = document.querySelector('#testDiscordButton');
const runStatus = document.querySelector('#runStatus');
const checkStatus = document.querySelector('#checkStatus');
const productImage = document.querySelector('#productImage');
const productTitle = document.querySelector('#productTitle');
const productSubtitle = document.querySelector('#productSubtitle');
const productLink = document.querySelector('#productLink');
const stockStatus = document.querySelector('#stockStatus');
const lastChecked = document.querySelector('#lastChecked');
const nextCheck = document.querySelector('#nextCheck');
const sizeRows = document.querySelector('#sizeRows');
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
  if (staticMode) {
    showToast('GitHub Pages版では画面から設定変更できません。');
    return;
  }

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
  if (!('Notification' in window)) {
    showToast('このブラウザは通知に対応していません。');
    return;
  }

  const permission = await Notification.requestPermission();
  showToast(permission === 'granted' ? 'ブラウザ通知を許可しました。' : 'ブラウザ通知は許可されていません。');
});

testDiscordButton.addEventListener('click', async () => {
  if (staticMode) {
    showToast('GitHub Pages版のDiscord通知はGitHub Actionsから送信されます。');
    return;
  }

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

  eventStream.addEventListener('state', (event) => {
    render(JSON.parse(event.data));
  });

  eventStream.addEventListener('restock', (event) => {
    const payload = JSON.parse(event.data);
    showToast(`${payload.title}\n${payload.message}`);
    sendBrowserNotification(payload);
  });

  eventStream.addEventListener('event', () => {
    refreshState();
  });
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
        productUrl: payload.config?.productUrl || DEFAULT_PRODUCT_URL,
        sizeFilters: payload.config?.sizeFilters || '',
        intervalSeconds: payload.config?.intervalSeconds || 300,
        loopMinutes: Number(payload.config?.loopMinutes) || 0,
        discordWebhook: '',
        discordWebhookSet: Boolean(payload.config?.discordWebhookSet),
        running: false,
      },
      lastResult: payload.lastResult || null,
      lastError: payload.lastError || null,
      checking: false,
      nextCheckAt: null,
      events: payload.events || [],
      pagesUpdatedAt: payload.updatedAt || null,
    };
  } catch {
    return {
      config: {
        productUrl: DEFAULT_PRODUCT_URL,
        sizeFilters: '',
        intervalSeconds: 300,
        discordWebhook: '',
        discordWebhookSet: false,
        running: false,
      },
      lastResult: null,
      lastError: null,
      checking: false,
      nextCheckAt: null,
      events: [
        {
          id: 'static-initial',
          type: 'settings',
          message: 'GitHub Actionsが実行されると直近の確認結果が表示されます。',
          at: new Date().toISOString(),
          result: null,
        },
      ],
    };
  }
}

async function api(path, options = {}) {
  const { suppressToast = false, ...fetchOptions } = options;

  setBusy(true);
  try {
    const response = await fetch(path, {
      headers: {
        'content-type': 'application/json',
      },
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
  const result = state.lastResult;

  productUrlInput.value = config.productUrl || '';
  sizeFiltersInput.value = config.sizeFilters || '';
  intervalInput.value = config.intervalSeconds || 120;
  discordWebhookInput.value = '';
  webhookHint.textContent = staticMode
    ? 'GitHub Pages版では設定はGitHub ActionsのVariablesとSecretsで管理します。'
    : config.discordWebhookSet
      ? 'Discord webhookは設定済みです。変更する場合だけ入力してください。'
      : 'Discord webhookは未設定です。';

  runStatus.textContent = staticMode ? 'Pages版' : config.running ? '監視中' : '停止中';
  runStatus.className = `status-pill ${config.running || staticMode ? 'running' : ''}`;

  const stale = staticMode && isStaticStatusStale(state, config);
  checkStatus.textContent = staticMode ? (stale ? '遅延' : '公開中') : state.checking ? '確認中' : state.lastError ? 'エラー' : '待機中';
  checkStatus.className = `small-status ${state.lastError || stale ? 'error' : state.checking ? '' : 'ok'}`;

  if (result?.product) {
    productTitle.textContent = result.product.title || 'Nike product';
    productSubtitle.textContent = [result.product.subtitle, result.product.styleColor, result.product.price]
      .filter(Boolean)
      .join(' / ');
    productLink.href = result.product.url || config.productUrl;

    if (result.product.imageUrl) {
      productImage.style.backgroundImage = `url("${result.product.imageUrl}")`;
    }
  } else {
    productTitle.textContent = '商品データ未取得';
    productSubtitle.textContent = '';
    productLink.href = config.productUrl || '#';
    productImage.style.backgroundImage = '';
  }

  stockStatus.textContent = result?.statusLabel || '未確認';
  lastChecked.textContent = result?.checkedAt ? formatDate(result.checkedAt) : state.pagesUpdatedAt ? formatDate(state.pagesUpdatedAt) : '-';
  nextCheck.textContent = nextCheckText(state, config);
  renderSizes(result?.sizes || []);
  renderEvents(state.events || []);
  setStaticControls();
}

function renderSizes(sizes) {
  if (!sizes.length) {
    sizeRows.innerHTML = '<tr><td colspan="3">サイズ情報はまだありません。</td></tr>';
    return;
  }

  sizeRows.innerHTML = sizes
    .map(
      (size) => `
        <tr>
          <td>${escapeHtml(size.label || '-')}</td>
          <td><span class="stock-badge ${size.available ? 'available' : ''}">${
            size.available ? '在庫あり' : '在庫なし'
          }</span></td>
          <td>${escapeHtml(size.level || '-')}</td>
        </tr>
      `,
    )
    .join('');
}

function renderEvents(events) {
  if (!events.length) {
    eventLog.innerHTML = '<li><span>-</span><strong>履歴はまだありません。</strong></li>';
    return;
  }

  eventLog.innerHTML = events
    .slice(0, 40)
    .map(
      (event) => `
        <li>
          <span>${formatDate(event.at)}</span>
          <strong>${escapeHtml(event.message)}</strong>
        </li>
      `,
    )
    .join('');
}

function sendBrowserNotification(payload) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  new Notification(payload.title, {
    body: payload.message,
    icon: payload.product?.imageUrl || undefined,
    tag: 'nike-restock',
  });
}

function setBusy(isBusy) {
  for (const button of [saveButton, startButton, stopButton, checkButton, testDiscordButton]) {
    button.disabled = staticMode || isBusy;
  }
}

function setStaticControls() {
  if (pagesLinks) {
    pagesLinks.hidden = !staticMode;
  }

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

  const intervalSeconds = Number(config.intervalSeconds || 300);
  const loopMinutes = Number(config.loopMinutes || 0);
  if (loopMinutes) {
    return `約${Math.max(1, Math.round(intervalSeconds / 60))}分ごと(ページ更新は約${loopMinutes}分ごと)`;
  }

  const lastCheckedAt = currentState.lastResult?.checkedAt || currentState.pagesUpdatedAt;
  if (lastCheckedAt) {
    const next = new Date(new Date(lastCheckedAt).getTime() + intervalSeconds * 1000);
    if (next.getTime() > Date.now()) {
      return `約${formatDate(next.toISOString())}`;
    }
  }

  return `${Math.max(1, Math.round(intervalSeconds / 60))}分ごと`;
}

function isStaticStatusStale(currentState, config) {
  const lastCheckedAt = currentState.lastResult?.checkedAt || currentState.pagesUpdatedAt;
  if (!lastCheckedAt) return false;

  const intervalSeconds = Number(config.intervalSeconds || 300);
  const loopMinutes = Number(config.loopMinutes || 0);
  // ループ運用ではページ更新はActions実行(=ループ)単位なので、その2周分までは正常とみなす
  const staleAfterSeconds = Math.max(intervalSeconds * 3, loopMinutes * 60 * 2);
  return Date.now() - new Date(lastCheckedAt).getTime() > staleAfterSeconds * 1000;
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
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
