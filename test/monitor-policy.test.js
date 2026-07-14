import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuntimeFailure,
  computeQualityMetrics,
  millisecondsUntilProductDue,
  parseProductConfig,
  parseProductConfigSafely,
  recordStockTransition,
  settingsForProduct,
  shouldCheckProductNow,
  updateDelistState,
  updateCatalogPresence,
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
