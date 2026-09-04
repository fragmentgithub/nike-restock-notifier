import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPagesServer } from '../scripts/serve-pages.js';

const TOKEN = 'private-local-test-admin-token';
const STATUS_URL = 'https://nike-restock-notifier.only-this-moment.workers.dev/admin/status';
const TRENDS_URL = 'https://nike-restock-notifier.only-this-moment.workers.dev/admin/trends';
function status(extra = {}) {
  return { schemaVersion: 3, updatedAt: '2026-09-05T00:00:00.000Z', products: [], ...extra };
}

function trends(url = `${TRENDS_URL}?styleColor=all&days=all`, extra = {}) {
  const params = new URL(url).searchParams;
  const days = params.get('days') || 'all';
  return {
    timezone: 'Asia/Tokyo', styleColor: params.get('styleColor') || 'all',
    totalEvents: 2, products: ['HQ4307-001'],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 4 ? 2 : 0 })),
    period: { days: days === 'all' ? 'all' : Number(days), retainedFrom: '2026-09-05T19:00:00Z', retainedTo: '2026-09-05T19:00:00Z' },
    notes: { retentionDays: 730 }, ...extra,
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nike-local-view-'));
  for (const file of ['index.html', 'app.js', 'styles.css', 'restock-trends.js', 'trend-view.js']) {
    await writeFile(path.join(directory, file), `static ${file}`);
  }
  await writeFile(path.join(directory, 'status.json'), JSON.stringify(status({ marker: 'obsolete-local-snapshot' })));
  await writeFile(path.join(directory, 'private.txt'), 'must not be served');
  const server = createPagesServer({
    publicDirectory: directory, loadToken: async () => TOKEN,
    fetchImpl: async () => Response.json(status()), ...options,
  });
  assert.equal(server.listening, false);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('nike-local-view-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { server, port, send: (target, options) => send(port, target, options) };
}

function send(port, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: target, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(2000, () => request.destroy(new Error('Local test request timed out')));
    request.on('error', reject);
    request.end();
  });
}

test('the viewer serves only the named static files and read-only methods on loopback', async (t) => {
  let tokenReads = 0;
  const local = await fixture(t, { loadToken: async () => { tokenReads++; return TOKEN; } });
  assert.equal(local.server.address().address, '127.0.0.1');
  for (const filename of ['index.html', 'app.js', 'styles.css', 'restock-trends.js', 'trend-view.js']) {
    const result = await local.send(`/${filename}`);
    assert.equal(result.status, 200);
    assert.equal(result.body, `static ${filename}`);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await local.send('/')).body, 'static index.html');
  assert.equal((await local.send('/index.html', { method: 'HEAD' })).body, '');
  for (const target of ['/private.txt', '/admin/state', '/.cloudflare-migration/admin-token', '/../scripts/cloudflare-admin.js', '/%2e%2e/private.txt']) {
    assert.equal((await local.send(target)).status, 404);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await local.send('/status.json', { method })).status, 405);
    assert.equal((await local.send('/api/trends', { method })).status, 405);
  }
  assert.equal(tokenReads, 0);
});

