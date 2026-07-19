import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuntimeFailure,
  computeQualityMetrics,
  formatStockLabels,
  hasRecentSuccessForOtherProduct,
  isUpcomingPriority,
  millisecondsUntilProductDue,
  parseProductConfig,
  parseProductConfigSafely,
  recordStockTransition,
  settingsForProduct,
  shouldChainNextRun,
  shouldCheckProductNow,
  updateDelistState,
  updateCatalogPresence,
  updateUpcomingState,
} from '../src/monitor-policy.js';

test('商品別サイズ・通知・メンション設定を正規化する', () => {
  const parsed = parseProductConfig(JSON.stringify({
    'hq4307-005': { sizes: ['27', '28'], notify: false, mention: '<@&12345>' },
  }));
  assert.deepEqual(settingsForProduct(parsed, 'HQ4307-005', '26', ''), {
    sizeFilters: '27,28',
    notify: false,
    enabled: true,
    mention: '<@&12345>',
  });
});

test('商品別の空サイズ設定でグローバルフィルターを上書きできる', () => {
  const parsed = parseProductConfig(JSON.stringify({ 'HQ4307-005': { sizes: [] } }));
  assert.equal(settingsForProduct(parsed, 'HQ4307-005', '27').sizeFilters, '');
});

test('商品別設定でサイズを省略した場合はグローバルフィルターを継承する', () => {
  const parsed = parseProductConfig(JSON.stringify({ 'HQ4307-005': { notify: false } }));
  assert.equal(settingsForProduct(parsed, 'HQ4307-005', '27,28').sizeFilters, '27,28');
  assert.equal(settingsForProduct(parsed, 'HQ4307-005', '27,28').notify, false);
});

test('商品別メンションは省略時だけグローバル設定を継承する', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  let parsed;
  try {
    parsed = parseProductConfig(JSON.stringify({
      'HQ1-001': {},
      'HQ2-002': { mention: '' },
      'HQ3-003': { mention: '@everyone' },
    }));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(settingsForProduct(parsed, 'HQ1-001', '', '<@&12345>').mention, '<@&12345>');
  assert.equal(settingsForProduct(parsed, 'HQ2-002', '', '<@&12345>').mention, '');
  assert.equal(settingsForProduct(parsed, 'HQ3-003', '', '<@&12345>').mention, '');
  assert.equal(warnings.length, 1);
});

test('商品別設定JSONが不正なら安全のため例外にする', () => {
  assert.throws(() => parseProductConfig('{broken'), /invalid JSON/);
  const result = parseProductConfigSafely('{broken');
  assert.deepEqual(result.config, {});
  assert.match(result.error, /invalid JSON/);
});

test('明示的な未検出が閾値まで続いた商品を休止し成功時に復帰する', () => {
  const entry = {};
  assert.equal(updateDelistState(entry, { ok: false, notFound: true }, { threshold: 2, now: '2026-01-01T00:00:00Z' }), null);
  assert.equal(updateDelistState(entry, { ok: false, notFound: true }, { threshold: 2, now: '2026-01-01T00:01:00Z' }), 'paused');
  assert.equal(entry.pausedReason, 'delisted');
  assert.equal(updateDelistState(entry, { ok: true }, { threshold: 2 }), 'resumed');
  assert.equal(entry.pausedAt, null);
});

test('休止済み商品は一時失敗で404ストリークを失わず再休止イベントも出さない', () => {
  const entry = {};
  updateDelistState(entry, { ok: false, notFound: true }, { threshold: 2 });
  updateDelistState(entry, { ok: false, notFound: true }, { threshold: 2 });
  assert.equal(entry.pausedReason, 'delisted');

  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, { threshold: 2 }), null);
  assert.equal(entry.missingStreak, 2);
  assert.equal(updateDelistState(entry, { ok: false, notFound: true }, { threshold: 2 }), null);
  assert.equal(entry.pausedReason, 'delisted');
});

test('404以外でも長期間確認不能なら別理由で休止し成功時に復帰する', () => {
  const entry = {};
  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, {
    unreachableThreshold: 2,
  }), null);
  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, {
    unreachableThreshold: 2,
    now: '2026-01-01T00:01:00Z',
  }), 'paused');
  assert.equal(entry.pausedReason, 'unreachable');
  assert.equal(updateDelistState(entry, { ok: true }), 'resumed');
});

test('全商品に共通する障害では到達不能扱いで自動休止しない', () => {
  const entry = {};
  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, {
    unreachableThreshold: 2,
    allowUnreachablePause: false,
  }), null);
  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, {
    unreachableThreshold: 2,
    allowUnreachablePause: false,
  }), null);
  assert.equal(entry.pausedAt, undefined);
  assert.equal(entry.unresolvedStreak, 2);

  assert.equal(updateDelistState(entry, { ok: false, notFound: false }, {
    unreachableThreshold: 2,
    allowUnreachablePause: true,
    now: '2026-01-01T00:02:00Z',
  }), 'paused');
  assert.equal(entry.pausedReason, 'unreachable');
});

