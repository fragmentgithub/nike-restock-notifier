import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorStorage } from '../src/worker-storage.js';

const NOW = Date.parse('2026-09-06T06:00:00.000Z');
const DAY_MS = 86400000;
const FIRST = 'HQ4307-001';
const SECOND = 'HQ4307-200';
const iso = (at) => new Date(at).toISOString();
const event = (at, styleColor = FIRST, added = ['27']) => ({ at: typeof at === 'number' ? iso(at) : at, styleColor, added });

function fixture(t, legacyState) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  let now = NOW;
  const queries = [];
  const storage = {
    sql: { exec(query, ...args) {
      queries.push(query);
      const rows = database.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
  };
  if (legacyState) {
    database.exec('CREATE TABLE monitor_documents (name TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (name, part))');
    database.prepare('INSERT INTO monitor_documents VALUES (?, ?, ?)').run('state', 0, JSON.stringify(legacyState));
  }
  const options = { now: () => now };
  return {
    storage, queries, database, options,
    documents: new MonitorStorage(storage, options),
    setNow: (value) => { now = value; },
    rowCount: () => database.prepare('SELECT COUNT(*) AS count FROM monitor_restock_events').get().count,
  };
}

test('first trend read backfills both legacy histories, deduplicates instants and groups by JST', (t) => {
  const legacy = {
    lastStockKey: 'already-notified', checkSamples: { storage: 'cloudflare-samples-v1' },
    history: [event('2026-09-05T14:59:59Z'), event('2026-09-05T15:00:00Z')],
    knownProducts: {
      [FIRST]: { styleColor: FIRST, lastStockKey: 'already-notified', stockHistory: [
        event('2026-09-06T00:00:00+09:00', 'hq4307-001', ['28', '29']),
        { at: '2026-09-05T19:30:00Z', added: ['27'] },
      ] },
      [SECOND]: { stockHistory: [] },
    },
  };
  const { documents, queries, rowCount, database } = fixture(t, legacy);
  const summary = documents.getTrends();
  assert.equal(summary.totalEvents, 3);
  assert.equal(rowCount(), 3);
  assert.equal(summary.hours[23].count, 1);
  assert.equal(summary.hours[0].count, 1);
  assert.equal(summary.hours[4].count, 1);
  assert.equal(summary.hours.reduce((count, bin) => count + bin.count, 0), 3);
  assert.equal(summary.distinctProducts, 1);
  assert.deepEqual(summary.products, [FIRST, SECOND]);
  assert.equal(summary.period.archiveStartedAt, iso(NOW));
  assert.equal(summary.notes.archiveStartedAt, iso(NOW));
  assert.equal(summary.notes.legacyHistoryPartial, true);
  assert.equal(summary.notes.capacityLimited, false);
  assert.match(summary.notes.retentionLabel, /2026-09-06.*730日.*一部/);
  assert.deepEqual(JSON.parse(database.prepare("SELECT value FROM monitor_documents WHERE name = 'state'").get().value), legacy);
  assert.equal(queries.filter((sql) => sql.startsWith('SELECT') && sql.includes('monitor_sample_blocks')).length, 0);
});

test('rolling 7/30/90/365/730-day windows include boundaries and preserve archive bounds', async (t) => {
  const { documents } = fixture(t);
  const timestamps = [NOW, ...[7, 30, 90, 365, 730].flatMap((days) => [NOW - days * DAY_MS, NOW - days * DAY_MS - 1])];
  await documents.commit({ state: { history: timestamps.map((at) => event(at)) } });
  for (const days of [7, 30, 90, 365, 730]) {
    const summary = documents.getTrends({ days: String(days) });
    assert.equal(summary.period.days, days);
    assert.equal(summary.totalEvents, timestamps.filter((at) => at >= NOW - days * DAY_MS).length);
    assert.equal(summary.period.windowStart, iso(NOW - days * DAY_MS));
    assert.equal(summary.period.windowEnd, iso(NOW));
    assert.equal(summary.period.retainedFrom, iso(NOW - 730 * DAY_MS));
    assert.equal(summary.period.firstEventAt, iso(NOW - days * DAY_MS));
  }
  const all = documents.getTrends({ days: 'all' });
  assert.equal(all.period.windowStart, null);
  assert.equal(all.totalEvents, 10);
  assert.equal(all.notes.retentionDays, 730);
});

test('only valid observed increases count, including mixed changes but no checks or notifications', async (t) => {
  const { documents } = fixture(t);
  await documents.commit({ state: {
    history: [
      event(NOW - 1000), { ...event(NOW - 2000, SECOND), removed: ['26'] },
      event(NOW - 3000, FIRST, []), event(NOW - 4000, FIRST, [' ', null]),
      event(NOW + 1), event('2026-02-30T00:00:00Z'), event('2026-09-05T00:00:00'),
      event(NOW - 5000, '[object Object]'), event('invalid'),
    ],
    events: [{ ...event(NOW - 6000), type: 'notify' }, { ...event(NOW - 7000), type: 'check' }],
    knownProducts: { [FIRST]: { lastResult: { inStock: true } } },
  } });
  const summary = documents.getTrends();
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.distinctProducts, 2);
  const filtered = documents.getTrends({ styleColor: ' hq4307-001 ' });
  assert.equal(filtered.styleColor, FIRST);
  assert.equal(filtered.totalEvents, 1);
  assert.equal(filtered.period.retainedFrom, iso(NOW - 1000));
  assert.deepEqual(filtered.products, [FIRST, SECOND]);
  assert.throws(() => documents.getTrends({ styleColor: 'invalid' }), RangeError);
  assert.throws(() => documents.getTrends({ days: 8 }), RangeError);
});

