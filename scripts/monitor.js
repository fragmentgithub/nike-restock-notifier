import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkNikeStock, parseNikeProductUrl } from '../src/nike.js';
import {
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MIND_001_URLS,
  discoverNikeMind001Products,
} from '../src/discovery.js';
import {
  applyCheckState,
  collectMonitorErrors,
  nextCycleDelayMs,
  notificationDecision,
} from '../src/monitor-state.js';

const STATE_DIR = '.monitor-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const STATUS_PATH = 'public/status.json';
const MAX_EVENTS = 80;

const configuredProductUrls = splitUrls(process.env.PRODUCT_URLS);
if (process.env.PRODUCT_URL) configuredProductUrls.push(process.env.PRODUCT_URL);

const config = {
  productUrl:
    process.env.PRODUCT_URL ||
    DEFAULT_MIND_001_URLS.find((url) => url.endsWith('/HQ4307-005')) ||
    DEFAULT_MIND_001_URLS[0],
  seedUrls: unique([...DEFAULT_MIND_001_URLS, ...configuredProductUrls]),
  discoveryUrl: process.env.DISCOVERY_URL || DEFAULT_DISCOVERY_URL,
  discoveryIntervalHours: clampNumber(process.env.DISCOVERY_INTERVAL_HOURS, 6, 1, 168),
  discoveryRetryMinutes: clampNumber(process.env.DISCOVERY_RETRY_MINUTES, 30, 5, 360),
  sizeFilters: process.env.SIZE_FILTERS || '',
  intervalSeconds: clampNumber(process.env.INTERVAL_SECONDS, 120, 30, 1800),
  loopMinutes: clampNumber(process.env.LOOP_MINUTES, 25, 0, 340),
  productCheckDelayMs: clampNumber(process.env.PRODUCT_CHECK_DELAY_MS, 1500, 0, 30000),
  discordWebhook: validateWebhook(process.env.DISCORD_WEBHOOK || ''),
};

await mkdir(STATE_DIR, { recursive: true });

const state = await readJson(STATE_PATH, {});
state.knownProducts = normalizeKnownProducts(state.knownProducts);
const events = Array.isArray(state.events) ? state.events.slice(0, MAX_EVENTS) : [];

for (const url of config.seedUrls) addKnownProduct({ url }, 'initial');

// 旧バージョンの単一商品通知状態を引き継ぐ。
if (state.lastStockKey && state.knownProducts['HQ4307-005']?.lastStockKey === '') {
  state.knownProducts['HQ4307-005'].lastStockKey = state.lastStockKey;
}
delete state.lastStockKey;

const deadline = Date.now() + config.loopMinutes * 60 * 1000;
let cycles = 0;
let checks = 0;
let notifications = 0;
state.consecutiveFailedCycles = Math.max(0, Number(state.consecutiveFailedCycles) || 0);

await discoverProductsIfDue();

for (;;) {
  cycles += 1;
  const products = trackedProducts();
  let cycleFailures = 0;

  for (let index = 0; index < products.length; index += 1) {
    checks += 1;
    try {
      const outcome = await runCheck(products[index]);
      if (outcome.notified) notifications += 1;
      if (!outcome.ok) cycleFailures += 1;
    } catch (error) {
      const checkedAt = new Date().toISOString();
      cycleFailures += 1;
      products[index].lastRuntimeError = {
        message: error.message || '監視処理でエラーが発生しました。',
        at: checkedAt,
      };
      pushEvent({
        id: `actions-error-${Date.now()}`,
        type: 'error',
        message: `${products[index].styleColor} の監視処理でエラー: ${error.message}`,
        at: checkedAt,
        result: null,
      });
      await persist(checkedAt);
    }

    // スイープ途中でも deadline を超えたら打ち切る。商品数が増えても最終スイープが
    // timeout-minutes を突き抜けてジョブが timeout/cancel されるのを防ぐ。
    if (Date.now() >= deadline) break;

    if (index < products.length - 1 && config.productCheckDelayMs > 0) {
      await sleep(config.productCheckDelayMs);
    }
  }

  // バックオフは「全商品が失敗したサイクル」(＝ネットワーク障害/Nike側ブロック等)に限定する。
  // 1商品だけの恒久失敗(例: discovery が拾った色の delist=404)でフリート全体の巡回間隔が
  // 延び続けないようにする。
  const allProductsFailed = products.length > 0 && cycleFailures === products.length;
  state.consecutiveFailedCycles = allProductsFailed ? state.consecutiveFailedCycles + 1 : 0;
  const waitMs = nextCycleDelayMs(config.intervalSeconds, state.consecutiveFailedCycles);
  await persist(new Date().toISOString());
  if (Date.now() + waitMs > deadline) break;
  await sleep(waitMs);
  await discoverProductsIfDue();
}

console.log(
  JSON.stringify(
    {
      cycles,
      checks,
      notifications,
      trackedProducts: trackedProducts().map((product) => product.styleColor),
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      lastDiscoveryAt: state.lastDiscoveryAt || null,
      consecutiveFailedCycles: state.consecutiveFailedCycles,
    },
    null,
    2,
  ),
);

