import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorController } from '../src/worker-monitor.js';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function fixture(t, { engineFactory, now = () => NOW } = {}) {
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
  const controller = new MonitorController({ storage }, {}, { engineFactory, now });
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
