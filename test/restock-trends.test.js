import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRestockTrends } from '../public/restock-trends.js';

const NOW = Date.parse('2026-09-06T03:00:00.000Z');
const DAY_MS = 86400000;
const FIRST = 'HQ4307-001';
const SECOND = 'HQ4307-200';
const iso = (timestamp) => new Date(timestamp).toISOString();

function transition(at, { styleColor = FIRST, added = ['27'], removed = [], ...extra } = {}) {
  return { at, styleColor, previous: [], current: [...added], added, removed, ...extra };
}

test('twenty-four JST bins handle UTC day rollover and count events rather than sizes', () => {
  const summary = aggregateRestockTrends({ history: [
    transition('2026-09-05T14:59:59.000Z', { added: ['26', '27', '28'] }),
    transition('2026-09-05T15:00:00.000Z'),
    transition('2026-09-05T19:30:00.000Z'),
  ] }, { now: NOW });
  assert.deepEqual(summary.hours.map((item) => item.hour), Array.from({ length: 24 }, (_, hour) => hour));
  assert.equal(summary.hours[23].count, 1);
  assert.equal(summary.hours[0].count, 1);
  assert.equal(summary.hours[4].count, 1);
  assert.equal(summary.totalEvents, 3);
  assert.equal(summary.distinctProducts, 1);
  assert.equal(summary.timezone, 'Asia/Tokyo');
});

test('only recorded increases count; sellouts, checks, notifications and current stock do not', () => {
  const summary = aggregateRestockTrends({
    history: [
      transition('2026-09-05T01:00:00Z', { added: [], removed: ['27'] }),
      transition('2026-09-05T02:00:00Z', { added: ['28'], removed: ['27'], previous: ['27'] }),
      transition('2026-09-05T03:00:00Z', { added: ['29'], previous: [] }),
      { at: '2026-09-05T04:00:00Z', styleColor: FIRST, message: '在庫あり' },
    ],
    events: [{ type: 'check', at: '2026-09-05T05:00:00Z', inStock: true, added: ['27'] },
      { type: 'notify', at: '2026-09-05T06:00:00Z', styleColor: FIRST, added: ['27'] }],
    products: [{ styleColor: FIRST, lastResult: { inStock: true, checkedAt: '2026-09-05T07:00:00Z' } }],
  }, { now: NOW });
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.hours[10].count, 0);
  assert.equal(summary.hours[11].count, 1);
  assert.equal(summary.hours[12].count, 1);
  assert.equal(summary.period.retainedTransitionCount, 3);
});

test('global and per-product histories are unioned without losing older per-product records', () => {
  const duplicate = transition('2026-09-05T19:00:00.000Z');
  const summary = aggregateRestockTrends({
    history: [duplicate, transition('2026-09-05T20:00:00Z', { styleColor: SECOND })],
    products: [{ styleColor: FIRST, stockHistory: [
      duplicate,
      transition('2026-09-06T04:00:00+09:00', { styleColor: 'hq4307-001', added: ['29'] }),
      { at: '2026-07-01T01:00:00Z', added: ['27'] },
    ] }],
  }, { now: NOW });
  assert.equal(summary.totalEvents, 3);
  assert.equal(summary.hours[4].count, 1);
  assert.equal(summary.hours[5].count, 1);
  assert.equal(summary.hours[10].count, 1);
  assert.equal(summary.period.retainedFrom, '2026-07-01T01:00:00.000Z');
  assert.deepEqual(summary.products, [FIRST, SECOND]);
});

test('different products at the same instant remain separate events', () => {
  const at = '2026-09-05T19:00:00Z';
  const summary = aggregateRestockTrends({ history: [
    transition(at), transition(at, { styleColor: SECOND }),
  ] }, { now: NOW });
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.hours[4].count, 2);
  assert.equal(summary.distinctProducts, 2);
});

test('an increasing duplicate is retained even when another copy has an empty added list', () => {
  const at = '2026-09-05T19:00:00Z';
  const summary = aggregateRestockTrends({ history: [transition(at, { added: [] })],
    products: [{ styleColor: FIRST, stockHistory: [transition(at)] }],
  }, { now: NOW });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.period.retainedTransitionCount, 1);
});

