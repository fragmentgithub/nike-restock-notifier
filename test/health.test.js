import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMonitorHealth,
  evaluateStatusFetchFailure,
  shouldNotifyHealthTransition,
} from '../src/health.js';

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

test('更新停止閾値は監視runの長さとPages反映余裕より短くならない', () => {
  const status = {
    updatedAt: '2026-01-01T00:00:00Z',
    config: { loopMinutes: 60 },
  };
  const withinEffectiveThreshold = evaluateMonitorHealth(status, {
    now: Date.parse('2026-01-01T01:20:00Z'),
    staleMinutes: 50,
  });
  assert.equal(withinEffectiveThreshold.healthy, true);
  assert.equal(withinEffectiveThreshold.thresholdMinutes, 80);
  assert.equal(evaluateMonitorHealth(status, {
    now: Date.parse('2026-01-01T01:21:00Z'),
    staleMinutes: 50,
  }).healthy, false);
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
  assert.equal(shouldNotifyHealthTransition(undefined, 'unhealthy'), true);
  assert.equal(shouldNotifyHealthTransition('healthy', 'unhealthy'), true);
  assert.equal(shouldNotifyHealthTransition('unhealthy', 'unhealthy'), false);
  assert.equal(shouldNotifyHealthTransition('unhealthy', 'healthy'), true);
});

test('status.jsonの取得失敗は2回連続するまで停止扱いにしない', () => {
  const first = evaluateStatusFetchFailure(
    { status: 'healthy', fetchFailureStreak: 0 },
    new Error('503 Service Unavailable'),
  );
  assert.equal(first.fetchFailureStreak, 1);
  assert.equal(first.health.healthy, true);

  const second = evaluateStatusFetchFailure(
    { status: 'healthy', fetchFailureStreak: first.fetchFailureStreak },
    new Error('503 Service Unavailable'),
  );
  assert.equal(second.fetchFailureStreak, 2);
  assert.equal(second.health.healthy, false);
});

test('既に停止扱いなら単発の取得失敗で復旧扱いにしない', () => {
  const result = evaluateStatusFetchFailure(
    { status: 'unhealthy', fetchFailureStreak: 0 },
    new Error('timeout'),
  );
  assert.equal(result.health.healthy, false);
});
