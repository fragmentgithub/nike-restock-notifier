import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckState,
  collectMonitorErrors,
  nextCycleDelayMs,
  notificationDecision,
} from '../src/monitor-state.js';

test('取得失敗時は通知済みキーを保持する', () => {
  const entry = { lastStockKey: '27' };
  const result = { ok: false, inStock: false, matchingSizes: [] };
  const decision = notificationDecision(entry, result);

  applyCheckState(entry, result, {
    ...decision,
    notified: false,
    webhookConfigured: true,
  });
  assert.equal(entry.lastStockKey, '27');
  assert.equal(decision.shouldNotify, false);
});

test('在庫なしを正常確認した場合だけ通知済みキーを消す', () => {
  const entry = { lastStockKey: '27' };
  const result = { ok: true, inStock: false, matchingSizes: [] };
  const decision = notificationDecision(entry, result);

  applyCheckState(entry, result, {
    ...decision,
    notified: false,
    webhookConfigured: true,
  });
  assert.equal(entry.lastStockKey, '');
});

test('失敗が続くと巡回間隔を延ばし上限で止める', () => {
  assert.equal(nextCycleDelayMs(120, 0), 120000);
  assert.equal(nextCycleDelayMs(120, 1), 240000);
  assert.equal(nextCycleDelayMs(120, 2), 480000);
  assert.equal(nextCycleDelayMs(120, 4), 600000);
});

test('商品別エラーと探索エラーをまとめて保持する', () => {
  const errors = collectMonitorErrors(
    [
      { styleColor: 'HQ1-001', lastResult: { ok: true } },
      { styleColor: 'HQ2-002', lastResult: { ok: false, statusLabel: '確認できません' } },
    ],
    'catalog blocked',
  );

  assert.deepEqual(errors, [
    '新カラー探索: catalog blocked',
    'HQ2-002: 確認できません',
  ]);
});