test('host rebinding, foreign origins and cross-origin fetch metadata cannot access the viewer', async (t) => {
  let fetches = 0;
  const local = await fixture(t, { fetchImpl: async () => { fetches++; return Response.json(status()); } });
  for (const headers of [
    { host: `attacker.test:${local.port}` }, { host: `localhost:${local.port}` }, { host: '127.0.0.1:1' },
    { origin: 'https://attacker.test' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) {
    const result = await local.send('/status.json', { headers });
    assert.equal(result.status, 403);
    assert.equal((await local.send('/api/trends', { headers })).status, 403);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(fetches, 0);
  assert.equal((await local.send('/index.html', {
    headers: { origin: `http://127.0.0.1:${local.port}`, 'sec-fetch-site': 'same-origin' },
  })).status, 200);
  assert.equal((await local.send('//attacker.test/status.json')).status, 400);
  assert.equal((await local.send('http://attacker.test/status.json')).status, 400);
});

test('status uses only the fixed upstream and keeps credentials out of browser bodies, headers and URLs', async (t) => {
  let received;
  const webhook = 'https://discord.com/api/webhooks/123456789/private-webhook';
  const local = await fixture(t, { fetchImpl: async (url, options) => {
    received = { url, options };
    return Response.json(status({
      ADMIN_TOKEN: TOKEN, discordWebhook: webhook, encryptedWebhook: 'private-ciphertext',
      detail: `unexpected ${TOKEN} ${webhook}`,
    }));
  } });
  const result = await local.send('/status.json?url=https://attacker.test/collect');
  assert.equal(result.status, 200);
  assert.equal(received.url, STATUS_URL);
  assert.equal(received.options.method, 'GET');
  assert.equal(received.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(received.options.redirect, 'error');
  assert.equal(result.body.includes(TOKEN), false);
  assert.equal(result.body.includes(webhook), false);
  assert.equal(result.body.includes('private-ciphertext'), false);
  assert.equal(JSON.stringify(result.headers).includes(TOKEN), false);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(result.body).updatedAt, '2026-09-05T00:00:00.000Z');
  const head = await local.send('/status.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('concurrent status requests share one fetch and successful responses expire after 60 seconds', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let fetches = 0;
  let now = 0;
  const local = await fixture(t, { now: () => now, fetchImpl: async () => {
    fetches++;
    entered.resolve();
    await finish.promise;
    return Response.json(status({ generation: fetches }));
  } });
  const pending = Array.from({ length: 6 }, () => local.send('/status.json'));
  await entered.promise;
  finish.resolve();
  assert.ok((await Promise.all(pending)).every((result) => result.status === 200));
  assert.equal(fetches, 1);
  now = 59999;
  assert.equal(JSON.parse((await local.send('/status.json')).body).generation, 1);
  now = 60000;
  assert.equal(JSON.parse((await local.send('/status.json')).body).generation, 2);
  assert.equal(fetches, 2);
});

test('an expired cache or missing credential never falls back to the obsolete local snapshot', async (t) => {
  let now = 0;
  let fail = false;
  const local = await fixture(t, { now: () => now, fetchImpl: async () => {
    if (fail) throw new Error(`private error ${TOKEN}`);
    return Response.json(status({ marker: 'first-live-response' }));
  } });
  assert.equal((await local.send('/status.json')).status, 200);
  now = 60000;
  fail = true;
  const result = await local.send('/status.json');
  assert.equal(result.status, 503);
  assert.equal(result.body.includes('first-live-response'), false);
  assert.equal(result.body.includes('obsolete-local-snapshot'), false);
  assert.equal(result.body.includes(TOKEN), false);
  const missing = await fixture(t, { loadToken: async () => { throw new Error('missing private credential file'); } });
  assert.equal((await missing.send('/status.json')).status, 503);
});

test('oversized or malformed upstream responses and redirects fail without leaking upstream details', async (t) => {
  for (const fetchImpl of [
    async () => new Response(TOKEN, { status: 401 }),
    async () => new Response(null, { status: 302, headers: { location: 'https://attacker.test' } }),
    async () => new Response('x'.repeat(257)),
    async () => new Response('tiny', { headers: { 'content-length': '257' } }),
    async () => new Response(`not-json ${TOKEN}`),
    async () => Response.json({ updatedAt: 'invalid', products: [] }),
  ]) {
    const local = await fixture(t, { fetchImpl, maxBytes: 256 });
    const result = await local.send('/status.json');
    assert.equal(result.status, 503);
    assert.equal(result.body.includes(TOKEN), false);
    assert.equal(result.body.includes('attacker.test'), false);
  }
});

test('the timeout covers response bodies and cancels a stalled transfer', async (t) => {
  for (const target of ['/status.json', '/api/trends']) {
    let cancelled = false;
    let signal;
    const local = await fixture(t, { timeoutMs: 20, fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
        cancel() { cancelled = true; },
      }));
    } });
    assert.equal((await local.send(target)).status, 503);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
  }
});

