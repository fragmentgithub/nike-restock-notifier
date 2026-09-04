import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleWorkerRequest, MAX_ADMIN_BYTES, validateImport } from '../src/worker-admin.js';
import { MonitorController } from '../src/worker-monitor.js';

const ADMIN_TOKEN = 'test-admin-credential-keep-this-private';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/webhook-secret-token';
const NOW = Date.parse('2026-09-04T00:00:00.000Z');

function request(path, { token = ADMIN_TOKEN, method = 'GET', payload, headers = {} } = {}) {
  return new Request(`https://monitor.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}

function fixture(t, { engineFactory, env = {}, probe } = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const storage = {
    alarmTime: null,
    sql: { exec(query, ...args) {
      const rows = database.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
    getAlarm: async () => storage.alarmTime,
    setAlarm: async (at) => { storage.alarmTime = at; },
    deleteAlarm: async () => { storage.alarmTime = null; },
  };
  const bindings = { ADMIN_TOKEN, ...env };
  const controller = new MonitorController({ storage }, bindings, { engineFactory, probe, now: () => NOW });
  bindings.MONITOR = { getByName: (name) => { assert.equal(name, 'nike-jp'); return controller; } };
  return { controller, storage, bindings };
}

test('all admin routes fail closed without the configured secret or with a wrong token', async () => {
  let calls = 0;
  const env = { MONITOR: { getByName: () => { calls++; } } };
  for (const path of ['/admin/state', '/admin/health', '/admin/import', '/admin/mode', '/admin/probe', '/admin/migration-credential']) {
    assert.equal((await handleWorkerRequest(request(path), env)).status, 401);
    assert.equal((await handleWorkerRequest(request(path, { token: 'wrong' }), { ...env, ADMIN_TOKEN })).status, 401);
  }
  assert.equal(calls, 0);
});

test('migration transfer rejects an admin credential and unsigned tokens before reading or importing data', async () => {
  let calls = 0;
  const env = { ADMIN_TOKEN, MONITOR: { getByName: () => { calls++; } } };
  for (const token of [ADMIN_TOKEN, 'not.a.jwt', '']) {
    const response = await handleWorkerRequest(request('/migration/transfer', {
      method: 'POST', token, payload: { state: {} },
    }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(calls, 0);
});

test('migration commits state and ciphertext privately, binds run identity and rejects old-run replays', async (t) => {
  const { controller, bindings } = fixture(t);
  const encryptedWebhook = Buffer.alloc(384, 97).toString('base64');
  const identity = { runId: '33895000001', runAttempt: '1', migrationId: '33895000001:1' };
  const payload = { state: { marker: 'first',
    discoveryCycle: { index: 1 }, lastDiscoveryAt: '2026-09-04T00:00:00.000Z',
    lastDiscoverySuccessAt: '2026-09-04T00:00:00.000Z', lastDiscoveryAttemptAt: '2026-09-04T00:00:00.000Z',
  }, vars: { INTERVAL_SECONDS: '180' }, migrationId: identity.migrationId, encryptedWebhook };
  assert.equal((await controller.acceptMigration({ ...payload, migrationId: 'different' }, identity)).status, 400);
  assert.equal((await controller.acceptMigration(payload, identity)).imported, true);
  assert.equal((await controller.exportState()).state.marker, 'first');
  for (const key of ['discoveryCycle', 'lastDiscoveryAt', 'lastDiscoverySuccessAt', 'lastDiscoveryAttemptAt']) {
    assert.equal((await controller.exportState()).state[key], undefined);
  }
  for (const output of [await controller.exportState(), await controller.getStatus(), await controller.health()]) {
    assert.equal(JSON.stringify(output).includes(encryptedWebhook), false);
  }
  const credential = await handleWorkerRequest(request('/admin/migration-credential'), bindings);
  assert.equal(credential.status, 200);
  assert.deepEqual(await credential.json(), { migrationId: identity.migrationId, encryptedWebhook });
  assert.equal((await controller.acceptMigration({ ...payload, state: { marker: 'replayed' } }, identity)).imported, false);
  assert.equal((await controller.exportState()).state.marker, 'first');
  const retry = { runId: identity.runId, runAttempt: '2', migrationId: `${identity.runId}:2` };
  assert.equal((await controller.acceptMigration({ ...payload, migrationId: retry.migrationId, state: { marker: 'retry' } }, retry)).imported, true);
  assert.equal((await controller.acceptMigration(payload, identity)).status, 409);
  assert.equal((await controller.deleteMigrationCredential(identity.migrationId)).status, 409);
  assert.equal((await controller.deleteMigrationCredential(retry.migrationId)).deleted, true);
  assert.equal((await controller.migrationCredential()).status, 404);
  assert.equal((await controller.acceptMigration({ ...payload, migrationId: retry.migrationId }, retry)).imported, false);
  assert.equal((await controller.migrationCredential()).status, 404);
  await controller.setMode('shadow');
  assert.equal((await controller.acceptMigration(payload, identity)).status, 409);
});

test('migration ciphertext and state roll back atomically on a database failure', async (t) => {
  const { controller, storage } = fixture(t);
  await controller.importState({ state: { marker: 'before' } });
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT INTO monitor_documents') && args[0] === 'migration-credential') {
      throw new Error('storage failure');
    }
    return exec(query, ...args);
  };
  const identity = { runId: '33895000001', runAttempt: '1', migrationId: '33895000001:1' };
  await assert.rejects(controller.acceptMigration({
    state: { marker: 'after' }, migrationId: identity.migrationId,
    encryptedWebhook: Buffer.alloc(384, 97).toString('base64'),
  }, identity), /storage failure/);
  assert.equal((await controller.exportState()).state.marker, 'before');
  assert.equal((await controller.migrationCredential()).status, 404);
});

test('HTTP method, JSON format and request size are enforced before invoking mutations', async (t) => {
  const { bindings } = fixture(t);
  assert.equal((await handleWorkerRequest(request('/admin/mode'), bindings)).status, 405);
  assert.equal((await handleWorkerRequest(request('/admin/import', { method: 'POST' }), bindings)).status, 415);
  assert.equal((await handleWorkerRequest(request('/admin/import', {
    method: 'POST', payload: {}, headers: { 'content-length': String(MAX_ADMIN_BYTES + 1) },
  }), bindings)).status, 413);
  assert.equal((await handleWorkerRequest(request('/admin/mode', { method: 'POST', payload: { mode: 'typo' } }), bindings)).status, 400);
  const malformed = new Request('https://monitor.test/admin/import', {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{bad',
  });
  assert.equal((await handleWorkerRequest(malformed, bindings)).status, 400);
});

test('chunked bodies cannot bypass the 12 MB request limit', async (t) => {
  const { bindings } = fixture(t);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_ADMIN_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  const oversized = new Request('https://monitor.test/admin/import', {
    method: 'POST', duplex: 'half', body,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
  });
  assert.equal((await handleWorkerRequest(oversized, bindings)).status, 413);
  assert.equal(cancelled, true);
});

test('import retains notification state, is idempotent and requires the paused mode', async (t) => {
  const { controller, storage, bindings } = fixture(t, { env: { DISCORD_WEBHOOK: WEBHOOK } });
  const payload = {
    migrationId: 'legacy-run-123', vars: { INTERVAL_SECONDS: '180' },
    state: {
      knownProducts: { 'HQ4307-005': {
        url: 'https://www.nike.com/jp/t/mind-001/HQ4307-005', styleColor: 'HQ4307-005', lastStockKey: '26,27',
      } },
      history: [], events: [], checkSamples: [],
    },
  };
  const response = await handleWorkerRequest(request('/admin/import', { method: 'POST', payload }), bindings);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).imported, true);
  const exported = await controller.exportState();
  assert.equal(exported.state.knownProducts['HQ4307-005'].lastStockKey, '26,27');
  assert.equal(exported.vars.INTERVAL_SECONDS, '180');
  assert.equal(storage.alarmTime, null);
  assert.equal((await controller.importState({ ...payload, state: {} })).imported, false);
  await controller.setMode('shadow');
  assert.equal((await controller.importState({ ...payload, migrationId: 'new' })).status, 409);
  const restarted = new MonitorController({ storage }, bindings, { now: () => NOW });
  assert.equal((await restarted.health()).mode, 'shadow');
});

test('only supported string settings are imported and webhook secrets cannot enter the import API', () => {
  assert.match(validateImport({ state: {}, vars: { ADMIN_TOKEN: 'bad' } }), /supported string/);
  assert.match(validateImport({ state: {}, vars: { INTERVAL_SECONDS: 30 } }), /supported string/);
  assert.match(validateImport({ state: {}, webhook: WEBHOOK }), /secret binding/);
  let nested = {};
  for (let i = 0; i < 35; i++) nested = { nested };
  assert.match(validateImport({ state: nested }), /structure/);
});

test('active mode requires a valid Discord secret, and default mode is paused', async (t) => {
  const { controller } = fixture(t);
  assert.equal((await controller.health()).mode, 'paused');
  assert.equal((await controller.setMode('active')).status, 409);
  assert.equal((await controller.health()).mode, 'paused');
  assert.equal((await controller.setMode('shadow')).ok, true);
});

test('pause waits for the in-flight tick and forbids sends after its response', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let sends = 0;
  let storage;
  const engineFactory = ({ state, notify, persist }) => ({
    snapshot: () => state, status: () => ({ config: {} }), nextAlarmAt: () => NOW + 30000,
    tick: async () => {
      assert.equal(storage.alarmTime, NOW + 120000);
      entered.resolve();
      await finish.promise;
      if (notify) sends++;
      await persist({ ...state, notified: true }, { config: {} });
    },
  });
  const fixtureResult = fixture(t, { engineFactory, env: { DISCORD_WEBHOOK: WEBHOOK } });
  const { controller } = fixtureResult;
  storage = fixtureResult.storage;
  await controller.setMode('active');
  const tick = controller.alarm();
  await entered.promise;
  assert.deepEqual(await controller.ensureScheduled(), { repaired: false, running: true });
  let paused = false;
  const pause = controller.setMode('paused').then((result) => { paused = true; return result; });
  await Promise.resolve();
  assert.equal(paused, false);
  finish.resolve();
  await tick;
  assert.equal((await pause).mode, 'paused');
  assert.equal(storage.alarmTime, null);
  assert.equal(sends, 1);
  await controller.alarm();
  assert.equal(sends, 1);
  assert.equal((await controller.exportState()).state.notified, true);
});

test('failed ticks keep a recovery alarm and watchdog repairs missing alarms after restart', async (t) => {
  const engineFactory = ({ state }) => ({
    snapshot: () => state, status: () => ({ config: {} }), nextAlarmAt: () => NOW + 30000,
    tick: async () => { throw new Error(`network error ${WEBHOOK} ${ADMIN_TOKEN}`); },
  });
  const { controller, storage, bindings } = fixture(t, { engineFactory });
  await controller.setMode('shadow');
  await controller.alarm();
  assert.equal(storage.alarmTime, NOW + 120000);
  assert.equal((await controller.health()).healthy, false);
  assert.equal(JSON.stringify(await controller.health()).includes(ADMIN_TOKEN), false);
  storage.alarmTime = null;
  const restarted = new MonitorController({ storage }, bindings, { engineFactory, now: () => NOW });
  assert.equal((await restarted.ensureScheduled()).repaired, true);
  assert.equal(storage.alarmTime, NOW + 30000);
});

test('secret values and secret-shaped fields never appear in exports, public status or errors', async (t) => {
  const { controller, bindings } = fixture(t, { env: { DISCORD_WEBHOOK: WEBHOOK } });
  await controller.importState({ state: {
    ADMIN_TOKEN, webhook: WEBHOOK,
    events: [{ message: `${WEBHOOK} ${ADMIN_TOKEN} webhook-secret-token`, token: ADMIN_TOKEN }],
  } });
  for (const value of [await controller.exportState(), await controller.getStatus(), await controller.health()]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(WEBHOOK), false);
    assert.equal(serialized.includes(ADMIN_TOKEN), false);
    assert.equal(serialized.includes('webhook-secret-token'), false);
  }
  bindings.MONITOR = { getByName: () => { throw new Error(`${WEBHOOK} ${ADMIN_TOKEN}`); } };
  const failed = await handleWorkerRequest(request('/status.json'), bindings);
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes('secret'), false);
});

test('static assets bypass the monitor and public status cannot be cached', async (t) => {
  const { bindings } = fixture(t);
  const status = await handleWorkerRequest(request('/status.json', { token: '' }), bindings);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const assets = await handleWorkerRequest(request('/app.js'), {
    MONITOR: { getByName: () => { throw new Error('must not enter monitor'); } },
    ASSETS: { fetch: async () => new Response('asset') },
  });
  assert.equal(await assets.text(), 'asset');
});