test('rolling seven/thirty-day filters include exact boundaries and exclude future rows', () => {
  const source = { history: [
    transition(iso(NOW)),
    transition(iso(NOW + 1)),
    transition(iso(NOW - 7 * DAY_MS)),
    transition(iso(NOW - 7 * DAY_MS - 1)),
    transition(iso(NOW - 30 * DAY_MS)),
    transition(iso(NOW - 30 * DAY_MS - 1)),
  ] };
  const week = aggregateRestockTrends(source, { now: NOW, days: 7 });
  const month = aggregateRestockTrends(source, { now: NOW, days: '30' });
  const all = aggregateRestockTrends(source, { now: NOW, days: 'all' });
  assert.equal(week.totalEvents, 2);
  assert.equal(month.totalEvents, 4);
  assert.equal(all.totalEvents, 5);
  assert.equal(week.period.windowStart, iso(NOW - 7 * DAY_MS));
  assert.equal(week.period.windowEnd, iso(NOW));
  assert.equal(all.period.windowStart, null);
  assert.equal(week.period.retainedFrom, iso(NOW - 30 * DAY_MS - 1));
  assert.equal(week.period.firstEventAt, iso(NOW - 7 * DAY_MS));
  assert.equal(week.period.lastEventAt, iso(NOW));
});

test('product filters also scope retained bounds while leaving all selectable products available', () => {
  const summary = aggregateRestockTrends({ history: [
    transition('2026-07-01T00:00:00Z'),
    transition('2026-09-01T00:00:00Z'),
    transition('2026-09-02T00:00:00Z', { added: [] }),
    transition('2026-08-01T00:00:00Z', { styleColor: SECOND }),
    transition('2026-09-04T00:00:00Z', { styleColor: SECOND }),
  ], products: [{ styleColor: 'IQ8502-001' }] }, { now: NOW, styleColor: ' hq4307-001 ', days: 7 });
  assert.equal(summary.styleColor, FIRST);
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.period.retainedFrom, '2026-07-01T00:00:00.000Z');
  assert.equal(summary.period.retainedTo, '2026-09-02T00:00:00.000Z');
  assert.equal(summary.period.lastEventAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(summary.products, [FIRST, SECOND, 'IQ8502-001']);
});

test('invalid calendar dates, timezone-less dates and malformed records do not affect counts or bounds', () => {
  const invalidDates = ['bad-date', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-09-05T24:00:00Z', '2026-09-05T00:60:00Z',
    '2026-09-05T00:00:00+24:00', '2026-09-05T00:00:00', '2026-09-05', '1', null, 123];
  const summary = aggregateRestockTrends({ history: [
    ...invalidDates.map((at) => transition(at)),
    transition('2024-02-29T00:00:00Z'),
    transition('2026-09-05T19:00:00Z', { styleColor: '' }),
    transition('2026-09-05T19:00:00Z', { styleColor: '[object Object]' }),
    { at: '2026-09-05T19:00:00Z', styleColor: FIRST, added: '27' },
    null,
  ], products: [null, { styleColor: SECOND, stockHistory: 'bad-data' }] }, { now: NOW });
  assert.equal(summary.totalEvents, 1);
  assert.equal(summary.period.retainedFrom, '2024-02-29T00:00:00.000Z');
  assert.equal(summary.period.retainedTo, '2024-02-29T00:00:00.000Z');
});

test('missing data and filters without records yield a complete zero chart and honest coverage notes', () => {
  for (const source of [undefined, null, {}, { history: 'bad-data', products: {} }]) {
    const summary = aggregateRestockTrends(source, { now: NOW });
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.hours.length, 24);
    assert.ok(summary.hours.every((item) => item.count === 0));
    assert.equal(summary.period.retainedFrom, null);
    assert.equal(summary.period.firstEventAt, null);
    assert.equal(summary.notes.timestampBasis, 'detected');
    assert.equal(summary.notes.retentionLimited, true);
    assert.deepEqual(summary.notes.sourceLimits, { globalHistory: 300, perProductHistory: 60 });
  }
  const filtered = aggregateRestockTrends({ history: [transition('2026-09-05T19:00:00Z')] }, {
    now: NOW, styleColor: SECOND,
  });
  assert.equal(filtered.totalEvents, 0);
  assert.equal(filtered.period.retainedFrom, null);
});

test('the aggregation is pure and cannot change imported monitoring or notification state', () => {
  const source = { history: [transition('2026-09-05T19:00:00Z')], products: [{
    styleColor: FIRST, lastStockKey: '27', stockHistory: [transition('2026-09-05T19:00:00Z')],
  }] };
  const before = structuredClone(source);
  const first = aggregateRestockTrends(source, { now: NOW });
  first.hours[4].count = 99;
  first.notes.sourceLimits.globalHistory = 1;
  assert.deepEqual(source, before);
  const second = aggregateRestockTrends(source, { now: NOW });
  assert.equal(second.hours[4].count, 1);
  assert.equal(second.notes.sourceLimits.globalHistory, 300);
});
