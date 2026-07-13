import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkNikeStock, parseNikeProductUrl } from '../src/nike.js';
import {
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MIND_001_URLS,
  discoverNikeMind001Products,
} from '../src/discovery.js';

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
  sizeFilters: process.env.SIZE_FILTERS || '',
  intervalSeconds: clampNumber(process.env.INTERVAL_SECONDS, 120, 30, 1800),
  loopMinutes: clampNumber(process.env.LOOP_MINUTES, 25, 0, 340),
  productCheckDelayMs: clampNumber(process.env.PRODUCT_CHECK_DELAY_MS, 1500, 0, 30000),
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
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

await discoverProductsIfDue();

for (;;) {
  cycles += 1;
  const cycleStartedAt = Date.now();
  const products = trackedProducts();

  for (let index = 0; index < products.length; index += 1) {
    checks += 1;
    try {
      const notified = await runCheck(products[index]);
      if (notified) notifications += 1;
    } catch (error) {
      const checkedAt = new Date().toISOString();
      pushEvent({
        id: `actions-error-${Date.now()}`,
        type: 'error',
        message: `${products[index].styleColor} の監視処理でエラー: ${error.message}`,
        at: checkedAt,
        result: null,
      });
      await persist(checkedAt, 'Nikeの商品ページを確認できませんでした。');
    }

    if (index < products.length - 1 && config.productCheckDelayMs > 0) {
      await sleep(config.productCheckDelayMs);
    }
  }

  const nextCycleAt = cycleStartedAt + config.intervalSeconds * 1000;
  if (nextCycleAt > deadline) break;
  await sleep(Math.max(0, nextCycleAt - Date.now()));
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
    },
    null,
    2,
  ),
);

async function discoverProductsIfDue() {
  const lastDiscoveryAt = Date.parse(state.lastDiscoveryAt || '');
  const discoveryAge = Date.now() - lastDiscoveryAt;
  if (Number.isFinite(lastDiscoveryAt) && discoveryAge < config.discoveryIntervalHours * 3600 * 1000) {
    return;
  }

  const checkedAt = new Date().toISOString();
  const discovery = await discoverNikeMind001Products({
    catalogUrl: config.discoveryUrl,
    timeoutMs: 20000,
  });
  state.lastDiscoveryAt = checkedAt;
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

  await persist(checkedAt, discovery.error ? '新カラー探索に失敗しました。既知の商品は監視を継続します。' : null);
}

async function runCheck(entry) {
  const result = await checkNikeStock(entry.url, {
    sizeFilters: config.sizeFilters,
    timeoutMs: 20000,
  });
  const checkedAt = result.checkedAt || new Date().toISOString();
  const styleColor = result.product?.styleColor || entry.styleColor;
  const nextStockKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
  const shouldNotify = result.inStock && nextStockKey && nextStockKey !== entry.lastStockKey;
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
        message: `Discord通知に失敗しました (${styleColor}): ${error.message}`,
        at: new Date().toISOString(),
        result: null,
      });
    }
  }

  if (!result.ok) {
    // 一時的な取得失敗では通知済み状態を変更しない。復旧時の重複通知を防ぐ。
  } else if (result.inStock) {
    // 通知失敗時だけキーを更新せず、次のチェックで再送を試す。
    if (!shouldNotify || notified || !config.discordWebhook) entry.lastStockKey = nextStockKey;
  } else {
    entry.lastStockKey = '';
  }

  await persist(checkedAt, result.ok ? null : `${styleColor} を確認できませんでした。`);
  return notified;
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
        lastResult: product.lastResult || null,
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

async function persist(updatedAt, lastError) {
  state.events = events;
  state.lastError = lastError;

  const products = trackedProducts().map((entry) => ({
    styleColor: entry.styleColor,
    url: entry.url,
    source: entry.source,
    discoveredAt: entry.discoveredAt,
    lastSeenAt: entry.lastSeenAt,
    lastResult: entry.lastResult,
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
      sizeFilters: config.sizeFilters,
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      productCheckDelayMs: config.productCheckDelayMs,
      discordWebhookSet: Boolean(config.discordWebhook),
    },
    discovery: {
      lastCheckedAt: state.lastDiscoveryAt || null,
      lastError: state.lastDiscoveryError || null,
    },
    products,
    lastResult,
    lastError,
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

function stockKey(sizes = []) {
  return sizes
    .filter((size) => size.available)
    .map((size) => size.label || size.id)
    .sort()
    .join('|');
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
