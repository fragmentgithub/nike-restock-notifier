import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { checkNikeStock } from '../src/nike.js';

const DEFAULT_PRODUCT_URL =
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005';

const STATE_DIR = '.monitor-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const STATUS_PATH = 'public/status.json';

const config = {
  productUrl: process.env.PRODUCT_URL || DEFAULT_PRODUCT_URL,
  sizeFilters: process.env.SIZE_FILTERS || '',
  intervalSeconds: Math.max(300, Number(process.env.INTERVAL_SECONDS || 300)),
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
};

await mkdir(STATE_DIR, { recursive: true });

const previousState = await readJson(STATE_PATH, {});
const result = await checkNikeStock(config.productUrl, {
  sizeFilters: config.sizeFilters,
  timeoutMs: 20000,
});

const nextStockKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
const shouldNotify = result.inStock && nextStockKey && nextStockKey !== previousState.lastStockKey;
const checkedAt = result.checkedAt || new Date().toISOString();
const message = `GitHub Actions確認: ${result.statusLabel}`;
const event = {
  id: `actions-${Date.now()}`,
  type: result.ok ? 'check' : 'error',
  message,
  at: checkedAt,
  result: {
    ok: result.ok,
    source: result.source,
    statusLabel: result.statusLabel,
    inStock: result.inStock,
    matchingSizes: result.matchingSizes,
    checkedAt,
  },
};

if (shouldNotify && config.discordWebhook) {
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
}

const nextState = {
  lastStockKey: result.inStock ? nextStockKey : '',
  lastCheckedAt: checkedAt,
};

const publicStatus = {
  updatedAt: checkedAt,
  config: {
    productUrl: config.productUrl,
    sizeFilters: config.sizeFilters,
    intervalSeconds: config.intervalSeconds,
    discordWebhookSet: Boolean(config.discordWebhook),
  },
  lastResult: result,
  lastError: result.ok ? null : 'Nikeの商品ページを確認できませんでした。',
  events: [event],
};

await writeFile(STATE_PATH, JSON.stringify(nextState, null, 2), 'utf8');
await writeFile(STATUS_PATH, JSON.stringify(publicStatus, null, 2), 'utf8');

console.log(JSON.stringify({ statusLabel: result.statusLabel, inStock: result.inStock, notified: shouldNotify }, null, 2));

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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
