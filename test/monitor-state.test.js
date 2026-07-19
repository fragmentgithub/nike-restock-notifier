import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCheckState,
  collectMonitorErrors,
  millisecondsUntilFailureBackoff,
  nextCycleDelayMs,
  nextFailureBackoffUntil,
  nextFailureWindowState,
  notificationDecision,
  shouldStopDuringSweep,
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

test('取得失敗を挟んでも在庫なし確認回数を凍結して再入荷通知を再武装する', () => {
  const entry = { lastStockKey: '27' };
  const outOfStock = { ok: true, inStock: false, matchingSizes: [] };
  const failed = { ok: false, inStock: false, matchingSizes: [] };
  const apply = (result) => {
    const decision = notificationDecision(entry, result);
    applyCheckState(entry, result, { ...decision, notified: false, webhookConfigured: true });
  };

  apply(outOfStock);
  apply(failed);
  apply(outOfStock);

  assert.equal(entry.lastStockKey, '');
  assert.equal(entry.oosStreak, 2);
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
  assert.deepEqual(decision.addedSizes, ['28']);
  assert.equal(decision.shouldNotify, true);
});

test('失敗が続くと巡回間隔を延ばし上限で止める', () => {
  assert.equal(nextCycleDelayMs(120, 0), 120000);
  assert.equal(nextCycleDelayMs(120, 1), 240000);
  assert.equal(nextCycleDelayMs(120, 2), 480000);
  assert.equal(nextCycleDelayMs(120, 4), 600000);
});

test('全体障害バックオフ終了時刻をrun間で持ち越す', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const until = nextFailureBackoffUntil(null, {
    attempted: true,
    streak: 2,
    intervalSeconds: 120,
    now,
  });
  assert.equal(until, '2026-01-01T00:08:00.000Z');
  assert.equal(millisecondsUntilFailureBackoff(until, now + 60_000), 420_000);
  assert.equal(nextFailureBackoffUntil(until, {
    attempted: false,
    streak: 2,
    now: now + 60_000,
  }), until);
  assert.equal(nextFailureBackoffUntil(until, {
    attempted: true,
    streak: 0,
    now: now + 60_000,
  }), null);
});

test('部分巡回でも時間窓内に複数商品が失敗したらバックオフを開始する', () => {
  const first = nextFailureWindowState(0, null, {
    attempts: [{ styleColor: 'HQ1-001', ok: false }],
    totalProducts: 8,
    now: Date.parse('2026-01-01T00:00:00Z'),
    windowMinutes: 5,
  });
  assert.equal(first.streak, 0);
  assert.deepEqual(first.window.products, ['HQ1-001']);

  const second = nextFailureWindowState(first.streak, first.window, {
    attempts: [{ styleColor: 'HQ2-002', ok: false }],
    totalProducts: 8,
    now: Date.parse('2026-01-01T00:01:00Z'),
    windowMinutes: 5,
  });
  assert.equal(second.streak, 1);

  const third = nextFailureWindowState(second.streak, second.window, {
    attempts: [{ styleColor: 'HQ3-003', ok: false }],
    totalProducts: 8,
    now: Date.parse('2026-01-01T00:02:00Z'),
    windowMinutes: 5,
  });
  assert.equal(third.streak, 2);
});

test('部分巡回で1商品でも成功したら失敗時間窓とストリークをリセットする', () => {
  const result = nextFailureWindowState(3, {
    startedAt: '2026-01-01T00:00:00.000Z',
    products: ['HQ1-001', 'HQ2-002'],
  }, {
    attempts: [
      { styleColor: 'HQ3-003', ok: false },
      { styleColor: 'HQ4-004', ok: true },
    ],
    totalProducts: 8,
    now: Date.parse('2026-01-01T00:01:00Z'),
  });
  assert.deepEqual(result, { streak: 0, window: null });
});

test('失敗時間窓が期限切れなら古い失敗商品を引き継がない', () => {
  const result = nextFailureWindowState(2, {
    startedAt: '2026-01-01T00:00:00.000Z',
    products: ['HQ1-001', 'HQ2-002'],
  }, {
    attempts: [{ styleColor: 'HQ3-003', ok: false }],
    totalProducts: 8,
    now: Date.parse('2026-01-01T00:06:00Z'),
    windowMinutes: 5,
  });
  assert.equal(result.streak, 0);
  assert.deepEqual(result.window.products, ['HQ3-003']);
});

test('確認対象がないサイクルでも期限切れの失敗時間窓を解除する', () => {
  const expired = nextFailureWindowState(4, {
    startedAt: '2026-01-01T00:00:00.000Z',
    products: ['HQ1-001', 'HQ2-002'],
  }, {
    attempts: [],
    now: Date.parse('2026-01-01T00:16:00Z'),
    windowMinutes: 15,
  });
  assert.deepEqual(expired, { streak: 0, window: null });

  const current = nextFailureWindowState(4, {
    startedAt: '2026-01-01T00:00:00.000Z',
    products: ['HQ1-001', 'HQ2-002'],
  }, {
    attempts: [],
    now: Date.parse('2026-01-01T00:14:00Z'),
    windowMinutes: 15,
  });
  assert.equal(current.streak, 4);
  assert.deepEqual(current.window.products, ['HQ1-001', 'HQ2-002']);
});

test('休止して監視対象外になった商品の失敗は時間窓から除外する', () => {
  const result = nextFailureWindowState(1, {
    startedAt: '2026-01-01T00:00:00.000Z',
    products: ['PAUSED-001'],
  }, {
    attempts: [{ styleColor: 'HQ1-001', ok: false }],
    activeProducts: ['HQ1-001', 'HQ2-002'],
    totalProducts: 2,
    now: Date.parse('2026-01-01T00:01:00Z'),
  });
  assert.equal(result.streak, 1);
  assert.deepEqual(result.window.products, ['HQ1-001']);
});

test('単一商品の監視ではその商品の失敗だけでバックオフする', () => {
  const result = nextFailureWindowState(0, null, {
    attempts: [{ styleColor: 'HQ1-001', ok: false }],
    totalProducts: 1,
    now: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(result.streak, 1);
});

test('単発モードはdeadlineを超えても巡回途中で終了しない', () => {
  assert.equal(shouldStopDuringSweep({ singleSweep: true, deadline: 100, now: 101 }), false);
  assert.equal(shouldStopDuringSweep({ singleSweep: false, deadline: 100, now: 101 }), true);
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
