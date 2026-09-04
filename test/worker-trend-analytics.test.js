import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MonitorStorage } from '../src/worker-storage.js';

const FIRST = 'HQ4307-001';
const SECOND = 'HQ4307-200';
const MINUTE = 60000;
const DAY = 86400000;

function fixture(t, initialNow = Date.parse('2026-09-06T14:30:00Z')) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  let now = initialNow;
  const storage = {
    sql: { exec(sql, ...args) { const rows = database.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
  };
  const options = { now: () => now };
  return {
    database, storage, options, documents: new MonitorStorage(storage, options),
    setNow: (at) => { now = at; },
  };
}

function setVerifiedFrom(documents, database, at) {
  const metadata = documents.archiveMetadata();
  metadata.verifiedFrom = new Date(at).toISOString();
  database.prepare("UPDATE monitor_documents SET value = ? WHERE name = 'trend-meta' AND part = 0")
    .run(JSON.stringify(metadata));
}

const observation = (styleColor, observedAt, availability, extra = {}) => ({
  styleColor, observedAt: new Date(observedAt).toISOString(), availability,
  expectedIntervalSeconds: 120, ...extra,
});
const event = (styleColor, at) => ({
  styleColor, at: new Date(at).toISOString(), previous: [], current: ['27'], added: ['27'], removed: [],
});

test('coverage splits exactly across JST weekday/hour cells and uses 100 product-hours', async (t) => {
  // Sunday 23:30 JST through Monday 00:30 JST.
  const start = Date.parse('2026-09-06T14:30:00Z');
  const end = start + 60 * MINUTE;
  const { documents, setNow } = fixture(t, start);
  await documents.commit({ state: { history: [] } }, {
    observation: observation(FIRST, start, 'out_of_stock', { expectedIntervalSeconds: 1800 }),
  });
  setNow(end);
  await documents.commit({ state: { history: [event(FIRST, end)] } }, {
    observation: observation(FIRST, end, 'in_stock', { expectedIntervalSeconds: 1800, restockDetected: true }),
  });
  const analytics = documents.getTrends({ days: 7 }).analytics;
  assert.equal(analytics.coverage.observedProductHours, 1);
  const sunday = analytics.weekdayHours.cells.find((cell) => cell.weekday === 0 && cell.hour === 23);
  const monday = analytics.weekdayHours.cells.find((cell) => cell.weekday === 1 && cell.hour === 0);
  assert.equal(sunday.observedProductHours, 0.5);
  assert.equal(sunday.restockEvents, 0);
  assert.equal(sunday.ratePer100ProductHours, 0);
  assert.equal(monday.observedProductHours, 0.5);
  assert.equal(monday.restockEvents, 1);
  assert.equal(monday.ratePer100ProductHours, 200);
  assert.equal(analytics.weekdayHours.cells.length, 168);
});

test('coverage aggregation handles whole JST weeks without changing weekday/hour totals', (t) => {
  const start = Date.parse('2026-09-05T15:00:00Z'); // Sunday 00:00 JST.
  const now = start + 8 * DAY;
  const { documents, database } = fixture(t, now);
  documents.getTrends();
  database.prepare('UPDATE monitor_analysis_meta SET started_at = ? WHERE id = 1').run(start);
  setVerifiedFrom(documents, database, start);
  database.prepare('INSERT INTO monitor_product_coverage VALUES (?, ?, ?)').run(FIRST, start, now);
  const analytics = documents.getTrends({ styleColor: FIRST, days: 30 }).analytics;
  assert.equal(analytics.coverage.observedProductHours, 192);
  for (const cell of analytics.weekdayHours.cells) {
    assert.equal(cell.observedProductHours, cell.weekday === 0 ? 2 : 1);
    assert.equal(cell.ratePer100ProductHours, 0);
  }
});

test('failures and long gaps break coverage instead of being counted as monitored time', async (t) => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  const { documents, setNow } = fixture(t, start);
  const save = async (minutes, availability) => {
    const at = start + minutes * MINUTE;
    setNow(at);
    await documents.commit({ state: { history: [] } }, { observation: observation(FIRST, at, availability) });
  };
  await save(0, 'out_of_stock');
  await save(2, 'out_of_stock'); // two reliable minutes
  await save(4, 'unavailable'); // preceding/following uncertain spans excluded
  await save(6, 'out_of_stock');
  await save(8, 'out_of_stock'); // two more reliable minutes
  await save(20, 'out_of_stock'); // 12-minute gap exceeds the 6-minute bound
  await save(22, 'out_of_stock'); // resumes with a two-minute segment
  const coverage = documents.getTrends({ days: 7 }).analytics.coverage;
  assert.equal(coverage.observedProductHours, 0.1);
  assert.equal(coverage.reliableSegments, 3);
  assert.equal(coverage.excludedGaps, 2);
});