test('直近に別商品の成功がある場合だけ商品固有の到達不能と判断できる', () => {
  const now = Date.parse('2026-01-01T00:15:00Z');
  const samples = [
    { at: '2026-01-01T00:14:00Z', styleColor: 'HQ1-001', ok: true },
    { at: '2026-01-01T00:14:30Z', styleColor: 'HQ2-002', ok: false },
  ];

  assert.equal(hasRecentSuccessForOtherProduct(samples, 'hq2-002', { now, windowMinutes: 15 }), true);
  assert.equal(hasRecentSuccessForOtherProduct(samples, 'HQ1-001', { now, windowMinutes: 15 }), false);
  assert.equal(hasRecentSuccessForOtherProduct([
    { at: '2025-12-31T23:59:00Z', styleColor: 'HQ1-001', ok: true },
  ], 'HQ2-002', { now, windowMinutes: 15 }), false);
});

test('実行時例外でも確認時刻と失敗サンプルを記録する', () => {
  const entry = { styleColor: 'HQ1-001', lastSeenAt: null };
  const sample = applyRuntimeFailure(entry, new Error('boom'), {
    checkedAt: '2026-01-01T00:00:00Z',
    durationMs: 250,
  });
  assert.equal(entry.lastSeenAt, '2026-01-01T00:00:00Z');
  assert.equal(entry.lastRuntimeError.message, 'boom');
  assert.deepEqual(sample, {
    at: '2026-01-01T00:00:00Z',
    styleColor: 'HQ1-001',
    ok: false,
    durationMs: 250,
    inStock: false,
  });
});

test('休止商品はカタログから消えた後の再出現時だけ即時再確認する', () => {
  const entry = {
    styleColor: 'HQ1-001',
    pausedAt: '2026-01-01T00:00:00Z',
    pausedReason: 'delisted',
    lastSeenAt: '2026-01-01T00:00:00Z',
  };
  assert.deepEqual(updateCatalogPresence([entry], [{ styleColor: 'HQ1-001' }]), []);
  assert.ok(entry.pausedAt);
  assert.deepEqual(updateCatalogPresence([entry], []), []);
  assert.deepEqual(updateCatalogPresence([entry], [{ styleColor: 'HQ1-001' }]), ['HQ1-001']);
  assert.equal(entry.lastSeenAt, null);
  assert.ok(entry.pausedAt);
  assert.equal(entry.catalogReprobePending, true);

  entry.lastSeenAt = '2026-01-01T00:00:00Z';
  assert.equal(millisecondsUntilProductDue(entry, {
    now: Date.parse('2026-01-01T00:02:00Z'),
    normalIntervalSeconds: 120,
    pausedRecheckHours: 24,
  }), 0);
  updateDelistState(entry, { ok: false, notFound: false }, { unreachableThreshold: 100 });
  assert.equal(entry.catalogReprobePending, true);
  updateDelistState(entry, { ok: true });
  assert.equal(entry.catalogReprobePending, false);
  assert.equal(entry.pausedAt, null);
});

test('在庫サイズの変化だけ履歴へ追加する', () => {
  const entry = { styleColor: 'HQ1-001' };
  assert.equal(recordStockTransition(entry, { ok: true, availableSizes: [] }), null);
  const transition = recordStockTransition(entry, {
    ok: true,
    availableSizes: [{ label: '27', available: true }],
  }, { now: '2026-01-01T00:00:00Z' });
  assert.deepEqual(transition.added, ['27']);
  assert.match(transition.message, /27 が入荷/);
});

test('サイズ不明の商品レベル在庫も履歴に残す', () => {
  const entry = { styleColor: 'HQ1-001', lastObservedStockKey: '' };
  const transition = recordStockTransition(entry, { ok: true, inStock: true, availableSizes: [] });
  assert.deepEqual(transition.added, ['__product__']);
  assert.match(transition.message, /商品 が入荷/);
  assert.equal(formatStockLabels(['__product__']), '商品');
});

test('単発の在庫なしフリッカは履歴へ確定せず連続確認後に記録する', () => {
  const entry = {
    styleColor: 'HQ1-001',
    lastObservedStockKey: '27',
    oosStreak: 9,
    observedOosStreak: 0,
  };
  const outOfStock = { ok: true, inStock: false, availableSizes: [] };

  assert.equal(recordStockTransition(entry, outOfStock), null);
  assert.equal(entry.lastObservedStockKey, '27');
  assert.equal(entry.observedOosStreak, 1);

  const transition = recordStockTransition(entry, outOfStock);
  assert.deepEqual(transition.removed, ['27']);
  assert.equal(entry.lastObservedStockKey, '');
  assert.equal(entry.observedOosStreak, 2);
});

test('通知対象サイズのOOSストリークを全サイズ履歴の確定判定に流用しない', () => {
  const entry = {
    styleColor: 'HQ1-001',
    lastObservedStockKey: '28',
    oosStreak: 5,
    observedOosStreak: 0,
  };

  assert.equal(recordStockTransition(entry, {
    ok: true,
    inStock: false,
    availableSizes: [],
  }), null);
  assert.equal(entry.lastObservedStockKey, '28');
  assert.equal(entry.observedOosStreak, 1);
});