test('unchanged warm and cold saves issue no archive inserts and new detections are inserted once', async (t) => {
  const { documents, storage, options, queries, rowCount } = fixture(t);
  const state = { history: [event(NOW - 1000)] };
  await documents.commit({ state });
  queries.length = 0;
  await documents.commit({ state });
  const cold = new MonitorStorage(storage, options);
  await cold.commit({ state });
  assert.equal(queries.filter((sql) => sql.startsWith('INSERT OR IGNORE INTO monitor_restock_events')).length, 0);
  assert.equal(queries.filter((sql) => sql.startsWith('SELECT') && sql.includes('FROM monitor_restock_events')).length, 0);
  const next = { history: [event(NOW), ...state.history], knownProducts: { [FIRST]: { stockHistory: [event(NOW)] } } };
  queries.length = 0;
  await cold.commit({ state: next });
  assert.equal(queries.filter((sql) => sql.startsWith('INSERT OR IGNORE INTO monitor_restock_events')).length, 1);
  assert.equal(rowCount(), 2);
});

test('short history rollover and ordinary state replacement never delete archived detections', async (t) => {
  const { documents, storage, options } = fixture(t);
  await documents.commit({ state: { history: [event(NOW - 1000)], lastStockKey: 'notified' } });
  const started = documents.getTrends().period.archiveStartedAt;
  await documents.commit({ state: { history: [event(NOW)], lastStockKey: 'next-key' } });
  await documents.commit({ state: { history: [], knownProducts: {} } });
  const summary = new MonitorStorage(storage, options).getTrends();
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.period.archiveStartedAt, started);
  assert.deepEqual(summary.products, [FIRST]);
});

test('the first state replacement backfills the previous legacy document before saving the new state', async (t) => {
  const { documents } = fixture(t, { history: [event(NOW - 1000)] });
  await documents.commit({ state: { history: [event(NOW, SECOND)], lastStockKey: 'new-notification-key' } });
  const summary = documents.getTrends();
  assert.equal(summary.totalEvents, 2);
  assert.deepEqual(summary.products, [FIRST, SECOND]);
  assert.equal(documents.read('state').lastStockKey, 'new-notification-key');
});

