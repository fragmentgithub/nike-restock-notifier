import { timingSafeEqual } from 'node:crypto';
import { scrubDiscordWebhook } from './discord.js';
import { verifyGitHubOidc, verifyGitHubHealthOidc } from './github-oidc.js';

export const MAX_ADMIN_BYTES = 12 * 1024 * 1024;
export const MONITOR_MODES = new Set(['paused', 'shadow', 'active']);
export const CONFIG_KEYS = new Set([
  'PRODUCT_URL', 'PRODUCT_URLS', 'DISCOVERY_URL', 'FRAGMENT_DISCOVERY_URLS',
  'DISCOVERY_INTERVAL_HOURS', 'DISCOVERY_RETRY_MINUTES', 'SIZE_FILTERS',
  'INTERVAL_SECONDS', 'PRODUCT_CHECK_DELAY_MS', 'PRODUCT_CONFIG_JSON',
  'DELIST_FAILURE_THRESHOLD', 'PAUSED_RECHECK_HOURS', 'UPCOMING_INTERVAL_SECONDS',
  'UPCOMING_WINDOW_MINUTES', 'DISCORD_MENTION', 'MAX_NIKE_RESPONSE_BYTES',
]);
const PRIVATE_KEYS = new Set([
  'webhook', 'discordwebhook', 'discord_webhook', 'admintoken', 'admin_token',
  'authorization', 'token', '__proto__', 'constructor', 'prototype',
  'encryptedwebhook',
]);

export function selectConfig(input = {}) {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    CONFIG_KEYS.has(key) && typeof value === 'string'));
}

export function scrubOutput(value, secrets = []) {
  if (typeof value === 'string') {
    let clean = scrubDiscordWebhook(value);
    for (const secret of secrets) if (secret) clean = clean.split(secret).join('[secret]');
    return clean;
  }
  if (Array.isArray(value)) return value.map((item) => scrubOutput(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase()))
    .map(([key, item]) => [key, scrubOutput(item, secrets)]));
}

export function validateImport(payload) {
  if (!isRecord(payload) || !isRecord(payload.state)) return 'A state object is required.';
  if (payload.state.knownProducts !== undefined && !isRecord(payload.state.knownProducts)) {
    return 'knownProducts must be an object.';
  }
  for (const field of ['checkSamples', 'history', 'events']) {
    if (payload.state[field] !== undefined && !Array.isArray(payload.state[field])) {
      return `${field} must be an array.`;
    }
  }
  const vars = payload.vars ?? payload.config;
  if (vars !== undefined && (!isRecord(vars) || Object.entries(vars).some(([key, value]) =>
    !CONFIG_KEYS.has(key) || typeof value !== 'string' || value.length > 262144))) {
    return 'Configuration must contain supported string settings only.';
  }
  if (payload.webhook !== undefined) return 'Configure Discord through the Worker secret binding.';
  if (payload.encryptedWebhook !== undefined) return 'Use the authenticated migration transfer endpoint.';
  if (payload.migrationId !== undefined &&
      (typeof payload.migrationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(payload.migrationId))) {
    return 'migrationId is invalid.';
  }
  const pending = [{ value: payload.state, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 500000 || depth > 32) return 'State structure exceeds the supported limit.';
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

export function validateMigrationTransfer(payload, identity) {
  if (!isRecord(payload)) return 'A migration object is required.';
  const { encryptedWebhook, ...importPayload } = payload;
  const error = validateImport(importPayload);
  if (error) return error;
  if (!identity || payload.migrationId !== identity.migrationId ||
      identity.migrationId !== `${identity.runId}:${identity.runAttempt}` ||
      !/^[1-9][0-9]{0,29}$/.test(identity.runId) || !/^[1-9][0-9]{0,7}$/.test(identity.runAttempt)) {
    return 'Migration identity does not match the authenticated run.';
  }
  if (typeof encryptedWebhook !== 'string' || encryptedWebhook.length < 344 || encryptedWebhook.length > 1368 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encryptedWebhook)) {
    return 'Encrypted credential is invalid.';
  }
  try {
    const bytes = atob(encryptedWebhook);
    if (![256, 384, 512, 768, 1024].includes(bytes.length) || btoa(bytes) !== encryptedWebhook) {
      return 'Encrypted credential is invalid.';
    }
  } catch { return 'Encrypted credential is invalid.'; }
  return null;
}

export async function authorized(request, token) {
  if (typeof token !== 'string' || !token.trim()) return false;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ') || header.length > 2048) return false;
  // Equal-size digests also avoid an early-return comparison of credential lengths.
  const encoder = new TextEncoder();
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
  ]);
  return timingSafeEqual(new Uint8Array(expected), new Uint8Array(supplied));
}

