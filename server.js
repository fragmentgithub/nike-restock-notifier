import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNikeStock, parseNikeProductUrl } from './src/nike.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');
const PORT = Number(process.env.PORT || 4173);

const DEFAULT_PRODUCT_URL =
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005';

const DEFAULT_CONFIG = {
  productUrl: DEFAULT_PRODUCT_URL,
  sizeFilters: '',
  intervalSeconds: 120,
  discordWebhook: '',
  running: false,
};

const state = {
  config: { ...DEFAULT_CONFIG },
  lastResult: null,
  lastError: null,
  lastNotifiedKey: '',
  checking: false,
  timer: null,
  nextCheckAt: null,
  events: [],
  clients: new Set(),
};

await mkdir(DATA_DIR, { recursive: true });
await loadState();
scheduleNextCheck();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, publicState());
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readJson(req);
      state.config = sanitizeConfig(body, state.config);
      state.lastNotifiedKey = state.lastResult ? stockKey(state.lastResult.matchingSizes) : '';
      await saveConfig();
      addEvent('settings', '設定を保存しました。');
      scheduleNextCheck();
      return sendJson(res, publicState());
    }

    if (url.pathname === '/api/start' && req.method === 'POST') {
      state.config.running = true;
      await saveConfig();
      addEvent('settings', '監視を開始しました。');
      scheduleNextCheck(0);
      return sendJson(res, publicState());
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      state.config.running = false;
      await saveConfig();
      addEvent('settings', '監視を停止しました。');
      scheduleNextCheck();
      return sendJson(res, publicState());
    }

    if (url.pathname === '/api/check' && req.method === 'POST') {
      const result = await runCheck({ manual: true });
      return sendJson(res, { ...publicState(), result });
    }

    if (url.pathname === '/api/test-discord' && req.method === 'POST') {
      if (!state.config.discordWebhook) {
        throw new Error('Discord webhookが未設定です。');
      }

      await sendDiscordNotification({
        title: 'Nikeリストック通知テスト',
        message: 'Discord webhookの送信テストです。',
        url: state.config.productUrl,
        sizes: [],
      });
      addEvent('notify', 'Discordへテスト通知を送信しました。');
      return sendJson(res, publicState());
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      return handleSse(req, res);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(
      res,
      {
        error: error.message || '処理に失敗しました。',
      },
      500,
    );
  }
});

server.listen(PORT, () => {
  console.log(`Nike restock notifier is running at http://localhost:${PORT}`);
});

async function loadState() {
  state.config = sanitizeConfig(await readJsonFile(CONFIG_PATH, DEFAULT_CONFIG));
  state.events = await readJsonFile(EVENTS_PATH, []);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(state.config, null, 2), 'utf8');
}

async function saveEvents() {
  await writeFile(EVENTS_PATH, JSON.stringify(state.events.slice(0, 200), null, 2), 'utf8');
}

function sanitizeConfig(input, previous = {}) {
  const merged = { ...DEFAULT_CONFIG, ...previous, ...(input || {}) };
  const intervalSeconds = Math.max(30, Math.min(3600, Number(merged.intervalSeconds) || 120));
  const hasWebhookInput = Object.hasOwn(input || {}, 'discordWebhook');
  const discordWebhook = hasWebhookInput
    ? String(merged.discordWebhook || '').trim()
    : String(previous.discordWebhook || '').trim();

  parseNikeProductUrl(merged.productUrl);

  return {
    productUrl: String(merged.productUrl || DEFAULT_PRODUCT_URL).trim(),
    sizeFilters: String(merged.sizeFilters || '').trim(),
    intervalSeconds,
    discordWebhook,
    running: Boolean(merged.running),
  };
}

function scheduleNextCheck(delayMs) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (!state.config.running) {
    state.nextCheckAt = null;
    broadcast('state', publicState());
    return;
  }

  const waitMs =
    typeof delayMs === 'number' ? delayMs : Math.max(30000, state.config.intervalSeconds * 1000);
  state.nextCheckAt = new Date(Date.now() + waitMs).toISOString();
  state.timer = setTimeout(() => runCheck({ manual: false }), waitMs);
  broadcast('state', publicState());
}

async function runCheck({ manual }) {
  if (state.checking) {
    addEvent('check', 'すでに確認中です。');
    return state.lastResult;
  }

  state.checking = true;
  state.lastError = null;
  broadcast('state', publicState());

  try {
    const result = await checkNikeStock(state.config.productUrl, {
      sizeFilters: state.config.sizeFilters,
    });
    const previousKey = state.lastNotifiedKey;
    const nextKey = stockKey(result.matchingSizes) || (result.inStock ? '__product__' : '');
    const shouldNotify = result.inStock && nextKey && nextKey !== previousKey;

    state.lastResult = result;

    addEvent(
      result.ok ? 'check' : 'error',
      `${manual ? '手動確認' : '自動確認'}: ${result.statusLabel}`,
      result,
    );

    if (shouldNotify) {
      state.lastNotifiedKey = nextKey;
      const title = `${result.product.title} が在庫あり`;
      const message = result.matchingSizes.length
        ? `対象サイズ: ${result.matchingSizes.map((size) => size.label).join(', ')}`
        : '対象商品が購入できる可能性があります。';

      addEvent('restock', `${title} / ${message}`, result);
      broadcast('restock', {
        title,
        message,
        product: result.product,
        sizes: result.matchingSizes,
        checkedAt: result.checkedAt,
      });

      if (state.config.discordWebhook) {
        try {
          await sendDiscordNotification({
            title,
            message,
            url: result.product.url,
            sizes: result.matchingSizes,
            imageUrl: result.product.imageUrl,
          });
        } catch (error) {
          state.lastError = error.message || 'Discord通知に失敗しました。';
          addEvent('error', state.lastError);
        }
      }
    }

    return result;
  } catch (error) {
    state.lastError = error.message || '確認に失敗しました。';
    addEvent('error', state.lastError);
    return null;
  } finally {
    state.checking = false;
    await saveEvents();
    scheduleNextCheck();
  }
}

function stockKey(sizes = []) {
  return sizes
    .filter((size) => size.available)
    .map((size) => size.label || size.id)
    .sort()
    .join('|');
}

async function sendDiscordNotification({ title, message, url, sizes, imageUrl }) {
  const webhook = state.config.discordWebhook;
  if (!webhook) return;

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

function publicState() {
  return {
    config: {
      ...state.config,
      discordWebhook: '',
      discordWebhookSet: Boolean(state.config.discordWebhook),
    },
    lastResult: state.lastResult,
    lastError: state.lastError,
    checking: state.checking,
    nextCheckAt: state.nextCheckAt,
    events: state.events.slice(0, 100),
  };
}

function addEvent(type, message, result = null) {
  const event = {
    id: randomUUID(),
    type,
    message,
    at: new Date().toISOString(),
    result: result ? compactResult(result) : null,
  };

  state.events.unshift(event);
  state.events = state.events.slice(0, 200);
  broadcast('event', event);
  broadcast('state', publicState());
  return event;
}

function compactResult(result) {
  return {
    ok: result.ok,
    source: result.source,
    statusLabel: result.statusLabel,
    inStock: result.inStock,
    matchingSizes: result.matchingSizes,
    checkedAt: result.checkedAt,
  };
}

function handleSse(_req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  state.clients.add(res);

  res.on('close', () => {
    state.clients.delete(res);
  });
}

function broadcast(event, payload) {
  for (const client of state.clients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');

    res.writeHead(200, {
      'content-type': contentType(filePath),
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return types[ext] || 'application/octet-stream';
}

async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}
