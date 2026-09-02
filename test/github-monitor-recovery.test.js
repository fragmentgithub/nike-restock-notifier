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

test('waiting取得後に同じ実行が開始済みなら停止も追加起動もしない', () => {
  const plan = planMonitorRecovery([
    run(12, 'waiting', '2026-08-21T20:00:00Z'),
    run(12, 'in_progress', '2026-08-21T20:00:00Z'),
  ], { now, staleMinutes: 90 });

  assert.deepEqual(plan.staleWaitingRuns, []);
  assert.deepEqual(plan.remainingActiveRuns.map((item) => item.id), [12]);
  assert.equal(plan.shouldDispatch, false);
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
    'waiting', 'in_progress', 'pending', 'queued', 'requested',
  ]);
  assert.equal(requests.some((request) => request.url.endsWith('/actions/runs/21/cancel')), true);
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
    'waiting', 'in_progress', 'pending', 'queued', 'requested',
  ]);
  assert.equal(requests.some((request) => request.url.endsWith('/actions/runs/31/cancel')), true);
  assert.equal(requests.at(-1).url.endsWith('/actions/workflows/pages.yml/dispatches'), true);
  assert.equal(requests.at(-1).body, JSON.stringify({ ref: 'main' }));
});

test('停止直前に同じ実行が開始された場合は停止も追加起動もしない', async () => {
  const requests = [];
  let waitingReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (method === 'POST') {
      return new Response(null, { status: 204 });
    }

    if (/\/actions\/runs\/41$/.test(url)) {
      return Response.json(run(41, 'in_progress', '2026-08-21T20:00:00Z'));
    }

    const status = new URL(url).searchParams.get('status');
    if (status === 'waiting') {
      waitingReads += 1;
      return Response.json({
        workflow_runs: waitingReads === 1
          ? [run(41, 'waiting', '2026-08-21T20:00:00Z')]
          : [],
      });
    }
    return Response.json({
      workflow_runs: status === 'in_progress' && waitingReads > 1
        ? [run(41, 'in_progress', '2026-08-21T20:00:00Z')]
        : [],
    });
  };

  const result = await recoverStaleMonitorRuns({
    token: 'test-token',
    repository: 'owner/repo',
    staleMinutes: 90,
    now,
    fetchImpl,
  });

  assert.deepEqual(result.cancelledRunIds, []);
  assert.deepEqual(result.remainingActiveRunIds, [41]);
  assert.equal(result.dispatched, false);
  assert.equal(requests.some((request) => request.url.endsWith('/cancel')), false);
  assert.equal(requests.some((request) => request.url.endsWith('/dispatches')), false);
});

test('停止要求が競合した後に開始済みの実行があれば追加起動しない', async () => {
  const requests = [];
  let waitingReads = 0;
  let cancelConflicted = false;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (method === 'POST') {
      if (url.endsWith('/cancel')) {
        cancelConflicted = true;
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (/\/actions\/runs\/42$/.test(url)) {
      return Response.json(run(42, 'waiting', '2026-08-21T20:00:00Z'));
    }

    const status = new URL(url).searchParams.get('status');
    if (status === 'waiting') {
      waitingReads += 1;
      return Response.json({
        workflow_runs: waitingReads === 1
          ? [run(42, 'waiting', '2026-08-21T20:00:00Z')]
          : [],
      });
    }
    return Response.json({
      workflow_runs: cancelConflicted && status === 'in_progress'
        ? [run(42, 'in_progress', '2026-08-21T20:00:00Z')]
        : [],
    });
  };

  const result = await recoverStaleMonitorRuns({
    token: 'test-token',
    repository: 'owner/repo',
    staleMinutes: 90,
    now,
    fetchImpl,
  });

  assert.deepEqual(result.cancelledRunIds, []);
  assert.deepEqual(result.remainingActiveRunIds, [42]);
  assert.equal(result.dispatched, false);
  assert.equal(requests.some((request) => request.url.endsWith('/cancel')), true);
  assert.equal(requests.some((request) => request.url.endsWith('/dispatches')), false);
});

function run(id, status, createdAt) {
  return { id, status, created_at: createdAt };
}

function mockGitHub(runs, requests) {
  const cancelledIds = new Set();
  return async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (method === 'GET') {
      const runId = url.match(/\/actions\/runs\/(\d+)$/)?.[1];
      if (runId) {
        const currentRun = runs.find((item) => item.id === Number(runId));
        return currentRun && !cancelledIds.has(currentRun.id)
          ? Response.json(currentRun)
          : new Response(null, { status: 404 });
      }
      const status = new URL(url).searchParams.get('status');
      return Response.json({
        workflow_runs: runs.filter(
          (item) => item.status === status && !cancelledIds.has(item.id),
        ),
      });
    }
    const cancelledId = url.match(/\/actions\/runs\/(\d+)\/cancel$/)?.[1];
    if (cancelledId) cancelledIds.add(Number(cancelledId));
    return new Response(null, { status: 204 });
  };
}

function getRequestedStatuses(requests) {
  return requests
    .filter((item) => item.method === 'GET')
    .map((item) => new URL(item.url).searchParams.get('status'))
    .filter(Boolean);
}
