import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import './build-viewer-assets.js';

// Run the real Worker/SQLite APIs in an isolated local instance. No production
// credentials, persistent storage or live outbound services enter this check.
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const viewerConfig = JSON.parse(await readFile(new URL('../wrangler.viewer.jsonc', import.meta.url), 'utf8'));
assert.equal(config.assets, undefined, 'The private Worker must not publish static assets');
assert.equal(viewerConfig.assets, undefined, 'The viewer must retain ctx.access by bundling its fixed files');
const buildOptions = {
  bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', write: false, external: ['cloudflare:workers', 'node:*'],
};
const [bundle, viewerBundle] = await Promise.all([
  build({ ...buildOptions, entryPoints: [config.main] }),
  build({ ...buildOptions, entryPoints: [viewerConfig.main] }),
]);
let outgoing = 0;
const credential = 'isolated-runtime-test-only';
const audience = 'isolated-viewer-audience';
const email = 'owner@example.test';
const monitorName = 'nike-local-runtime-check';
const offline = async () => { outgoing++; return new Response('Offline test', { status: 503 }); };
const viewerService = { MONITOR_VIEWER: { name: monitorName, entrypoint: 'MonitorViewer' } };
const viewers = [
  { name: 'owner', access: { aud: audience, identity: { email: email.toUpperCase() } } },
  { name: 'other-owner', access: { aud: audience, identity: { email: 'other@example.test' } } },
  { name: 'wrong-audience', access: { aud: 'another-application', identity: { email } } },
  { name: 'no-identity', access: { aud: audience } },
  { name: 'unauthenticated' },
  { name: 'unconfigured', access: { aud: audience, identity: { email } }, bindings: {} },
];
const localOptions = convertV4MiniflareOptions({
  cf: false,
  workers: [
    {
      name: monitorName, routes: ['monitor.test/*'], modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      durableObjects: { MONITOR: { className: 'NikeMonitor', useSQLite: true } },
      bindings: { ADMIN_TOKEN: credential }, outboundService: offline,
    },
    ...viewers.map(({ name, access, bindings }) => ({
      name: `viewer-${name}`, routes: [`${name}.viewer.test/*`], modules: true,
      script: viewerBundle.outputFiles[0].text,
      compatibilityDate: viewerConfig.compatibility_date, compatibilityFlags: viewerConfig.compatibility_flags,
      bindings: bindings ?? { ACCESS_AUD: audience, VIEWER_EMAIL: email },
      serviceBindings: viewerService, access, outboundService: offline,
    })),
    {
      name: 'rpc-boundary', routes: ['rpc-boundary.test/*'], modules: true,
      compatibilityDate: config.compatibility_date, serviceBindings: viewerService, outboundService: offline,
      script: `export default {
        async fetch(request, env) {
          const results = {};
          for (const method of ['setMode', 'importState', 'exportState', 'alarm', 'probe']) {
            try { await env.MONITOR_VIEWER[method](); results[method] = { exposed: true }; }
            catch (error) { results[method] = { exposed: false, message: error.message }; }
          }
          return Response.json(results);
        }
      };`,
    },
  ],
});
const runtime = new Miniflare({ ...localOptions, telemetry: { enabled: false } });
const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
const request = (pathname, options) => runtime.dispatchFetch(`https://monitor.test${pathname}`, options);
const viewerRequest = (name, pathname, options) => runtime.dispatchFetch(`https://${name}.viewer.test${pathname}`, options);