async function discoverProductsIfDue() {
  const lastAttemptAt = Date.parse(state.lastDiscoveryAttemptAt || state.lastDiscoveryAt || '');
  const lastSuccessAt = Date.parse(
    state.lastDiscoverySuccessAt || (state.lastDiscoveryError ? '' : state.lastDiscoveryAt) || '',
  );
  const retryWaitMs = config.discoveryRetryMinutes * 60 * 1000;
  const regularWaitMs = config.discoveryIntervalHours * 3600 * 1000;
  const requiredWaitMs = state.lastDiscoveryError ? retryWaitMs : regularWaitMs;
  const referenceTime = state.lastDiscoveryError ? lastAttemptAt : lastSuccessAt;

  if (Number.isFinite(referenceTime) && Date.now() - referenceTime < requiredWaitMs) {
    return;
  }

  const checkedAt = new Date().toISOString();
  const discovery = await discoverNikeMind001Products({
    catalogUrl: config.discoveryUrl,
    timeoutMs: 20000,
  });
  state.lastDiscoveryAt = checkedAt;
  state.lastDiscoveryAttemptAt = checkedAt;
  state.lastDiscoveryError = discovery.error;

  if (discovery.error) {
    pushEvent({
      id: `discovery-error-${Date.now()}`,
      type: 'error',
      message: `新カラー探索に失敗しました: ${discovery.error}`,
      at: checkedAt,
      result: null,
    });
  } else {
    state.lastDiscoverySuccessAt = checkedAt;
    const added = addKnownProducts(discovery.products, 'catalog');
    pushEvent({
      id: `discovery-${Date.now()}`,
      type: 'discovery',
      message: added.length
        ? `新しいMind 001を検出: ${added.join(', ')}`
        : `新カラー探索完了: ${trackedProducts().length}商品を追跡中`,
      at: checkedAt,
      result: null,
    });
  }

  await persist(checkedAt);
}

async function runCheck(entry) {
  const result = await checkNikeStock(entry.url, {
    sizeFilters: config.sizeFilters,
    timeoutMs: 20000,
  });
  const checkedAt = result.checkedAt || new Date().toISOString();
  const styleColor = result.product?.styleColor || entry.styleColor;
  const { nextStockKey, shouldNotify } = notificationDecision(entry, result);
  const relatedAdded = addKnownProducts(result.relatedProducts || [], 'product-page');

  if (relatedAdded.length) {
    pushEvent({
      id: `related-${Date.now()}`,
      type: 'discovery',
      message: `商品ページから新カラーを検出: ${relatedAdded.join(', ')}`,
      at: checkedAt,
      result: null,
    });
  }

  const publicResult = withoutRelatedProducts(result);
  entry.lastResult = publicResult;
  entry.lastSeenAt = checkedAt;
  entry.lastRuntimeError = result.ok
    ? null
    : { message: `${styleColor} を確認できませんでした。`, at: checkedAt };
  if (result.product?.url) entry.url = result.product.url;

  pushEvent({
    id: `actions-${Date.now()}-${styleColor}`,
    type: result.ok ? 'check' : 'error',
    message: `${styleColor}: ${result.statusLabel}`,
    at: checkedAt,
    result: compactResult(publicResult),
  });

  let notified = false;
  if (shouldNotify && config.discordWebhook) {
    try {
      await sendDiscordNotification({
        webhook: config.discordWebhook,
        title: `${result.product.title} (${styleColor}) が在庫あり`,
        message: result.matchingSizes.length
          ? `対象サイズ: ${result.matchingSizes.map((size) => size.label).join(', ')}`
          : '対象商品が購入できる可能性があります。',
        url: result.product.url,
        sizes: result.matchingSizes,
        imageUrl: result.product.imageUrl,
      });
      notified = true;
      pushEvent({
        id: `notify-${Date.now()}-${styleColor}`,
        type: 'notify',
        message: `Discordへ通知しました: ${styleColor} / ${result.statusLabel}`,
        at: new Date().toISOString(),
        result: null,
      });
    } catch (error) {
      pushEvent({
        id: `notify-error-${Date.now()}-${styleColor}`,
        type: 'error',
        message: `Discord通知に失敗しました (${styleColor}): ${scrubWebhook(error.message)}`,
        at: new Date().toISOString(),
        result: null,
      });
    }
  }

  applyCheckState(entry, result, {
    nextStockKey,
    shouldNotify,
    notified,
    webhookConfigured: Boolean(config.discordWebhook),
  });

  await persist(checkedAt);
  return { notified, ok: result.ok };
}

function addKnownProducts(products, source) {
  const added = [];
  for (const product of products) {
    const result = addKnownProduct(product, source);
    if (result.added) added.push(result.entry.styleColor);
  }
  return added;
}