test('excluded gap counts honor both product and rolling-period filters', (t) => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const { documents, database } = fixture(t, now);
  documents.getTrends();
  setVerifiedFrom(documents, database, now - 8 * DAY);
  database.prepare('UPDATE monitor_analysis_meta SET started_at = ? WHERE id = 1').run(now - 8 * DAY);
  const insert = database.prepare('INSERT INTO monitor_analysis_gaps VALUES (?, ?, ?)');
  insert.run(FIRST, now - 8 * DAY, 'unavailable');
  insert.run(FIRST, now - DAY, 'long_gap');
  insert.run(SECOND, now - DAY, 'unavailable');
  assert.equal(documents.getTrends({ styleColor: FIRST, days: 7 }).analytics.coverage.excludedGaps, 1);
  assert.equal(documents.getTrends({ styleColor: FIRST, days: 'all' }).analytics.coverage.excludedGaps, 2);
  assert.equal(documents.getTrends({ styleColor: 'all', days: 7 }).analytics.coverage.excludedGaps, 2);
});

test('sell-out duration carries observation bounds and excludes censored episodes', async (t) => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  const { documents, setNow } = fixture(t, start);
  let history = [];
  async function save(minutes, availability, restockDetected = false) {
    const at = start + minutes * MINUTE;
    setNow(at);
    if (restockDetected) history = [event(FIRST, at), ...history];
    await documents.commit({ state: { history } }, {
      observation: observation(FIRST, at, availability, { restockDetected }),
    });
  }
  await save(0, 'in_stock', true); // no prior observation: left-censored, excluded
  await save(2, 'out_of_stock');
  await save(4, 'in_stock', true);
  await save(6, 'in_stock');
  await save(8, 'out_of_stock');
  await save(10, 'in_stock', true);
  await save(12, 'unavailable');
  const sellout = documents.getTrends({ days: 7 }).analytics.sellout;
  assert.equal(sellout.sampleCount, 1);
  assert.equal(sellout.censoredCount, 1);
  assert.equal(sellout.medianMinutes, 4);
  assert.equal(sellout.p25Minutes, 4);
  assert.equal(sellout.p75Minutes, 4);
  assert.equal(sellout.medianLowerMinutes, 2);
  assert.equal(sellout.medianUpperMinutes, 6);
});

test('pause/import boundaries censor open episodes and prevent coverage joining across them', async (t) => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  const { documents, setNow } = fixture(t, start);
  await documents.commit({ state: { history: [] } }, {
    observation: observation(FIRST, start, 'out_of_stock'),
  });
  setNow(start + 2 * MINUTE);
  await documents.commit({ state: { history: [event(FIRST, start + 2 * MINUTE)] } }, {
    observation: observation(FIRST, start + 2 * MINUTE, 'in_stock', { restockDetected: true }),
  });
  setNow(start + 3 * MINUTE);
  await documents.commit({ control: { mode: 'paused' } }, {
    analyticsBoundary: { at: new Date(start + 3 * MINUTE).toISOString(), reason: 'paused' },
  });
  setNow(start + 4 * MINUTE);
  await documents.commit({ state: { history: [] } }, {
    observation: observation(FIRST, start + 4 * MINUTE, 'in_stock'),
  });
  setNow(start + 6 * MINUTE);
  await documents.commit({ state: { history: [] } }, {
    observation: observation(FIRST, start + 6 * MINUTE, 'in_stock'),
  });
  const analytics = documents.getTrends({ days: 7 }).analytics;
  assert.equal(analytics.sellout.sampleCount, 0);
  assert.equal(analytics.sellout.censoredCount, 1);
  assert.equal(analytics.coverage.observedProductHours, 0.067);
});