try {
  for (const pathname of ['/', '/index.html', '/app.js', '/styles.css', '/trend-view.js']) {
    assert.equal((await request(pathname)).status, 404, pathname);
  }
  for (const pathname of ['/status.json', '/healthz', '/admin/state', '/admin/status']) {
    assert.equal((await request(pathname)).status, 401, pathname);
  }
  const status = await request('/admin/status', { headers });
  assert.equal(status.status, 200);
  const initial = await status.json();
  assert.equal(initial.meta.mode, 'paused');
  assert.equal(initial.config.runtime, 'cloudflare');

  const stockKey = '26|27';
  const transition = {
    at: new Date().toISOString(), styleColor: 'HQ4307-005',
    previous: [], current: ['26', '27'], added: ['26', '27'], removed: [],
  };
  const state = {
    knownProducts: { 'HQ4307-005': {
      styleColor: 'HQ4307-005', url: 'https://www.nike.com/jp/t/mind-001/HQ4307-005',
      lastStockKey: stockKey, stockHistory: [transition],
    } },
    checkSamples: Array.from({ length: 10000 }, (_, index) => ({
      at: new Date(Date.now() - index * 1000).toISOString(), styleColor: 'HQ4307-005', ok: true, durationMs: 123,
    })),
    events: [], history: [transition],
  };
  const imported = await request('/admin/import', {
    method: 'POST', headers, body: JSON.stringify({ state, migrationId: 'local-runtime-full-state' }),
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).checkSamples, 10000);
  const exported = await request('/admin/state', { headers });
  assert.equal(exported.status, 200);
  const restored = await exported.json();
  assert.deepEqual(restored.state.checkSamples, state.checkSamples);
  assert.equal(restored.state.knownProducts['HQ4307-005'].lastStockKey, stockKey);
  assert.deepEqual(restored.state.history, [transition]);
  assert.deepEqual(restored.state.knownProducts['HQ4307-005'].stockHistory, [transition]);
  assert.equal(JSON.stringify(restored).includes(credential), false);

  // This is the platform's actual ctx.access implementation, not a unit-test
  // object. Every viewer has only the read-only named service binding.
  const protectedPaths = ['/', '/index.html', '/app.js', '/styles.css', '/trend-view.js', '/restock-trends.js', '/status.json', '/api/trends'];
  for (const { name } of viewers.filter((viewer) => viewer.name !== 'owner')) {
    for (const pathname of protectedPaths) {
      const denied = await viewerRequest(name, pathname, {
        headers: { 'cf-access-authenticated-user-email': email, 'cf-access-jwt-assertion': 'forged', cookie: 'CF_Authorization=forged' },
      });
      assert.equal(denied.status, 401, `${name}: ${pathname}`);
      assert.equal(await denied.text(), 'Unauthorized');
      assert.match(denied.headers.get('cache-control'), /no-store/);
    }
  }
  for (const pathname of protectedPaths.filter((pathname) => !['/status.json', '/api/trends'].includes(pathname))) {
    const asset = await viewerRequest('owner', pathname);
    assert.equal(asset.status, 200, pathname);
    assert.ok((await asset.text()).length > 0);
    assert.match(asset.headers.get('cache-control'), /no-store/);
    assert.match(asset.headers.get('x-robots-tag'), /noindex/);
  }
  const viewedStatus = await viewerRequest('owner', '/status.json');
  assert.equal(viewedStatus.status, 200, 'The owner must reach MonitorViewer.getStatus through a real service binding');
  const viewerStatus = await viewedStatus.json();
  assert.equal(viewerStatus.meta.mode, 'paused');
  assert.deepEqual(viewerStatus.history, [transition]);
  assert.equal(JSON.stringify(viewerStatus).includes(credential), false);
  for (const days of ['all', '7', '30', '90', '365', '730']) {
    const response = await viewerRequest('owner', `/api/trends?days=${days}&styleColor=HQ4307-005`);
    assert.equal(response.status, 200, `SQLite trend aggregation: ${days}`);
    const summary = await response.json();
    assert.equal(summary.totalEvents, 1, 'Global and product history must count the same transition once');
    assert.equal(summary.hours.length, 24);
    assert.equal(summary.hours.reduce((sum, row) => sum + row.count, 0), 1);
    assert.equal(summary.distinctProducts, 1);
    assert.equal(summary.period.days, days === 'all' ? 'all' : Number(days));
    assert.equal(summary.notes.retentionDays, 730);
    assert.equal(JSON.stringify(summary).includes(credential), false);
  }
  assert.equal((await viewerRequest('owner', '/api/trends?days=731')).status, 400);
  assert.equal((await viewerRequest('owner', '/api/trends?styleColor=invalid')).status, 400);
  assert.equal((await viewerRequest('owner', '/admin/state')).status, 404);
  assert.equal((await viewerRequest('owner', '/status.json', { method: 'POST' })).status, 405);
  const head = await viewerRequest('owner', '/status.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const boundary = await runtime.dispatchFetch('https://rpc-boundary.test/');
  assert.equal(boundary.status, 200);
  for (const [method, result] of Object.entries(await boundary.json())) {
    assert.equal(result.exposed, false, `MonitorViewer must not expose ${method}`);
    assert.match(result.message, /does not implement|not implemented|not a function|reserved method.*cannot be called over RPC/i, method);
  }
  const afterViewing = await (await request('/admin/state', { headers })).json();
  assert.deepEqual(afterViewing.state, restored.state, 'Viewer requests must preserve the complete monitoring state');

  const activate = await request('/admin/mode', {
    method: 'POST', headers, body: JSON.stringify({ mode: 'active' }),
  });
  assert.equal(activate.status, 409, 'Live mode requires a configured Discord webhook');
  assert.equal(outgoing, 0, 'An isolated validation must not contact Nike or Discord');
  console.log('Cloudflare runtime check passed: Access identity and audience, read-only viewer RPC, SQLite trends and 10,000 observations, preserved notification state, no external requests.');
} finally {
  await runtime.dispose();
}
