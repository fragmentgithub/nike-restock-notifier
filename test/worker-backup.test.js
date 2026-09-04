import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorBackup, BackupArchive, BACKUP_POLICY } from '../src/worker-backup.js';

function databaseFor(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE monitor_documents (name TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(name, part));
    CREATE TABLE monitor_sample_blocks (block INTEGER NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(block, part));
    CREATE TABLE monitor_restock_events (style_color TEXT NOT NULL, detected_at INTEGER NOT NULL, PRIMARY KEY(style_color, detected_at)) WITHOUT ROWID;
    CREATE TABLE monitor_product_coverage (style_color TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,PRIMARY KEY(style_color,start_at)) WITHOUT ROWID;
    CREATE TABLE monitor_sellout_episodes (style_color TEXT NOT NULL,started_at INTEGER NOT NULL,restock_lower_at INTEGER,last_in_stock_at INTEGER,ended_at INTEGER,min_duration_ms INTEGER,max_duration_ms INTEGER,censored INTEGER,censor_reason TEXT,PRIMARY KEY(style_color,started_at)) WITHOUT ROWID;
    CREATE TABLE monitor_analysis_cursors (style_color TEXT PRIMARY KEY,last_attempt_at INTEGER,last_reliable_at INTEGER,last_in_stock INTEGER,stock_state TEXT,open_started_at INTEGER,open_lower_at INTEGER,segment_start INTEGER) WITHOUT ROWID;
    CREATE TABLE monitor_analysis_meta (id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER,last_pruned_day INTEGER,reliable_segments INTEGER,excluded_gaps INTEGER);
    CREATE TABLE monitor_analysis_gaps (style_color TEXT NOT NULL,occurred_at INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(style_color,occurred_at)) WITHOUT ROWID;
  `);
  const queries = [];
  const storage = {
    sql: { exec(sql, ...args) {
      queries.push(sql);
      const statement = database.prepare(sql);
      const rows = statement.all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
  };
  return { database, storage, queries };
}

function insertDocument(database, name, value) {
  database.prepare('INSERT OR REPLACE INTO monitor_documents VALUES (?, 0, ?)').run(name, JSON.stringify(value));
}
function document(database, name) {
  const rows = database.prepare('SELECT value FROM monitor_documents WHERE name=? ORDER BY part').all(name);
  return JSON.parse(rows.map((row) => row.value).join(''));
}
function seed(database, { marker = 'backup', mode = 'active' } = {}) {
  insertDocument(database, 'state', { marker, knownProducts: { 'HQ4307-005': { lastStockKey: '26|27' } } });
  insertDocument(database, 'status', { marker, nextCheckAt: '2026-09-06T00:00:00Z', meta: { mode, running: true } });
  insertDocument(database, 'control', { marker, mode });
  insertDocument(database, 'trend-meta', { marker, eventCount: 1 });
  insertDocument(database, 'migration-credential:private', { secret: 'must-never-enter-r2' });
  database.prepare('INSERT INTO monitor_sample_blocks VALUES (?,?,?)').run(0, 0, JSON.stringify([[marker, 0, '{}']]));
  database.prepare('INSERT INTO monitor_restock_events VALUES (?,?)').run('HQ4307-005', 1788566400000);
  database.prepare('INSERT INTO monitor_product_coverage VALUES (?,?,?)').run('HQ4307-005', 1, 2);
  database.prepare('INSERT INTO monitor_sellout_episodes VALUES (?,?,?,?,?,?,?,?,?)').run('HQ4307-005', 3, 4, 5, null, null, null, 0, null);
  database.prepare('INSERT INTO monitor_analysis_cursors VALUES (?,?,?,?,?,?,?,?)').run('HQ4307-005', 7, 8, 5, 'in_stock', 3, 4, 1);
  database.prepare('INSERT INTO monitor_analysis_meta VALUES (?,?,?,?,?)').run(1, 9, 10, 1, 0);
  database.prepare('INSERT INTO monitor_analysis_gaps VALUES (?,?,?)').run('HQ4307-005', 11, 'monitor-paused');
}

test('daily backup preserves all allowlisted state and archives while excluding credentials', async (t) => {
  const { database, storage, queries } = databaseFor(t);
  const target = databaseFor(t);
  const archive = new BackupArchive(target.storage, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  seed(database);
  // More than one query page proves the exporter does not materialize this table at once.
  const insert = database.prepare('INSERT INTO monitor_sample_blocks VALUES (?,0,?)');
  for (let block = 1; block <= 1100; block += 1) insert.run(block, `sample-${block}`);
  const backup = new MonitorBackup(storage, archive, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  const result = await backup.createDaily();
  assert.equal(result.rows, 1111);
  assert.equal((await backup.latest()).generation, result.generation);
  assert.deepEqual((await backup.list(30)).map((item) => item.generation), [result.generation]);
  assert.ok(queries.filter((query) => query.includes('FROM "monitor_sample_blocks"')).length >= 2);
  assert.ok(queries.filter((query) => query.includes('FROM "monitor_sample_blocks"')).every((query) => query.includes('LIMIT ?')));
  const stored = target.database.prepare('SELECT value FROM backup_chunks').all()
    .map(({ value }) => new TextDecoder().decode(value)).join('');
  assert.doesNotMatch(stored, /must-never-enter-r2|migration-credential/);
  assert.deepEqual(BACKUP_POLICY.documentNames, ['state', 'status', 'control', 'trend-meta']);
});

test('restore verifies every chunk then atomically restores long history and forces paused mode', async (t) => {
  const { database, storage } = databaseFor(t);
  const target = databaseFor(t);
  const archive = new BackupArchive(target.storage, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  seed(database);
  const backup = new MonitorBackup(storage, archive, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  const created = await backup.createDaily();
  for (const name of BACKUP_POLICY.tableNames.filter((name) => name !== 'monitor_documents')) database.exec(`DELETE FROM ${name}`);
  insertDocument(database, 'state', { marker: 'current' });
  insertDocument(database, 'status', { marker: 'current', meta: { mode: 'paused' } });
  insertDocument(database, 'control', { marker: 'current', mode: 'paused' });
  insertDocument(database, 'migration-credential:private', { secret: 'current-private-secret' });
  const restored = await backup.restore(created.generation);
  assert.equal(restored.mode, 'paused');
  assert.equal(document(database, 'state').marker, 'backup');
  assert.deepEqual(document(database, 'control'), { marker: 'backup', mode: 'paused' });
  assert.equal(document(database, 'status').meta.mode, 'paused');
  assert.equal(document(database, 'status').meta.running, false);
  assert.equal(document(database, 'status').nextCheckAt, null);
  assert.equal(document(database, 'migration-credential:private').secret, 'current-private-secret');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_restock_events').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_product_coverage').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_sellout_episodes').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_analysis_cursors').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_analysis_meta').get().count, 1);
  const restoredGap = database.prepare('SELECT style_color,occurred_at,reason FROM monitor_analysis_gaps').get();
  assert.equal(restoredGap.style_color, 'HQ4307-005');
  assert.equal(restoredGap.occurred_at, 11);
  assert.equal(restoredGap.reason, 'monitor-paused');
  const restoreAt = Date.parse('2026-09-05T12:00:00Z');
  const boundaryGap = database.prepare("SELECT reason FROM monitor_analysis_gaps WHERE style_color='HQ4307-005' AND occurred_at=?").get(restoreAt);
  assert.equal(boundaryGap.reason, 'restored');
  const restoredEpisode = database.prepare("SELECT ended_at,censored,censor_reason FROM monitor_sellout_episodes WHERE style_color='HQ4307-005'").get();
  assert.equal(restoredEpisode.ended_at, restoreAt);
  assert.equal(restoredEpisode.censored, 1);
  assert.equal(restoredEpisode.censor_reason, 'restored');
  const restoredCursor = database.prepare("SELECT * FROM monitor_analysis_cursors WHERE style_color='HQ4307-005'").get();
  assert.equal(restoredCursor.last_attempt_at, restoreAt);
  for (const field of ['last_reliable_at', 'last_in_stock', 'stock_state', 'open_started_at', 'open_lower_at', 'segment_start']) {
    assert.equal(restoredCursor[field], null, field);
  }
  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name LIKE 'backup_stage_%'").get().count, 0);
});

test('maximum normal SQLite text rows are each backed up and restored in a bounded RPC chunk', async (t) => {
  const { database, storage } = databaseFor(t);
  const target = databaseFor(t);
  const archive = new BackupArchive(target.storage, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  seed(database);
  const rows = [
    `"${'日'.repeat(127998)}"`,
    '👟'.repeat(64000),
    '\u0001'.repeat(128000),
  ];
  const insert = database.prepare('INSERT INTO monitor_sample_blocks VALUES (?,0,?)');
  rows.forEach((value, index) => insert.run(100 + index, value));
  const backup = new MonitorBackup(storage, archive, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  const created = await backup.createDaily();
  const manifest = JSON.parse(new TextDecoder().decode(archive.getManifest(created.generation)));
  const samples = manifest.tables.find((table) => table.name === 'monitor_sample_blocks');
  assert.ok(samples.chunkCount >= rows.length);
  const sizes = target.database.prepare("SELECT length(value) AS bytes FROM backup_chunks WHERE generation=? AND table_name='monitor_sample_blocks'").all(created.generation);
  assert.ok(sizes.every(({ bytes }) => bytes < 1_000_000));
  database.exec('DELETE FROM monitor_sample_blocks');
  insertDocument(database, 'control', { mode: 'paused' });
  await backup.restore(created.generation);
  for (const [index, value] of rows.entries()) {
    assert.equal(database.prepare('SELECT value FROM monitor_sample_blocks WHERE block=?').get(100 + index).value, value);
  }
});

test('corrupt or missing chunks leave the complete current database untouched', async (t) => {
  const { database, storage } = databaseFor(t);
  const target = databaseFor(t);
  const archive = new BackupArchive(target.storage, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  seed(database);
  const backup = new MonitorBackup(storage, archive, { now: () => Date.parse('2026-09-05T12:00:00Z') });
  const created = await backup.createDaily();
  insertDocument(database, 'state', { marker: 'current' });
  insertDocument(database, 'control', { marker: 'current', mode: 'paused' });
  target.database.prepare(`UPDATE backup_chunks SET value=?
    WHERE generation=? AND table_name='monitor_restock_events' AND chunk_index=0`).run(new TextEncoder().encode('[]'), created.generation);
  await assert.rejects(backup.restore(created.generation), /chunk row count failed|integrity check failed/);
  assert.equal(document(database, 'state').marker, 'current');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM monitor_restock_events').get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name LIKE 'backup_stage_%'").get().count, 0);
});

test('backup failures preserve the last successful pointer and active restores are refused', async (t) => {
  const { database, storage } = databaseFor(t);
  const target = databaseFor(t);
  seed(database);
  let timestamp = Date.parse('2026-09-05T12:00:00Z');
  const archive = new BackupArchive(target.storage, { now: () => timestamp });
  const backup = new MonitorBackup(storage, archive, { now: () => timestamp });
  const first = await backup.createDaily();
  const failingArchive = new Proxy(archive, { get(targetArchive, property) {
    if (property === 'publish') return async () => { throw new Error('simulated target failure'); };
    const value = targetArchive[property];
    return typeof value === 'function' ? value.bind(targetArchive) : value;
  } });
  const failingBackup = new MonitorBackup(storage, failingArchive, { now: () => timestamp });
  timestamp += 86400000;
  await assert.rejects(failingBackup.createDaily(), /simulated target failure/);
  assert.equal((await backup.latest()).generation, first.generation);
  await assert.rejects(backup.restore(first.generation), /Pause the monitor/);
  assert.equal(document(database, 'state').marker, 'backup');
});

test('the backup Durable Object publishes and retains only the newest thirty generations', async (t) => {
  const target = databaseFor(t);
  let timestamp = Date.parse('2026-08-01T00:00:00Z');
  const archive = new BackupArchive(target.storage, { now: () => timestamp });
  const generations = [];
  for (let index = 0; index < 31; index += 1) {
    const createdAt = new Date(timestamp).toISOString();
    const generation = `${createdAt.slice(0, 10)}/${createdAt.replace(/[-:.Z]/g, '')}-${crypto.randomUUID()}`;
    const tables = [];
    const contentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('[]'));
    const hex = [...new Uint8Array(contentHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await archive.publish(new TextEncoder().encode(JSON.stringify({
      version: 1, generation, createdAt, totalRows: 0, contentHash: hex, tables,
    })));
    generations.push(generation);
    timestamp += 86400000;
  }
  assert.equal(archive.list(30).length, 30);
  assert.equal(archive.latest().generation, generations.at(-1));
  assert.equal(archive.getManifest(generations[0]), null);
  assert.ok(archive.getManifest(generations[1]));
});
