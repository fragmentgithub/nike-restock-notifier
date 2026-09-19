import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorController } from '../src/worker-monitor.js';
import { createMonitorEngine } from '../src/monitor-engine.js';
import { DEFAULT_MIND_001_URLS, DEFAULT_FRAGMENT_PRODUCTS } from '../src/discovery.js';
import { evaluateWorkerHealth } from '../src/health.js';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function fixture(t, { engineFactory, env = {}, now = () => NOW } = {}) {
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
  const controller = new MonitorController({ storage }, env, { engineFactory, now });
  return { controller, storage };
}

test('each alarm persists its start before work without rebuilding the old status or duplicating history saves', async (t) => {
  let controller;
  let statusBuilds = 0;
  const engineFactory = ({ state, persist }) => ({
    snapshot: () => state,
    status: () => { statusBuilds++; return { config: {} }; },
    nextAlarmAt: () => NOW + 30000,
    tick: async () => {
      assert.equal(controller.documents.read('control').lastStartedAt, new Date(NOW).toISOString());
      await persist({ ...state, lastStockKey: 'already-notified' }, { config: {}, checked: true });
    },
  });
  ({ controller } = fixture(t, { engineFactory }));
  await controller.setMode('shadow');
  const statusBuildsBefore = statusBuilds;
  const savedDocuments = [];
  const commit = controller.documents.commit.bind(controller.documents);
  controller.documents.commit = async (documents) => {
    savedDocuments.push(Object.keys(documents));
    await commit(documents);
  };
  await controller.alarm();
  assert.equal(statusBuilds - statusBuildsBefore, 0);
  assert.equal(savedDocuments.filter((names) => names.includes('state')).length, 1);
  assert.equal((await controller.exportState()).state.lastStockKey, 'already-notified');
  assert.equal(controller.documents.read('status').checked, true);
});

test('an alarm firing during a long check leaves a recovery alarm without starting a second check', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let now = NOW;
  let ticks = 0;
  const engineFactory = ({ state, persist }) => ({
    snapshot: () => state, status: () => ({ config: {} }), nextAlarmAt: () => now + 30000,
    tick: async () => {
      ticks++;
      entered.resolve();
      await finish.promise;
      await persist(state, { config: {} });
    },
  });
  const { controller, storage } = fixture(t, { engineFactory, now: () => now });
  await controller.setMode('shadow');
  const first = controller.alarm();
  await entered.promise;
  now += 120000;
  storage.alarmTime = null; // Cloudflare consumes the alarm that is being delivered.
  await controller.alarm();
  const recovery = storage.alarmTime;
  finish.resolve();
  await first;
  assert.equal(recovery, now + 120000);
  assert.equal(ticks, 1);
  assert.equal(storage.alarmTime, now + 30000);
});

test('the cron backup guard creates at most one automatic generation per UTC day', async (t) => {
  let now = NOW;
  const { controller } = fixture(t, { now: () => now });
  let latest = null;
  let creates = 0;
  controller.backup = {
    latest: async () => latest,
    createDaily: async () => {
      creates += 1;
      latest = { generation: `generation-${creates}`, createdAt: new Date(now).toISOString() };
      return latest;
    },
  };
  assert.equal((await controller.ensureBackedUp()).created, true);
  assert.equal((await controller.ensureBackedUp()).created, false);
  assert.deepEqual(controller.documents.read('control'), {
    mode: 'paused',
    lastBackupAt: new Date(now).toISOString(),
    backupFailureStreak: 0,
    lastBackupError: null,
  });
  assert.equal((await controller.health()).backupHealthy, true);
  now += 86400000;
  assert.equal((await controller.ensureBackedUp()).created, true);
  assert.equal(creates, 2);
});

test('backup failures persist generically across restarts and a later success restores health', async (t) => {
  let now = NOW;
  let shouldFail = true;
  let creates = 0;
  const { controller, storage } = fixture(t, { now: () => now });
  const backup = {
    latest: async () => null,
    createDaily: async () => {
      creates += 1;
      if (shouldFail) throw new Error('provider failure with private-token-value');
      return { generation: `generation-${creates}`, createdAt: new Date(now).toISOString() };
    },
  };
  controller.backup = backup;

  await assert.rejects(controller.ensureBackedUp(), {
    message: 'Daily backup failed; automatic retry is scheduled.',
  });
  assert.equal(controller.documents.read('control').backupFailureStreak, 1);
  assert.equal(JSON.stringify(controller.documents.read('control')).includes('private-token-value'), false);

  const restarted = new MonitorController({ storage }, {}, { now: () => now });
  restarted.backup = backup;
  assert.equal((await restarted.health()).backupHealthy, false);
  await assert.rejects(restarted.ensureBackedUp());
  assert.equal(restarted.documents.read('control').backupFailureStreak, 2);

  shouldFail = false;
  const recovered = await restarted.backupNow();
  assert.equal(recovered.ok, true);
  assert.equal((await restarted.health()).healthy, true);
  assert.equal(restarted.documents.read('control').backupFailureStreak, 0);
  assert.equal(restarted.documents.read('control').lastBackupError, null);

  now += 24 * 60 * 60 * 1000;
  assert.equal((await restarted.health()).backupHealthy, true);
  now += 1;
  const stale = await restarted.health();
  assert.equal(stale.backupHealthy, false);
  assert.equal(stale.healthy, false);
});