test('state, event archive and checkpoint all roll back together and retry without duplicates', async (t) => {
  const { documents, storage, options, rowCount } = fixture(t);
  await documents.commit({ state: { history: [event(NOW - 1000)] }, status: { version: 1 } });
  const exec = storage.sql.exec;
  storage.sql.exec = (sql, ...args) => {
    if (sql.startsWith('INSERT INTO monitor_documents') && args[0] === 'status') throw new Error('disk failure');
    return exec(sql, ...args);
  };
  const next = { state: { history: [event(NOW), event(NOW - 1000)] }, status: { version: 2 } };
  await assert.rejects(documents.commit(next), /disk failure/);
  assert.equal(rowCount(), 1);
  assert.equal(documents.read('state').history.length, 1);
  assert.equal(documents.getTrends().totalEvents, 1);
  assert.equal(new MonitorStorage(storage, options).getTrends().totalEvents, 1);
  storage.sql.exec = exec;
  await documents.commit(next);
  assert.equal(documents.getTrends().totalEvents, 2);
  assert.equal(new MonitorStorage(storage, options).getTrends().totalEvents, 2);
});

test('expiry is enforced in queries continuously but physically pruned only once per JST day', async (t) => {
  const { documents, queries, setNow, rowCount } = fixture(t);
  const state = { history: [event(NOW - 730 * DAY_MS)] };
  await documents.commit({ state });
  assert.equal(documents.getTrends().totalEvents, 1);
  queries.length = 0;
  setNow(NOW + 1);
  assert.equal(documents.getTrends().totalEvents, 0);
  await documents.commit({ state });
  assert.equal(rowCount(), 1);
  assert.equal(queries.filter((sql) => sql.startsWith('DELETE FROM monitor_restock_events')).length, 0);
  setNow(NOW + DAY_MS);
  assert.equal(documents.getTrends().totalEvents, 0);
  documents.getTrends();
  assert.equal(rowCount(), 0);
  assert.equal(queries.filter((sql) => sql.startsWith('DELETE FROM monitor_restock_events')).length, 1);
});

test('the bounded product selector does not truncate all-product event counts', async (t) => {
  const { documents } = fixture(t);
  const history = Array.from({ length: 1005 }, (_, index) => event(NOW, `AA${String(index).padStart(4, '0')}-001`));
  await documents.commit({ state: { history } });
  const summary = documents.getTrends();
  assert.equal(summary.totalEvents, 1005);
  assert.equal(summary.distinctProducts, 1005);
  assert.equal(summary.products.length, 1000);
  assert.equal(summary.notes.productsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 65536);
});

test('one million retained events enforce the capacity bound by evicting only the oldest detection', async (t) => {
  const { documents, storage, options, database, rowCount } = fixture(t);
  documents.getTrends();
  // Seed a realistically full archive directly in SQLite, without a million-item
  // JavaScript state or imported history (the normal short ring remains small).
  database.prepare(`WITH RECURSIVE sequence(value) AS
    (VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000000)
    INSERT INTO monitor_restock_events (style_color, detected_at)
    SELECT ?, ? - value FROM sequence`).run(FIRST, NOW);
  const metadata = documents.read('trend-meta');
  metadata.eventCount = 1000000;
  database.prepare("UPDATE monitor_documents SET value = ? WHERE name = 'trend-meta'").run(JSON.stringify(metadata));
  const cold = new MonitorStorage(storage, options);
  await cold.commit({ state: { history: [event(NOW)] } });
  assert.equal(rowCount(), 1000000);
  const bounds = database.prepare('SELECT MIN(detected_at) AS first, MAX(detected_at) AS last FROM monitor_restock_events').get();
  assert.equal(bounds.first, NOW - 999999);
  assert.equal(bounds.last, NOW);
  const summary = cold.getTrends();
  assert.equal(summary.totalEvents, 1000000);
  assert.equal(summary.notes.capacityLimited, true);
  assert.match(summary.notes.retentionLabel, /上限に達した/);
});