test('archive filters use only the fixed authenticated upstream without exposing secrets', async (t) => {
  const calls = [];
  const webhook = 'https://discord.com/api/webhooks/123456789/private-webhook';
  const local = await fixture(t, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(trends(url, {
      ADMIN_TOKEN: TOKEN, discordWebhook: webhook, encryptedWebhook: 'private-ciphertext',
      notes: { detail: `unexpected ${TOKEN} ${webhook}` },
    }));
  } });
  for (const days of ['all', '7', '30', '90', '365', '730']) {
    const result = await local.send(`/api/trends?days=${days}&styleColor=HQ4307-001`);
    assert.equal(result.status, 200);
    assert.equal(calls.at(-1).url, `${TRENDS_URL}?styleColor=HQ4307-001&days=${days}`);
    assert.equal(calls.at(-1).options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls.at(-1).options.redirect, 'error');
    assert.equal(calls.at(-1).options.method, 'GET');
    assert.equal(JSON.parse(result.body).totalEvents, 2);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.body.includes(TOKEN), false);
    assert.equal(result.body.includes(webhook), false);
    assert.equal(result.body.includes('private-ciphertext'), false);
    assert.equal(JSON.stringify(result.headers).includes(TOKEN), false);
  }
  const all = await local.send('/api/trends');
  assert.equal(all.status, 200);
  assert.equal(calls.at(-1).url, `${TRENDS_URL}?styleColor=all&days=all`);
  assert.equal(JSON.parse(all.body).styleColor, 'all');
  const head = await local.send('/api/trends', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('invalid archive filters are rejected before any credential read or upstream request', async (t) => {
  let reads = 0;
  let fetches = 0;
  const local = await fixture(t, {
    loadToken: async () => { reads++; return TOKEN; },
    fetchImpl: async () => { fetches++; return Response.json(trends()); },
  });
  for (const query of [
    'days=0', 'days=8', 'days=731', 'days=07', 'days=7.0', 'days=',
    'styleColor=', 'styleColor=hq4307-001', 'styleColor=ALL', 'styleColor=HQ4307-001%20',
    'styleColor=HQ4307-001%2Fadmin%2Fstate', 'styleColor=short-01',
    'days=7&days=30', 'styleColor=all&styleColor=HQ4307-001',
    'url=https://attacker.test/collect', 'token=private',
  ]) {
    assert.equal((await local.send(`/api/trends?${query}`)).status, 400, query);
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});

test('archive caching coalesces identical filters and never mixes products or periods', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const calls = [];
  let now = 0;
  let fail = false;
  const local = await fixture(t, { now: () => now, fetchImpl: async (url) => {
    calls.push(url);
    entered.resolve();
    await finish.promise;
    if (fail) throw new Error(`upstream failure ${TOKEN}`);
    return Response.json(trends(url, { marker: `generation-${calls.length}` }));
  } });
  const first = '/api/trends?styleColor=HQ4307-001&days=7';
  const pending = Array.from({ length: 6 }, () => local.send(first));
  await entered.promise;
  finish.resolve();
  assert.ok((await Promise.all(pending)).every((result) => result.status === 200));
  assert.equal(calls.length, 1);
  assert.equal((await local.send('/api/trends?days=7&styleColor=HQ4307-001')).status, 200);
  assert.equal(calls.length, 1);
  const month = JSON.parse((await local.send('/api/trends?styleColor=HQ4307-001&days=30')).body);
  const other = JSON.parse((await local.send('/api/trends?styleColor=HQ4307-200&days=7')).body);
  assert.equal(month.period.days, 30);
  assert.equal(other.styleColor, 'HQ4307-200');
  assert.equal(calls.length, 3);
  now = 59999;
  assert.equal(JSON.parse((await local.send(first)).body).marker, 'generation-1');
  now = 60000;
  fail = true;
  const expired = await local.send(first);
  assert.equal(expired.status, 503);
  assert.equal(expired.body.includes('generation-1'), false);
  assert.equal(expired.body.includes('obsolete-local-snapshot'), false);
  assert.equal(expired.body.includes(TOKEN), false);
  fail = false;
  assert.equal((await local.send(first)).status, 200);
  assert.equal(calls.length, 5);
});

test('unavailable or malformed archive data cannot be replaced by status history', async (t) => {
  for (const fetchImpl of [
    async () => Response.json(status({ history: [{ added: ['27'] }] })),
    async () => Response.json(trends(undefined, { totalEvents: 99 })),
    async () => Response.json(trends(undefined, { styleColor: 'HQ4307-001' })),
    async () => new Response(`not-json ${TOKEN}`),
    async () => new Response(TOKEN, { status: 401 }),
    async () => new Response(null, { status: 302, headers: { location: 'https://attacker.test' } }),
    async () => new Response('x'.repeat(2049)),
  ]) {
    const local = await fixture(t, { fetchImpl, maxBytes: 2048 });
    const result = await local.send('/api/trends');
    assert.equal(result.status, 503);
    assert.equal(result.body.includes(TOKEN), false);
    assert.equal(result.body.includes('attacker.test'), false);
    assert.equal(result.body.includes('obsolete-local-snapshot'), false);
  }
  const missing = await fixture(t, { loadToken: async () => '' });
  assert.equal((await missing.send('/api/trends')).status, 503);
});
