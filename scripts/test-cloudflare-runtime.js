import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Run the real Worker/SQLite APIs in an isolated local instance. No production
// credentials, persistent storage or live outbound services enter this check.
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
assert.equal(config.assets, undefined, 'The private Worker must not publish static assets');
const bundle = await build({
  entryPoints: [config.main], bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', write: false, external: ['cloudflare:workers', 'node:*'],
});
let outgoing = 0;
const credential = 'isolated-runtime-test-only';
const localOptions = convertV4MiniflareOptions({
  name: 'nike-local-runtime-check', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  durableObjects: { MONITOR: { className: 'NikeMonitor', useSQLite: true } },
  bindings: { ADMIN_TOKEN: credential }, cf: false,
  outboundService: async () => { outgoing++; return new Response('Offline test', { status: 503 }); },
});
const runtime = new Miniflare({ ...localOptions, telemetry: { enabled: false } });
const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
const request = (pathname, options) => runtime.dispatchFetch(`https://local.test${pathname}`, options);

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

  const stockKey = '26,27';
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
  const activate = await request('/admin/mode', {
    method: 'POST', headers, body: JSON.stringify({ mode: 'active' }),
  });
  assert.equal(activate.status, 409, 'Live mode requires a configured Discord webhook');
  assert.equal(outgoing, 0, 'An isolated validation must not contact Nike or Discord');
  console.log('Cloudflare runtime check passed: private routes, SQLite history and 10,000 observations, notification state, no external requests.');
} finally {
  await runtime.dispose();
}