test('comparison uses equal disjoint 30-day periods and refuses small samples', (t) => {
  const now = Date.parse('2026-09-06T00:00:00Z');
  const { documents, database } = fixture(t, now);
  documents.getTrends();
  const split = now - 30 * DAY;
  const beginning = now - 60 * DAY;
  database.prepare('UPDATE monitor_analysis_meta SET started_at = ? WHERE id = 1').run(beginning);
  setVerifiedFrom(documents, database, beginning);
  database.prepare('INSERT INTO monitor_product_coverage VALUES (?, ?, ?)').run(FIRST, beginning, now);
  for (const at of [beginning, beginning + DAY, split - 1, split, split + DAY, split + 2 * DAY,
    split + 3 * DAY, split + 4 * DAY, split + 5 * DAY]) {
    database.prepare('INSERT INTO monitor_restock_events VALUES (?, ?)').run(FIRST, at);
    database.prepare(`INSERT INTO monitor_sellout_episodes
      (style_color, started_at, restock_lower_at, last_in_stock_at) VALUES (?, ?, ?, ?)`)
      .run(FIRST, at, at - 1, at);
  }
  const comparison = documents.getTrends({ styleColor: FIRST, days: 7 }).analytics.comparison;
  assert.equal(comparison.previous.events, 3);
  assert.equal(comparison.current.events, 6);
  assert.equal(comparison.previous.observedProductHours, 720);
  assert.equal(comparison.current.observedProductHours, 720);
  assert.equal(comparison.status, 'up');
  assert.equal(comparison.changePercent, 100);
  assert.deepEqual(comparison.minSampleRequired, { eventsPerPeriod: 3, observedProductHoursPerPeriod: 24 });

  const other = documents.getTrends({ styleColor: SECOND, days: 7 }).analytics.comparison;
  assert.equal(other.previous.observedProductHours, null);
  assert.equal(other.current.ratePer100ProductHours, null);
  assert.equal(other.status, 'insufficient');
  assert.equal(other.changePercent, null);
});

test('legacy restocks remain in the archive but do not become analytics numerator, coverage or duration', (t) => {
  const now = Date.parse('2026-09-06T00:00:00Z');
  const { documents } = fixture(t, now);
  documents.write({ state: { history: [event(FIRST, now - DAY)] } }, { initializeAnalytics: true });
  const analytics = documents.getTrends({ days: 7 }).analytics;
  assert.equal(analytics.coverage.recordingStartedAt, new Date(now).toISOString());
  assert.equal(analytics.coverage.observedProductHours, null);
  assert.equal(documents.getTrends({ days: 7 }).totalEvents, 1);
  assert.equal(analytics.weekdayHours.cells.reduce((total, cell) => total + cell.restockEvents, 0), 0);
  assert.ok(analytics.weekdayHours.cells.every((cell) =>
    cell.observedProductHours === null && cell.ratePer100ProductHours === null));
  assert.equal(analytics.sellout.sampleCount, 0);
  assert.equal(analytics.sellout.medianMinutes, null);
  assert.equal(analytics.comparison.status, 'insufficient');
});

test('an imported history after analytics initialization stays out of the observation-rate numerator', async (t) => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  const { documents, setNow } = fixture(t, start);
  documents.getTrends();

  const importedAt = start + 60 * MINUTE;
  setNow(start + 2 * 60 * MINUTE);
  const imported = event(FIRST, importedAt);
  await documents.commit({ state: { history: [imported] } }, {
    analyticsBoundary: { at: new Date(start + 2 * 60 * MINUTE).toISOString(), reason: 'imported' },
  });

  let summary = documents.getTrends({ styleColor: FIRST, days: 7 });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.analytics.weekdayHours.cells.reduce((total, cell) => total + cell.restockEvents, 0), 0);
  assert.equal(summary.analytics.comparison.current.events, 0);

  const observedOut = start + 3 * 60 * MINUTE;
  setNow(observedOut);
  await documents.commit({ state: { history: [imported] } }, {
    observation: observation(FIRST, observedOut, 'out_of_stock'),
  });
  const observedRestock = start + 3 * 60 * MINUTE + 2 * MINUTE;
  setNow(observedRestock);
  await documents.commit({ state: { history: [event(FIRST, observedRestock), imported] } }, {
    observation: observation(FIRST, observedRestock, 'in_stock', { restockDetected: true }),
  });

  summary = documents.getTrends({ styleColor: FIRST, days: 7 });
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.analytics.weekdayHours.cells.reduce((total, cell) => total + cell.restockEvents, 0), 1);
  assert.equal(summary.analytics.comparison.current.events, 1);
});

