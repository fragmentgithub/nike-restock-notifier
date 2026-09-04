import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import viewer from '../src/viewer-worker.js';
import { VIEWER_ASSETS } from '../.viewer-build/assets.js';

const AUDIENCE = 'isolated-viewer-test';
const EMAIL = 'owner@example.test';
const routes = ['/', '/index.html', '/app.js', '/styles.css', '/trend-view.js', '/restock-trends.js', '/status.json', '/api/trends', '/admin/state'];

function harness() {
  const calls = [];
  const status = { updatedAt: '2026-09-05T00:00:00Z', products: [], history: [] };
  const env = {
    ACCESS_AUD: AUDIENCE, VIEWER_EMAIL: EMAIL,
    MONITOR_VIEWER: {
      async getStatus() { calls.push(['status']); return status; },
      async getTrends(options) { calls.push(['trends', options]); return { totalEvents: 3, options }; },
    },
  };
  const ctx = { access: { aud: AUDIENCE, async getIdentity() { return { email: EMAIL }; } } };
  const request = (path, options = {}, context = ctx) => viewer.fetch(new Request(`https://viewer.test${path}`, options), env, context);
  return { calls, status, env, ctx, request };
}

test('Access context is required before every page, asset, API and method', async () => {
  const { request, calls } = harness();
  for (const path of routes) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await request(path, {
        method,
        headers: { 'cf-access-authenticated-user-email': EMAIL, 'cf-access-jwt-assertion': 'forged', cookie: 'CF_Authorization=forged' },
      }, {});
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'Unauthorized');
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
  }
  assert.deepEqual(calls, []);
});

test('missing settings, wrong audience, other identities and identity failures fail closed', async () => {
  for (const change of [
    ({ env }) => { delete env.ACCESS_AUD; },
    ({ env }) => { env.ACCESS_AUD = ' '; },
    ({ env }) => { delete env.VIEWER_EMAIL; },
    ({ env }) => { env.VIEWER_EMAIL = ''; },
    ({ ctx }) => { ctx.access.aud = 'different-app'; },
    ({ ctx }) => { ctx.access.getIdentity = async () => undefined; },
    ({ ctx }) => { ctx.access.getIdentity = async () => ({ email: 'other@example.test' }); },
    ({ ctx }) => { ctx.access.getIdentity = async () => ({ email: `${EMAIL}.attacker.test` }); },
    ({ ctx }) => { ctx.access.getIdentity = async () => ({ email: ` ${EMAIL}` }); },
    ({ ctx }) => { ctx.access.getIdentity = async () => { throw new Error('identity token details'); }; },
  ]) {
    const setup = harness();
    change(setup);
    const response = await setup.request('/status.json');
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'Unauthorized');
    assert.deepEqual(setup.calls, []);
  }
});

test('the exact owner identity is accepted case-insensitively and status uses only read-only RPC', async () => {
  const { ctx, request, calls, status } = harness();
  ctx.access.getIdentity = async () => ({ email: EMAIL.toUpperCase() });
  const response = await request('/status.json');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), status);
  assert.deepEqual(calls, [['status']]);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('only the five fixed source files are bundled and served after authentication', async () => {
  const { request, calls } = harness();
  assert.deepEqual(Object.keys(VIEWER_ASSETS).sort(), ['/index.html', '/app.js', '/styles.css', '/trend-view.js', '/restock-trends.js'].sort());
  for (const [path, asset] of Object.entries(VIEWER_ASSETS)) {
    assert.equal(asset.body, await readFile(new URL(`../public${path}`, import.meta.url), 'utf8'));
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), asset.body);
    assert.equal(response.headers.get('content-type'), asset.contentType);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
  assert.equal(await (await request('/')).text(), VIEWER_ASSETS['/index.html'].body);
  assert.deepEqual(calls, []);
});

test('unknown paths, encoded file aliases and admin routes cannot reach assets or RPC', async () => {
  const { request, calls } = harness();
  for (const path of ['/admin/status', '/admin/state', '/admin/mode', '/.env', '/%61pp.js', '/assets/app.js', '/app.js/', '/status.json.bak', '/api/trends/', '/__proto__']) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.deepEqual(calls, []);
});

test('the viewer rejects mutations without calling the monitor', async () => {
  const { request, calls } = harness();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request('/status.json', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  assert.deepEqual(calls, []);
});

test('trend filters accept only bounded periods and valid product codes', async () => {
  const { request, calls } = harness();
  for (const [query, options] of [
    ['', { days: 'all', styleColor: 'all' }],
    ['?days=7&styleColor=hq4307-005', { days: 7, styleColor: 'HQ4307-005' }],
    ['?days=30&styleColor=IQ8502-001', { days: 30, styleColor: 'IQ8502-001' }],
    ['?days=90&styleColor=HQ4307-005', { days: 90, styleColor: 'HQ4307-005' }],
    ['?days=365&styleColor=HQ4307-005', { days: 365, styleColor: 'HQ4307-005' }],
    ['?days=730&styleColor=abcde-a1b', { days: 730, styleColor: 'ABCDE-A1B' }],
    ['?days=all&styleColor=all', { days: 'all', styleColor: 'all' }],
  ]) {
    const response = await request(`/api/trends${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).options, options);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(calls.length, 7);
  for (const query of ['?days=0', '?days=8', '?days=731', '?days=', '?days=7&days=30', '?styleColor=', '?styleColor=HQ4307', '?styleColor=HQ4307-A_B', '?styleColor=HQ4307-005/other', '?styleColor=all&styleColor=HQ4307-005', '?token=secret']) {
    assert.equal((await request(`/api/trends${query}`)).status, 400, query);
  }
  assert.equal(calls.length, 7);
});

test('HEAD preserves the route status and headers without returning a body', async () => {
  const { request } = harness();
  for (const path of ['/', '/app.js', '/status.json', '/api/trends?days=7']) {
    const response = await request(path, { method: 'HEAD' });
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), '');
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('RPC errors return a private generic response without exposing details', async () => {
  const { request, env } = harness();
  env.MONITOR_VIEWER.getStatus = async () => { throw new Error('private admin credential'); };
  const response = await request('/status.json');
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Temporarily unavailable');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('viewer configuration has no asset-router or monitoring bindings and disables previews', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.viewer.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'nike-restock-viewer');
  const monitorConfig = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.account_id, monitorConfig.account_id);
  assert.equal(config.assets, undefined);
  assert.equal(config.preview_urls, false);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.vars, undefined);
  assert.deepEqual(config.services, [{ binding: 'MONITOR_VIEWER', service: 'nike-restock-notifier', entrypoint: 'MonitorViewer' }]);
});