function addKnownProduct(product, source) {
  let parsed;
  try {
    parsed = parseNikeProductUrl(product.url);
  } catch {
    return { added: false, entry: null };
  }

  const styleColor = String(product.styleColor || parsed.styleColor).toUpperCase();
  const existing = state.knownProducts[styleColor];
  if (existing) {
    if (product.url) existing.url = product.url;
    return { added: false, entry: existing };
  }

  const now = new Date().toISOString();
  const entry = {
    styleColor,
    url: product.url || parsed.url,
    source,
    discoveredAt: now,
    lastSeenAt: null,
    lastStockKey: '',
    lastResult: null,
  };
  state.knownProducts[styleColor] = entry;
  return { added: true, entry };
}

function normalizeKnownProducts(value) {
  const normalized = {};
  if (!value || typeof value !== 'object') return normalized;

  for (const [key, product] of Object.entries(value)) {
    if (!product?.url) continue;
    try {
      const parsed = parseNikeProductUrl(product.url);
      const styleColor = String(product.styleColor || key || parsed.styleColor).toUpperCase();
      normalized[styleColor] = {
        styleColor,
        url: product.url,
        source: product.source || 'state',
        discoveredAt: product.discoveredAt || new Date().toISOString(),
        lastSeenAt: product.lastSeenAt || null,
        lastStockKey: product.lastStockKey || '',
        oosStreak: Number(product.oosStreak) || 0,
        lastResult: product.lastResult || null,
        lastRuntimeError: product.lastRuntimeError || null,
      };
    } catch {
      // 壊れたキャッシュ項目は無視する。
    }
  }
  return normalized;
}

function trackedProducts() {
  return Object.values(state.knownProducts).sort((a, b) => a.styleColor.localeCompare(b.styleColor));
}

async function persist(updatedAt) {
  state.events = events;
  const monitorErrors = collectMonitorErrors(trackedProducts(), state.lastDiscoveryError);
  state.lastErrors = monitorErrors;
  state.lastError = monitorErrors[0] || null;

  const products = trackedProducts().map((entry) => ({
    styleColor: entry.styleColor,
    url: entry.url,
    source: entry.source,
    discoveredAt: entry.discoveredAt,
    lastSeenAt: entry.lastSeenAt,
    lastResult: entry.lastResult,
    lastError: entry.lastRuntimeError?.message || (entry.lastResult?.ok === false ? entry.lastResult.statusLabel : null),
  }));
  const lastResult = products
    .map((product) => product.lastResult)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.checkedAt || '') - Date.parse(a.checkedAt || ''))[0] || null;

  const publicStatus = {
    schemaVersion: 2,
    updatedAt,
    config: {
      productUrl: config.productUrl,
      productUrls: products.map((product) => product.url),
      productCount: products.length,
      discoveryUrl: config.discoveryUrl,
      discoveryIntervalHours: config.discoveryIntervalHours,
      discoveryRetryMinutes: config.discoveryRetryMinutes,
      sizeFilters: config.sizeFilters,
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      productCheckDelayMs: config.productCheckDelayMs,
      discordWebhookSet: Boolean(config.discordWebhook),
    },
    discovery: {
      lastCheckedAt: state.lastDiscoveryAt || null,
      lastSuccessAt: state.lastDiscoverySuccessAt || null,
      lastError: state.lastDiscoveryError || null,
    },
    products,
    lastResult,
    errors: monitorErrors,
    lastError: state.lastError,
    events,
  };

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  await writeFile(STATUS_PATH, JSON.stringify(publicStatus, null, 2), 'utf8');
}

function pushEvent(event) {
  events.unshift(event);
  events.splice(MAX_EVENTS);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function validateWebhook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    // 下でまとめて無効化する。
  }
  // 不正な値は通知を無効化する。生の値はログにも出さない(トークン漏洩防止)。
  console.warn('DISCORD_WEBHOOK is not a valid http(s) URL; Discord notifications are disabled.');
  return '';
}

// webhook URL(トークン)が公開 events / status.json 経由で GitHub Pages に漏れないよう、
// 通知失敗メッセージから webhook 文字列を伏せる。
function scrubWebhook(text) {
  let out = String(text || '');
  if (config.discordWebhook) out = out.split(config.discordWebhook).join('[webhook]');
  return out.replace(/https?:\/\/\S*discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[webhook]');
}

function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function splitUrls(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function withoutRelatedProducts(result) {
  const { relatedProducts: _relatedProducts, ...publicResult } = result;
  return publicResult;
}

function compactResult(result) {
  return {
    ok: result.ok,
    product: result.product,
    source: result.source,
    statusLabel: result.statusLabel,
    inStock: result.inStock,
    matchingSizes: result.matchingSizes,
    checkedAt: result.checkedAt,
  };
}

async function sendDiscordNotification({ webhook, title, message, url, sizes, imageUrl }) {
  const fields = [];
  if (sizes?.length) {
    fields.push({
      name: 'サイズ',
      value: sizes.map((size) => size.label).join(', '),
      inline: false,
    });
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: null,
      embeds: [
        {
          title,
          description: message,
          url,
          color: 0x2f7d4a,
          fields,
          image: imageUrl ? { url: imageUrl } : undefined,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord通知に失敗しました: ${response.status} ${response.statusText}`);
  }
}