test('analytics applies the same whitespace and case normalization as the archive filter', async (t) => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  const { documents, setNow } = fixture(t, start);
  await documents.commit({ state: { history: [] } }, {
    observation: observation(FIRST, start, 'out_of_stock'),
  });
  setNow(start + 2 * MINUTE);
  await documents.commit({ state: { history: [event(FIRST, start + 2 * MINUTE)] } }, {
    observation: observation(FIRST, start + 2 * MINUTE, 'in_stock', { restockDetected: true }),
  });

  const exact = documents.getTrends({ styleColor: FIRST, days: 7 });
  const padded = documents.getTrends({ styleColor: ` ${FIRST.toLowerCase()} `, days: 7 });
  const upperAll = documents.getTrends({ styleColor: 'ALL', days: 7 });
  assert.equal(padded.styleColor, FIRST);
  assert.deepEqual(padded.analytics, exact.analytics);
  assert.deepEqual(upperAll.analytics, documents.getTrends({ styleColor: 'all', days: 7 }).analytics);
});

test('the evidence boundary excludes old episodes, coverage and gaps from every analysis', (t) => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const boundary = now - DAY;
  const { documents, database } = fixture(t, now);
  documents.getTrends();
  setVerifiedFrom(documents, database, boundary);
  database.prepare('UPDATE monitor_analysis_meta SET started_at = ? WHERE id = 1').run(now - 3 * DAY);
  database.prepare('INSERT INTO monitor_product_coverage VALUES (?, ?, ?)').run(FIRST, now - 2 * DAY, boundary - 1);
  database.prepare('INSERT INTO monitor_product_coverage VALUES (?, ?, ?)').run(FIRST, boundary, now);
  database.prepare('INSERT INTO monitor_analysis_gaps VALUES (?, ?, ?)').run(FIRST, now - 2 * DAY, 'old');
  database.prepare('INSERT INTO monitor_analysis_gaps VALUES (?, ?, ?)').run(FIRST, boundary, 'new');
  const insertEpisode = database.prepare(`INSERT INTO monitor_sellout_episodes
    (style_color, started_at, restock_lower_at, last_in_stock_at, ended_at,
     min_duration_ms, max_duration_ms, censored) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  insertEpisode.run(FIRST, now - 2 * DAY, now - 2 * DAY, now - 2 * DAY, now - 2 * DAY + MINUTE, MINUTE, MINUTE);
  insertEpisode.run(FIRST, boundary + MINUTE, boundary, boundary + MINUTE, boundary + 2 * MINUTE, MINUTE, MINUTE);

  const analytics = documents.getTrends({ styleColor: FIRST, days: 7 }).analytics;
  assert.equal(analytics.coverage.recordingStartedAt, new Date(boundary).toISOString());
  assert.equal(analytics.coverage.observedProductHours, 24);
  assert.equal(analytics.coverage.reliableSegments, 1);
  assert.equal(analytics.coverage.excludedGaps, 1);
  assert.equal(analytics.weekdayHours.cells.reduce((sum, cell) => sum + cell.restockEvents, 0), 1);
  assert.equal(analytics.sellout.sampleCount, 1);
  assert.equal(analytics.sellout.medianMinutes, 1);
  assert.equal(analytics.comparison.current.events, 1);
  assert.equal(analytics.comparison.previous.events, 0);
});

test('analytics and state roll back atomically, while duplicate/invalid observations are harmless', async (t) => {
  const now = Date.parse('2026-09-06T00:00:00Z');
  const { documents, storage, options, database } = fixture(t, now);
  await documents.commit({ state: { version: 1 }, status: { version: 1 } }, {
    observation: observation(FIRST, now - 2 * MINUTE, 'out_of_stock'),
  });
  const exec = storage.sql.exec;
  storage.sql.exec = (sql, ...args) => {
    if (sql.startsWith('INSERT INTO monitor_documents') && args[0] === 'status') throw new Error('disk failure');
    return exec(sql, ...args);
  };
  const option = { observation: observation(FIRST, now, 'out_of_stock') };
  await assert.rejects(documents.commit({ state: { version: 2 }, status: { version: 2 } }, option), /disk failure/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM monitor_product_coverage').get().count, 0);
  assert.deepEqual(documents.read('state'), { version: 1 });
  storage.sql.exec = exec;
  await documents.commit({ state: { version: 2 }, status: { version: 2 } }, option);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM monitor_product_coverage').get().count, 1);
  const cold = new MonitorStorage(storage, options);
  await cold.commit({ state: { version: 2 } }, option);
  await cold.commit({ state: { version: 3 } }, {
    observation: { ...option.observation, observedAt: 'invalid' },
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM monitor_product_coverage').get().count, 1);
  assert.deepEqual(cold.read('state'), { version: 3 });
});