test('health discovers the latest backup when upgrading an old control record', async (t) => {
  const { controller } = fixture(t);
  controller.backup = {
    latest: async () => ({ createdAt: new Date(NOW - 60000).toISOString() }),
  };
  const health = await controller.health();
  assert.equal(health.backupHealthy, true);
  assert.equal(health.lastBackupAt, new Date(NOW - 60000).toISOString());
});

const TARGET = 'HQ4307-005';
const OTHER = 'HQ4307-003';
const WEBHOOK = 'https://discord.com/api/webhooks/123456/test-token';

async function monitoringFixture(t, { enabled = [TARGET, OTHER], fetchImpl, now, state = {} }) {
  const ids = [...DEFAULT_MIND_001_URLS.map((url) => url.split('/').at(-1)),
    ...DEFAULT_FRAGMENT_PRODUCTS.map((product) => product.styleColor)];
  const env = { DISCORD_WEBHOOK: WEBHOOK, PRODUCT_CONFIG_JSON: JSON.stringify(
    Object.fromEntries(ids.map((id) => [id, { enabled: enabled.includes(id) }])),
  ) };
  const engineFactory = (options) => createMonitorEngine({ ...options, fetchImpl });
  const result = fixture(t, { env, engineFactory, now });
  const backup = { latest: async () => ({ createdAt: new Date(now()).toISOString() }) };
  result.controller.backup = backup;
  await result.controller.documents.commit({
    control: { mode: 'active' },
    state: { lastDiscoveryAt: new Date(now()).toISOString(),
      lastDiscoverySuccessAt: new Date(now()).toISOString(), ...state },
  });
  return { ...result, restart() {
    const controller = new MonitorController({ storage: result.storage }, env, { engineFactory, now });
    controller.backup = backup;
    return controller;
  } };
}

function stockedPage(styleColor) {
  return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: {
    selectedProduct: { styleColor, productInfo: {
      fullTitle: 'Nike Mind 001', url: `https://www.nike.com/jp/t/mind-001/${styleColor}`,
    }, sizes: [{ merchSkuId: 'sku-27', localizedLabel: '27', label: '27', status: 'ACTIVE' }] },
  } } })}</script><div id="size-selector"><button>27</button></div>
    <button data-testid="add-to-cart">カートに追加</button><div id="product-description-container"></div>`);
}

test('repeated failures across every active product degrade health, survive restart and recover on a success', async (t) => {
  let now = NOW;
  let failing = true;
  const setup = await monitoringFixture(t, { now: () => now, fetchImpl: async (url) => {
    if (url.startsWith('https://discord.com')) return new Response(null, { status: 204 });
    return failing ? new Response('unavailable', { status: 503 }) : stockedPage(url.split('/').at(-1));
  } });
  let controller = setup.controller;
  await controller.alarm();
  assert.equal((await controller.health()).healthy, true, 'one transient failure must not trigger an alert');
  for (let i = 0; i < 3; i++) {
    now = setup.storage.alarmTime;
    controller = setup.restart();
    await controller.alarm();
  }
  const failed = await controller.health();
  assert.equal(failed.checksHealthy, false);
  assert.equal(failed.healthy, false);
  assert.match(evaluateWorkerHealth(failed, { now }).reason, /取得が連続して失敗/);
  assert.match((await controller.getStatus()).meta.lastError, /取得が連続して失敗/);
  assert.equal(JSON.stringify(failed).includes(TARGET), false);
  assert.equal(JSON.stringify(failed).includes(WEBHOOK), false);
  assert.equal((await setup.restart().health()).healthy, false);

  failing = false;
  now = setup.storage.alarmTime;
  controller = setup.restart();
  await controller.alarm();
  assert.equal((await controller.health()).healthy, true);
  assert.equal((await controller.getStatus()).meta.lastError, null);
});

test('paused-product reprobe failures do not degrade health when no active products remain', async (t) => {
  let now = NOW;
  const setup = await monitoringFixture(t, { enabled: [OTHER], now: () => now,
    state: { knownProducts: {
      [OTHER]: { styleColor: OTHER, url: `https://www.nike.com/jp/t/mind-001/${OTHER}`,
        pausedAt: new Date(NOW - 86400000).toISOString(), pausedReason: 'delisted',
        checkFailureStreak: 10 },
    } },
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  });
  for (let i = 0; i < 3; i++) {
    await setup.controller.alarm();
    now = setup.storage.alarmTime;
  }
  assert.equal((await setup.controller.health()).healthy, true);
  assert.equal((await setup.controller.getStatus()).metrics.activeProducts, 0);
  assert.equal((await setup.controller.getStatus()).metrics.pausedProducts, 1);
});

