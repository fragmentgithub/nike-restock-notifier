import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMonitorRecovery,
  recoverStaleMonitorRuns,
} from '../src/github-monitor-recovery.js';

const now = Date.parse('2026-08-22T00:00:00Z');

test('90分以上waitingの実行だけを停止対象にする', () => {
  const plan = planMonitorRecovery([
    run(1, 'waiting', '2026-08-21T20:00:00Z'),
    run(2, 'waiting', '2026-08-21T23:30:00Z'),
    run(3, 'in_progress', '2026-08-21T20:00:00Z'),
  ], { now, staleMinutes: 90 });

  assert.deepEqual(plan.staleWaitingRuns.map((item) => item.id), [1]);
  assert.deepEqual(plan.remainingActiveRuns.map((item) => item.id), [2, 3]);
  assert.equal(plan.shouldDispatch, false);
});

test('古いwaitingだけならキャンセル後の再起動を計画する', () => {
  const plan = planMonitorRecovery([
    run(11, 'waiting', '2026-08-21T20:00:00Z'),
    run(10, 'completed', '2026-08-21T19:00:00Z'),
  ], { now, staleMinutes: 90 });

  assert.equal(plan.shouldDispatch, true);
});

test('後続のpendingがあれば古いwaitingだけをキャンセルして追加起動しない', async () => {
  const requests = [];
  const result = await recoverStaleMonitorRuns({
    token: 'test-token',
    repository: 'owner/repo',
    staleMinutes: 90,
    now,
    fetchImpl: mockGitHub([
      run(21, 'waiting', '2026-08-21T20:00:00Z'),
      run(22, 'pending', '2026-08-21T23:50:00Z'),
    ], requests),
  });

  assert.deepEqual(result.cancelledRunIds, [21]);
  assert.equal(result.dispatched, false);
  assert.deepEqual(getRequestedStatuses(requests), [
    'waiting', 'in_progress', 'pending', 'queued', 'requested',
  ]);
  assert.equal(requests.at(-1).url.endsWith('/actions/runs/21/cancel'), true);
});

test('後続がなければ古いwaitingをキャンセルして監視を再起動する', async () => {
  const requests = [];
  const result = await recoverStaleMonitorRuns({
    token: 'test-token',
    repository: 'owner/repo',
    staleMinutes: 90,
    now,
    fetchImpl: mockGitHub([
      run(31, 'waiting', '2026-08-21T20:00:00Z'),
    ], requests),
  });

  assert.deepEqual(result.cancelledRunIds, [31]);
  assert.equal(result.dispatched, true);
  assert.deepEqual(getRequestedStatuses(requests), [
    'waiting', 'in_progress', 'pending', 'queued', 'requested',
  ]);
  assert.equal(requests.at(-2).url.endsWith('/actions/runs/31/cancel'), true);
  assert.equal(requests.at(-1).url.endsWith('/actions/workflows/pages.yml/dispatches'), true);
  assert.equal(requests.at(-1).body, JSON.stringify({ ref: 'main' }));
});

function run(id, status, createdAt) {
  return { id, status, created_at: createdAt };
}

function mockGitHub(runs, requests) {
  return async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (method === 'GET') {
      const status = new URL(url).searchParams.get('status');
      return Response.json({ workflow_runs: runs.filter((item) => item.status === status) });
    }
    return new Response(null, { status: 204 });
  };
}

function getRequestedStatuses(requests) {
  return requests
    .filter((item) => item.method === 'GET')
    .map((item) => new URL(item.url).searchParams.get('status'));
}