test('発売前商品だけ短い間隔で再確認する', () => {
  const now = Date.parse('2026-01-01T00:01:00Z');
  const common = { lastSeenAt: '2026-01-01T00:00:00Z' };
  assert.equal(millisecondsUntilProductDue(common, { now, normalIntervalSeconds: 120 }), 60000);
  assert.equal(millisecondsUntilProductDue({
    ...common,
    lastResult: { availabilityState: 'coming-soon' },
  }, { now, upcomingIntervalSeconds: 30 }), 0);
});

test('発売前180分から発売後60分までを優先確認する', () => {
  const releaseAt = '2026-01-01T03:00:00.000Z';
  const entry = { lastResult: { availabilityState: 'coming-soon', releaseAt } };
  assert.equal(isUpcomingPriority(entry, Date.parse('2026-01-01T00:00:00Z'), 180), true);
  assert.equal(isUpcomingPriority(entry, Date.parse('2025-12-31T23:59:00Z'), 180), false);
  assert.equal(isUpcomingPriority(entry, Date.parse('2026-01-01T04:00:00Z'), 180), true);
  assert.equal(isUpcomingPriority(entry, Date.parse('2026-01-01T04:01:00Z'), 180), false);
});

test('発売前情報は1回のフォールバック観測で失わない', () => {
  const entry = {
    lastResult: {
      availabilityState: 'coming-soon',
      releaseAt: '2026-01-01T03:00:00.000Z',
    },
  };
  updateUpcomingState(entry, {
    availabilityState: 'out-of-stock',
    releaseAt: null,
  }, { now: Date.parse('2026-01-01T02:00:00Z') });
  entry.lastResult = { availabilityState: 'out-of-stock', releaseAt: null };

  assert.equal(entry.upcomingReleaseAt, '2026-01-01T03:00:00.000Z');
  assert.equal(isUpcomingPriority(entry, Date.parse('2026-01-01T02:00:00Z'), 180), true);
});

test('単発モードでも休止商品は再確認時刻まで待つ', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const active = { lastSeenAt: '2026-01-01T23:59:30Z', pausedAt: null };
  const paused = {
    lastSeenAt: '2026-01-01T23:00:00Z',
    pausedAt: '2026-01-01T00:00:00Z',
  };

  assert.equal(shouldCheckProductNow(active, { now, singleSweep: true }), true);
  assert.equal(shouldCheckProductNow(paused, {
    now,
    singleSweep: true,
    pausedRecheckHours: 24,
  }), false);
  assert.equal(shouldCheckProductNow(paused, {
    now: Date.parse('2026-01-02T23:00:00Z'),
    singleSweep: true,
    pausedRecheckHours: 24,
  }), true);
});

test('次runで確認時刻へ到達できる場合だけ自己連鎖する', () => {
  assert.equal(shouldChainNextRun({
    monitorableProductCount: 3,
    nextDueMinutes: 2,
    loopMinutes: 25,
  }), true);
  assert.equal(shouldChainNextRun({
    singleSweep: true,
    monitorableProductCount: 3,
    nextDueMinutes: 2,
    loopMinutes: 25,
  }), false);
  assert.equal(shouldChainNextRun({
    monitorableProductCount: 0,
    nextDueMinutes: 2,
    loopMinutes: 25,
  }), false);
  assert.equal(shouldChainNextRun({
    monitorableProductCount: 3,
    nextDueMinutes: 26,
    loopMinutes: 25,
  }), false);
  assert.equal(shouldChainNextRun({
    monitorableProductCount: 3,
    nextDueMinutes: 31,
    loopMinutes: 340,
  }), false);
  assert.equal(shouldChainNextRun({
    monitorableProductCount: 3,
    nextDueMinutes: null,
    loopMinutes: 25,
  }), false);
});

test('直近24時間の成功率と平均応答時間を集計する', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const metrics = computeQualityMetrics([
    { at: '2026-01-01T23:00:00Z', ok: true, durationMs: 100 },
    { at: '2026-01-01T22:00:00Z', ok: false, durationMs: 300 },
    { at: '2025-12-30T00:00:00Z', ok: true, durationMs: 50 },
  ], { now });
  assert.equal(metrics.checks, 2);
  assert.equal(metrics.successRate, 50);
  assert.equal(metrics.averageResponseMs, 200);
});

test('品質指標はサンプル0件をnull表示し未来時刻を除外する', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.deepEqual(computeQualityMetrics([], { now }), {
    windowHours: 24,
    checks: 0,
    successes: 0,
    failures: 0,
    successRate: null,
    averageResponseMs: null,
    lastSuccessAt: null,
  });
  const metrics = computeQualityMetrics([
    { at: '2026-01-02T00:01:00Z', ok: true, durationMs: 100 },
  ], { now });
  assert.equal(metrics.checks, 0);
  assert.equal(metrics.successRate, null);
});
