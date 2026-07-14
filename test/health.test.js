import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMonitorHealth, shouldNotifyHealthTransition } from '../src/health.js';

test('更新時刻が閾値内なら正常と判定する', () => {
  const result = evaluateMonitorHealth(
    { updatedAt: '2026-01-01T00:00:00Z' },
    { now: Date.parse('2026-01-01T00:30:00Z'), staleMinutes: 50 },
  );
  assert.equal(result.healthy, true);
  assert.equal(result.ageMinutes, 30);
});

test('更新停止と不正なstatusを異常判定する', () => {
  assert.equal(evaluateMonitorHealth(
    { updatedAt: '2026-01-01T00:00:00Z' },
    { now: Date.parse('2026-01-01T01:00:00Z'), staleMinutes: 50 },
  ).healthy, false);
  assert.equal(evaluateMonitorHealth({}, {}).healthy, false);
});

test('statusが更新中でも商品別設定エラーなら異常判定する', () => {
  const result = evaluateMonitorHealth({
    updatedAt: '2026-01-01T00:00:00Z',
    config: { productConfigError: 'invalid JSON' },
  }, { now: Date.parse('2026-01-01T00:01:00Z') });
  assert.equal(result.healthy, false);
  assert.match(result.reason, /監視設定エラー/);
});

test('初回正常時は通知せず異常化と復旧だけ通知する', () => {
  assert.equal(shouldNotifyHealthTransition(undefined, 'healthy'), false);
  assert.equal(shouldNotifyHealthTransition('healthy', 'unhealthy'), true);
  assert.equal(shouldNotifyHealthTransition('unhealthy', 'unhealthy'), false);
  assert.equal(shouldNotifyHealthTransition('unhealthy', 'healthy'), true);
});
