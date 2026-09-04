import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubDiscordWebhook } from '../src/discord.js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_URL = 'https://nike-restock-notifier.only-this-moment.workers.dev/admin/status';
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/restock-trends.js', ['restock-trends.js', 'application/javascript; charset=utf-8']],
  ['/trend-view.js', ['trend-view.js', 'application/javascript; charset=utf-8']],
]);
const PRIVATE_FIELDS = new Set([
  'admin_token', 'admintoken', 'token', 'authorization',
  'webhook', 'discord_webhook', 'discordwebhook', 'encryptedwebhook',
]);
const RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

/** Private, read-only loopback viewer. Importing this module never starts a listener. */
export function createPagesServer({
  publicDirectory = path.join(projectDirectory, 'public'),
  loadToken = readAdminToken,
  fetchImpl = fetch,
  now = Date.now,
  cacheMs = 60000,
  timeoutMs = 10000,
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  let cache;
  let inFlight;

  async function statusBody() {
    if (cache && now() < cache.expiresAt) return cache.body;
    if (inFlight) return inFlight;
    inFlight = fetchStatus({ loadToken, fetchImpl, timeoutMs, maxBytes }).then((body) => {
      cache = { body, expiresAt: now() + cacheMs };
      return body;
    }).catch(() => {
      // Never disguise an expired cache or public/status.json as a fresh live result.
      cache = null;
      throw new Error('Live status unavailable');
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 20000 }, async (request, response) => {
    const address = server.address();
    const host = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const origin = `http://${host}`;
    const site = request.headers['sec-fetch-site'];
    if (!host || request.headers.host !== host ||
        !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (site !== undefined && !['same-origin', 'none'].includes(site))) {
      reply(request, response, 403, 'Forbidden');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      reply(request, response, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid target');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw new Error('Invalid target');
      pathname = url.pathname;
    } catch {
      reply(request, response, 400, 'Bad request');
      return;
    }
    if (pathname === '/status.json') {
      try {
        reply(request, response, 200, await statusBody(), { 'content-type': 'application/json; charset=utf-8' });
      } catch {
        reply(request, response, 503, JSON.stringify({
          error: '監視データを取得できませんでした。しばらくしてから再読み込みしてください。',
        }), { 'content-type': 'application/json; charset=utf-8' });
      }
      return;
    }
    const file = STATIC_FILES.get(pathname);
    if (!file) { reply(request, response, 404, 'Not found'); return; }
    try {
      const body = await readFile(path.join(publicDirectory, file[0]));
      reply(request, response, 200, body, { 'content-type': file[1] });
    } catch { reply(request, response, 404, 'Not found'); }
  });
  return server;
}

async function readAdminToken() {
  return process.env.ADMIN_TOKEN || readFile(path.join(projectDirectory, '.cloudflare-migration', 'admin-token'), 'utf8');
}

async function fetchStatus({ loadToken, fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new Error('Live status timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const token = String(await loadToken()).trim();
      if (!token || token.length > 2048 || /[\r\n]/.test(token)) throw new Error('Admin credential unavailable');
      controller.signal.throwIfAborted();
      const response = await fetchImpl(STATUS_URL, {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Live status unavailable');
      }
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Live status too large'); }
        chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          !Array.isArray(data.products) || !Number.isFinite(Date.parse(data.updatedAt || ''))) {
        throw new Error('Invalid live status');
      }
      return JSON.stringify(data, (key, value) => {
        if (PRIVATE_FIELDS.has(key.toLowerCase())) return undefined;
        return typeof value === 'string' ? scrubDiscordWebhook(value).split(token).join('[redacted]') : value;
      }).split(token).join('[redacted]');
    })()]);
  } finally {
    clearTimeout(timer);
    // An abort may have just cancelled a pending read; release only once it settles.
    try { reader?.releaseLock(); } catch { /* cancellation owns the pending read */ }
  }
}

function reply(request, response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    ...RESPONSE_HEADERS, 'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body), ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be a port number between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createPagesServer();
    server.on('error', () => {
      console.error('Local viewer could not start. Check whether the port is already in use.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Private monitor: http://127.0.0.1:${port}`));
  }
}