export async function handleWorkerRequest(request, env) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/migration/transfer') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const header = request.headers.get('authorization') || '';
      const identity = header.startsWith('Bearer ') ? await verifyGitHubOidc(header.slice(7)) : null;
      if (!identity) return json({ error: 'Unauthorized' }, 401);
      const payload = await readJson(request);
      const error = validateMigrationTransfer(payload, identity);
      if (error) return json({ error }, 400);
      const result = await env.MONITOR.getByName('nike-jp').acceptMigration(payload, identity);
      return json(result, result?.ok === false ? result.status || 400 : 200);
    }
    if (path.startsWith('/admin/')) {
      if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: 'Unauthorized' }, 401);
      const methods = {
        '/admin/state': 'GET', '/admin/status': 'GET', '/admin/health': 'GET', '/admin/trends': 'GET', '/admin/import': 'POST',
        '/admin/mode': 'POST', '/admin/probe': 'POST', '/admin/restore': 'POST',
        '/admin/backup': ['GET', 'POST'],
        '/admin/migration-credential': ['GET', 'DELETE'],
      };
      if (!methods[path]) return json({ error: 'Not found' }, 404);
      const allowed = [].concat(methods[path]);
      if (!allowed.includes(request.method)) return methodNotAllowed(allowed.join(', '));
      const monitor = env.MONITOR.getByName('nike-jp');
      if (path === '/admin/state') return json(await monitor.exportState());
      if (path === '/admin/status') return json(await monitor.getStatus());
      if (path === '/admin/trends') {
        const params = new URL(request.url).searchParams;
        const product = params.get('styleColor') ?? 'all';
        const styleColor = product === 'all' ? 'all' : product.toUpperCase();
        const days = params.get('days') ?? 'all';
        if ([...params.keys()].some((key) => !['days', 'styleColor'].includes(key)) ||
            params.getAll('days').length > 1 || params.getAll('styleColor').length > 1 ||
            (styleColor !== 'all' && !/^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/.test(styleColor)) ||
            !['all', '7', '30', '90', '365', '730'].includes(days)) {
          return json({ error: 'Invalid trend filter' }, 400);
        }
        return json(await monitor.getTrends({ styleColor, days: days === 'all' ? days : Number(days) }));
      }
      if (path === '/admin/health') return json(await monitor.health());
      if (path === '/admin/backup') {
        const result = request.method === 'GET' ? await monitor.listBackups() : await monitor.backupNow();
        return json(result, result?.ok === false ? result.status || 400 : 200);
      }
      if (path === '/admin/migration-credential') {
        const result = request.method === 'GET'
          ? await monitor.migrationCredential()
          : await monitor.deleteMigrationCredential(new URL(request.url).searchParams.get('migrationId'));
        return json(result, result?.ok === false ? result.status || 400 : 200);
      }
      const payload = await readJson(request);
      let result;
      if (path === '/admin/import') {
        const error = validateImport(payload);
        if (error) return json({ error }, 400);
        result = await monitor.importState(payload);
      } else if (path === '/admin/mode') {
        if (!MONITOR_MODES.has(payload?.mode)) return json({ error: 'Invalid monitor mode' }, 400);
        result = await monitor.setMode(payload.mode);
      } else if (path === '/admin/restore') {
        result = await monitor.restoreBackup(payload?.generation);
      } else {
        if (!['mind', 'fragment', 'catalog'].includes(payload?.target)) return json({ error: 'Invalid probe target' }, 400);
        result = await monitor.probe(payload.target);
      }
      const status = result?.ok === false ? result.status || 400 : 200;
      return json(result, status);
    }
    if (path === '/status.json' || path === '/healthz') {
      const header = request.headers.get('authorization') || '';
      const isAdmin = await authorized(request, env.ADMIN_TOKEN);
      const isWatchdog = !isAdmin && path === '/healthz' && header.startsWith('Bearer ')
        && await verifyGitHubHealthOidc(header.slice(7));
      if (!isAdmin && !isWatchdog) return json({ error: 'Unauthorized' }, 401);
      if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed('GET, HEAD');
      const monitor = env.MONITOR.getByName('nike-jp');
      const data = path === '/status.json' ? await monitor.getStatus() : await monitor.health();
      const response = json(data, path === '/healthz' && !data.healthy ? 503 : 200);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    }
    // The monitor has no public website. Never fall through to an asset binding.
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    // RPC/fetch errors can contain URLs, tokens or provider internals. Never echo them.
    return json({ error: 'Monitor request failed. Please retry.' }, 500);
  }
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new RequestError('Content-Type must be application/json.', 415);
  }
  if (Number(request.headers.get('content-length')) > MAX_ADMIN_BYTES) {
    throw new RequestError('Request is too large.', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('JSON body is required.', 400);
  let length = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ADMIN_BYTES) {
        await reader.cancel();
        throw new RequestError('Request is too large.', 413);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Invalid JSON body.', 400);
  } finally { reader.releaseLock(); }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' },
  });
}
function methodNotAllowed(allow) {
  return Response.json({ error: 'Method not allowed' }, {
    status: 405, headers: { allow, 'cache-control': 'no-store' },
  });
}
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
class RequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
