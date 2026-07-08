import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkNikeStock } from '../src/nike.js';

const DEFAULT_PRODUCT_URL =
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005';

const STATE_DIR = '.monitor-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const STATUS_PATH = 'public/status.json';
const MAX_EVENTS = 40;

const config = {
  productUrl: process.env.PRODUCT_URL || DEFAULT_PRODUCT_URL,
  sizeFilters: process.env.SIZE_FILTERS || '',
  intervalSeconds: clampNumber(process.env.INTERVAL_SECONDS, 120, 60, 1800),
  loopMinutes: clampNumber(process.env.LOOP_MINUTES, 25, 0, 340),
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
};

await mkdir(STATE_DIR, { recursive: true });

const state = await readJson(STATE_PATH, {});
const events = Array.isArray(state.events) ? state.events.slice(0, MAX_EVENTS) : [];
const deadline = Date.now() + config.loopMinutes * 60 * 1000;
let checks = 0;
let notifications = 0;
let lastResult = null;

for (;;) {
  checks += 1;
  try {
    const notified = await runCheck();
    if (notified) notifications += 1;
  } catch (error) {
    pushEvent({
      id: `actions-error-${Date.now()}`,
      type: 'error',
      message: `監視処理でエラー: ${error.message}`,
      at: new Date().toISOString(),
      result: null,
    });
    await persist(new Date().toISOString(), '監視処理でエラーが発生しました。');
  }

  if (Date.now() + config.intervalSeconds * 1000 > deadline) break;
  await sleep(config.intervalSeconds * 1000);
}

console.log(
  JSON.stringify(
    {
      checks,
      notifications,
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      lastStockKey: state.lastStockKey || '',
    },
    null,
    2,
  ),
);

async function runCheck() {
  const result = await checkNikeStock(config.productUrl, {
    sizeFilters: config.sizeFilters,
    timeoutMs: 20000,
  });

  const checkedAt = result.checkedAt || new Date().toISOString();
  const nextStockKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
  const shouldNotify = result.inStock && nextStockKey && nextStockKey !== state.lastStockKey;

  pushEvent({
    id: `actions-${Date.now()}`,
    type: result.ok ? 'check' : 'error',
    message: `GitHub Actions確認: ${result.statusLabel}`,
    at: checkedAt,
    result: {
      ok: result.ok,
      source: result.source,
      statusLabel: result.statusLabel,
      inStock: result.inStock,
      matchingSizes: result.matchingSizes,
      checkedAt,
    },
  });

  let notified = false;
  if (shouldNotify && config.discordWebhook) {
    try {
      await sendDiscordNotification({
        webhook: config.discordWebhook,
        title: `${result.product.title} が在庫あり`,
        message: result.matchingSizes.length
          ? `対象サイズ: ${result.matchingSizes.map((size) => size.label).join(', ')}`
          : '対象商品が購入できる可能性があります。',
        url: result.product.url,
        sizes: result.matchingSizes,
        imageUrl: result.product.imageUrl,
      });
      notified = true;
      pushEvent({
        id: `notify-${Date.now()}`,
        type: 'notify',
        message: `Discord通知を送信しました: ${result.statusLabel}`,
        at: new Date().toISOString(),
        result: null,
      });
    } catch (error) {
      pushEvent({
        id: `notify-error-${Date.now()}`,
        type: 'error',
        message: `Discord通知に失敗しました: ${error.message}`,
        at: new Date().toISOString(),
        result: null,
      });
    }
  }

  if (result.inStock) {
    // 通知に失敗した場合はキーを更新せず、次のチェックで再通知を試みる
    if (!shouldNotify || notified || !config.discordWebhook) {
      state.lastStockKey = nextStockKey;
    }
  } else {
    state.lastStockKey = '';
  }
  state.lastCheckedAt = checkedAt;

  lastResult = result;
  await persist(checkedAt, result.ok ? null : 'Nikeの商品ページを確認できませんでした。');
  return notified;
}

async function persist(updatedAt, lastError) {
  state.events = events;

  const publicStatus = {
    updatedAt,
    config: {
      productUrl: config.productUrl,
      sizeFilters: config.sizeFilters,
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      discordWebhookSet: Boolean(config.discordWebhook),
    },
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
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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
