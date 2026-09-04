import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorStorage } from '../src/worker-storage.js';

function storageFor(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  return {
    sql: { exec(query, ...args) { return { toArray: () => database.prepare(query).all(...args) }; } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
  };
}

// CREATE and writes execute immediately, as they do in the Durable Object SQL API.
function durableStorageFor(t) {
  const storage = storageFor(t);
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    const rows = exec(query, ...args).toArray();
    return { toArray: () => rows };
  };
  return storage;
}

test('large legacy state survives SQLite persistence, including full samples and emoji chunk boundaries', async (t) => {
  const storage = durableStorageFor(t);
  const documents = new MonitorStorage(storage);
  const state = {
    knownProducts: { 'HQ4307-005': { lastStockKey: '26.0,27.0' } },
    checkSamples: Array.from({ length: 10000 }, (_, i) => ({
      at: '2026-09-04T00:00:00.000Z', styleColor: 'HQ4307-005', ok: i % 3 !== 0, durationMs: i,
    })),
    events: Array.from({ length: 80 }, (_, i) => ({ message: `イベント ${i} 👟` })),
    history: Array.from({ length: 300 }, (_, i) => ({ id: i, message: '在庫変更' })),
    unicodeBoundary: 'a'.repeat(15997) + '👟'.repeat(40000),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 131072);
  await documents.commit({ state, status: { updatedAt: '2026-09-04T00:00:00.000Z' } });
  assert.deepEqual(new MonitorStorage(storage).read('state'), state);
  const chunks = storage.sql.exec('SELECT value FROM monitor_documents WHERE name = ?', 'state').toArray();
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every(({ value }) => Buffer.byteLength(value) < 512000));
  assert.ok(storage.sql.exec('SELECT COUNT(*) AS count FROM monitor_sample_blocks').toArray()[0].count <= 80);
  await documents.commit({ state: { checkSamples: [] } });
  assert.deepEqual(documents.read('state'), { checkSamples: [] });
});

test('shifting a full sample ring writes two blocks and a cold load reads at most 80 blocks', async (t) => {
  const storage = durableStorageFor(t);
  const documents = new MonitorStorage(storage);
  const samples = Array.from({ length: 10000 }, (_, i) => ({
    at: new Date(1788480000000 + i * 1000).toISOString(), styleColor: 'HQ4307-005', ok: true,
  }));
  await documents.commit({ state: { checkSamples: samples } });
  let inserts = 0;
  let deletes = 0;
  let sampleReads = 0;
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT INTO monitor_sample_blocks')) inserts++;
    if (query.startsWith('DELETE FROM monitor_sample_blocks')) deletes++;
    if (query.startsWith('SELECT') && query.includes('FROM monitor_sample_blocks')) sampleReads++;
    return exec(query, ...args);
  };
  const next = [...samples.slice(1), { at: '2026-09-04T08:00:00.000Z', styleColor: 'HQ4307-005', ok: true }];
  await documents.commit({ state: { checkSamples: next } });
  assert.equal(inserts, 2);
  assert.equal(deletes, 0);
  assert.equal(sampleReads, 0);
  assert.deepEqual(documents.read('state').checkSamples, next);
  assert.deepEqual(new MonitorStorage(storage).read('state').checkSamples, next);
  assert.ok(storage.sql.exec('SELECT COUNT(*) AS count FROM monitor_sample_blocks').toArray()[0].count <= 80);
});

test('sample order and duplicates survive an import that reorders existing records', async (t) => {
  const storage = durableStorageFor(t);
  const documents = new MonitorStorage(storage);
  await documents.commit({ state: { checkSamples: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
  const reordered = [{ id: 2 }, { id: 3 }, { id: 1 }, { id: 1 }];
  await documents.commit({ state: { checkSamples: reordered } });
  assert.deepEqual(new MonitorStorage(storage).read('state').checkSamples, reordered);
});

test('state and public status roll back together if SQLite rejects a write', async (t) => {
  const storage = durableStorageFor(t);
  const documents = new MonitorStorage(storage);
  await documents.commit({ state: { version: 1 }, status: { version: 1 } });
  const exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith('INSERT') && args[0] === 'status') throw new Error('disk failure');
    return exec(query, ...args);
  };
  await assert.rejects(documents.commit({ state: { version: 2 }, status: { version: 2 } }), /disk failure/);
  assert.deepEqual(documents.read('state'), { version: 1 });
  assert.deepEqual(documents.read('status'), { version: 1 });
});

test('persistence does not resolve until writes are confirmed durable', async (t) => {
  const storage = durableStorageFor(t);
  const gate = Promise.withResolvers();
  storage.sync = () => gate.promise;
  const documents = new MonitorStorage(storage);
  let resolved = false;
  const commit = documents.commit({ state: { pendingNotification: true } }).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  gate.resolve();
  await commit;
  assert.equal(resolved, true);
});