test('repeated unknown inventory degrades health without changing transport metrics, then reliable stock recovers', async (t) => {
  let now = NOW;
  let unknown = true;
  const setup = await monitoringFixture(t, { enabled: [TARGET], now: () => now, fetchImpl: async (url) => {
    if (url.startsWith('https://discord.com')) return new Response(null, { status: 204 });
    if (!unknown) return stockedPage(TARGET);
    if (url.includes('/product_details_availability/')) return Response.json({ groupKey: 'mind-group', sizes: [] });
    return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: {
      selectedProduct: { styleColor: TARGET, groupKey: 'mind-group', globalProductId: `global-${TARGET}`,
        productInfo: { fullTitle: 'Nike Mind 001', url: `https://www.nike.com/jp/t/mind-001/${TARGET}` },
        sizes: [{ merchSkuId: 'sku-27', localizedLabel: '27', label: '27', status: 'ACTIVE' }],
      },
    } } })}</script>`);
  } });
  await setup.controller.alarm();
  let status = await setup.controller.getStatus();
  assert.equal(status.lastResult.ok, true);
  assert.equal(status.lastResult.availabilityState, 'unknown');
  assert.equal((await setup.controller.health()).healthy, true);
  now = setup.storage.alarmTime;
  let controller = setup.restart();
  await controller.alarm();
  status = await controller.getStatus();
  assert.equal(status.metrics.successRate, 100);
  assert.equal(status.metrics.consecutiveFailedCycles, 0);
  assert.equal((await controller.health()).checksHealthy, false);
  assert.equal((await controller.health()).healthy, false);
  assert.equal((await setup.restart().health()).healthy, false);
  unknown = false;
  now = setup.storage.alarmTime;
  controller = setup.restart();
  await controller.alarm();
  assert.equal((await controller.health()).healthy, true);
  assert.equal((await controller.getStatus()).meta.lastError, null);
});

test('repeated Discord delivery failures degrade health independently of successful Nike checks', async (t) => {
  let now = NOW;
  let failing = true;
  let posts = 0;
  const setup = await monitoringFixture(t, { enabled: [TARGET], now: () => now, fetchImpl: async (url) => {
    if (!url.startsWith('https://discord.com')) return stockedPage(TARGET);
    posts++;
    return new Response(null, { status: failing ? 404 : 204 });
  } });
  await setup.controller.alarm();
  assert.equal((await setup.controller.health()).healthy, true);
  now = setup.storage.alarmTime;
  let controller = setup.restart();
  await controller.alarm();
  assert.equal(posts, 2);
  const failed = await controller.health();
  assert.equal(failed.checksHealthy, true);
  assert.equal(failed.notificationsHealthy, false);
  assert.equal(failed.healthy, false);
  assert.match(evaluateWorkerHealth(failed, { now }).reason, /Discord通知の送信が連続/);
  assert.match((await controller.getStatus()).meta.lastError, /Discord通知の送信が連続/);
  assert.equal((await setup.restart().health()).healthy, false);
  failing = false;
  now = setup.storage.alarmTime;
  controller = setup.restart();
  await controller.alarm();
  assert.equal(posts, 3);
  assert.equal((await controller.health()).healthy, true);
  assert.equal((await controller.getStatus()).meta.lastError, null);
});

test('completion freshness cannot be hidden by a future alarm or a stuck running check', async (t) => {
  const { controller, storage } = fixture(t);
  controller.backup = { latest: async () => ({ createdAt: new Date(NOW).toISOString() }) };
  await controller.documents.commit({ control: {
    mode: 'active', lastCompletedAt: new Date(NOW - 16 * 60000).toISOString(),
  }, status: { config: {}, metrics: { activeProducts: 2 } } });
  await storage.setAlarm(NOW + 60000);
  controller.running = true;
  assert.equal((await controller.health()).healthy, false);
  assert.match((await controller.getStatus()).meta.lastError, /16 分完了していません/);
});

test('an entirely paused fleet permits its legitimate discovery wait but still detects stale completion', async (t) => {
  let now = NOW;
  const { controller, storage } = fixture(t, { now: () => now });
  controller.backup = { latest: async () => ({ createdAt: new Date(now).toISOString() }) };
  await controller.documents.commit({ control: {
    mode: 'active', lastCompletedAt: new Date(NOW).toISOString(),
  }, status: { config: { discoveryIntervalHours: 6, pausedRecheckHours: 24 },
    metrics: { activeProducts: 0, pausedProducts: 7 } } });
  await storage.setAlarm(NOW + 6 * 60 * 60000);
  now += 3 * 60 * 60000;
  assert.equal((await controller.health()).healthy, true);
  now = NOW + 366 * 60000;
  await storage.setAlarm(now + 60000);
  assert.equal((await controller.health()).healthy, false);
});
