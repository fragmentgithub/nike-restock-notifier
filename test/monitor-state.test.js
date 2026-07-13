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

test('在庫なしを連続確認したらキーを消す(単発フリッカでは消さない)', () => {
  const entry = { lastStockKey: '27' };
  const result = { ok: true, inStock: false, matchingSizes: [] };
  const apply = () => {
    const decision = notificationDecision(entry, result);
    applyCheckState(entry, result, { ...decision, notified: false, webhookConfigured: true });
  };

  apply();
  // 1回目の inStock:false(パーサ・フォールバックのフリッカ想定)ではキーを保持し、重複通知を防ぐ。
  assert.equal(entry.lastStockKey, '27');
  apply();
  // 連続で在庫なしを確認したら確定クリアし、再入荷時に再通知できるようにする。
  assert.equal(entry.lastStockKey, '');
});

test('汎用在庫(__product__)から具体サイズが判明したら通知する', () => {
  const entry = { lastStockKey: '__product__' };
  const result = {
    ok: true,
    inStock: true,
    matchingSizes: [{ label: '27', available: true }],
  };

  const decision = notificationDecision(entry, result);
  assert.equal(decision.nextStockKey, '27');
  assert.equal(decision.shouldNotify, true);
});

test('汎用在庫(__product__)が続く間は再通知しない', () => {
  const entry = { lastStockKey: '__product__' };
  const result = { ok: true, inStock: true, matchingSizes: [] };

  const decision = notificationDecision(entry, result);
  assert.equal(decision.nextStockKey, '__product__');
  assert.equal(decision.shouldNotify, false);
});

test('在庫サイズが減っただけでは再通知しない', () => {
  const entry = { lastStockKey: '27|28' };
  const result = {
    ok: true,
    inStock: true,
    matchingSizes: [{ label: '27', available: true }],
  };

  const decision = notificationDecision(entry, result);
  assert.equal(decision.nextStockKey, '27');
  assert.equal(decision.shouldNotify, false);
});

test('新しく在庫になったサイズがあれば再通知する', () => {
  const entry = { lastStockKey: '27' };
  const result = {
    ok: true,
    inStock: true,
    matchingSizes: [
      { label: '27', available: true },
      { label: '28', available: true },
    ],
  };

  const decision = notificationDecision(entry, result);
  assert.equal(decision.nextStockKey, '27|28');
  assert.equal(decision.shouldNotify, true);
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
