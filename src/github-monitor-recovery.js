const ACTIVE_RUN_STATUSES = new Set([
  'in_progress',
  'pending',
  'queued',
  'requested',
  'waiting',
]);

export function planMonitorRecovery(
  runs,
  { now = Date.now(), staleMinutes = 90 } = {},
) {
  const thresholdMinutes = clampNumber(staleMinutes, 90, 30, 1440);
  const thresholdMs = thresholdMinutes * 60_000;
  const activeRuns = deduplicateActiveRuns(
    Array.isArray(runs)
      ? runs.filter((run) => ACTIVE_RUN_STATUSES.has(run?.status))
      : [],
  );
  const staleWaitingRuns = activeRuns.filter((run) => {
    if (run.status !== 'waiting') return false;
    const createdAt = Date.parse(run.created_at || run.createdAt || '');
    return Number.isFinite(createdAt) && now - createdAt >= thresholdMs;
  });
  const staleIds = new Set(staleWaitingRuns.map((run) => String(run.id)));
  const remainingActiveRuns = activeRuns.filter(
    (run) => run.status !== 'waiting' || !staleIds.has(String(run.id)),
  );

  return {
    thresholdMinutes,
    staleWaitingRuns,
    remainingActiveRuns,
    shouldDispatch: staleWaitingRuns.length > 0 && remainingActiveRuns.length === 0,
  };
}

export async function recoverStaleMonitorRuns({
  token,
  repository,
  workflow = 'pages.yml',
  ref = 'main',
  staleMinutes = 90,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const repo = String(repository || '').trim();
  const authToken = String(token || '').trim();
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  if (!authToken) throw new Error('GITHUB_TOKEN is required');

  const workflowPath = encodeURIComponent(String(workflow || 'pages.yml'));
  const baseUrl = `https://api.github.com/repos/${repo}`;
  const workflowRunsUrl = `${baseUrl}/actions/workflows/${workflowPath}/runs`;
  const waitingList = await githubRequest(
    `${workflowRunsUrl}?status=waiting&per_page=100`,
    { token: authToken, fetchImpl },
  );
  const waitingRuns = waitingList?.workflow_runs || [];
  const waitingPlan = planMonitorRecovery(waitingRuns, { now, staleMinutes });
  if (waitingPlan.staleWaitingRuns.length === 0) {
    return {
      thresholdMinutes: waitingPlan.thresholdMinutes,
      staleWaitingRunIds: [],
      cancelledRunIds: [],
      remainingActiveRunIds: waitingPlan.remainingActiveRuns.map((run) => run.id),
      dispatched: false,
    };
  }

  const otherActiveRuns = await listWorkflowRuns(
    workflowRunsUrl,
    ['in_progress', 'pending', 'queued', 'requested'],
    { token: authToken, fetchImpl },
  );
  const plan = planMonitorRecovery([...waitingRuns, ...otherActiveRuns], { now, staleMinutes });
  const cancelledRunIds = [];

  for (const run of plan.staleWaitingRuns) {
    const currentRun = await githubRequest(
      `${baseUrl}/actions/runs/${encodeURIComponent(String(run.id))}`,
      { token: authToken, fetchImpl },
    );
    const currentPlan = planMonitorRecovery([currentRun], { now, staleMinutes });
    if (currentPlan.staleWaitingRuns.length === 0) continue;

    const response = await githubRequest(
      `${baseUrl}/actions/runs/${run.id}/cancel`,
      { token: authToken, fetchImpl, method: 'POST', allowConflict: true },
    );
    if (!response?.conflict) cancelledRunIds.push(run.id);
  }

  // Cancellation and runner acquisition are asynchronous. Re-read every
  // active status before dispatching so a run that advanced while this check
  // was executing prevents a duplicate monitor run.
  const refreshedActiveRuns = await listWorkflowRuns(
    workflowRunsUrl,
    ['waiting', 'in_progress', 'pending', 'queued', 'requested'],
    { token: authToken, fetchImpl },
  );
  const currentActiveRuns = deduplicateActiveRuns(refreshedActiveRuns);

  let dispatched = false;
  if (currentActiveRuns.length === 0) {
    await githubRequest(
      `${baseUrl}/actions/workflows/${workflowPath}/dispatches`,
      {
        token: authToken,
        fetchImpl,
        method: 'POST',
        body: { ref },
      },
    );
    dispatched = true;
  }

  return {
    thresholdMinutes: plan.thresholdMinutes,
    staleWaitingRunIds: plan.staleWaitingRuns.map((run) => run.id),
    cancelledRunIds,
    remainingActiveRunIds: currentActiveRuns.map((run) => run.id),
    dispatched,
  };
}

async function listWorkflowRuns(workflowRunsUrl, statuses, { token, fetchImpl }) {
  const runs = [];
  for (const status of statuses) {
    const list = await githubRequest(
      `${workflowRunsUrl}?status=${status}&per_page=100`,
      { token, fetchImpl },
    );
    runs.push(...(list?.workflow_runs || []));
  }
  return runs;
}

function deduplicateActiveRuns(runs) {
  const byId = new Map();
  for (const run of runs || []) {
    const id = String(run?.id ?? '');
    if (!id) continue;
    const existing = byId.get(id);
    // A non-waiting observation comes from a later status-filtered request and
    // proves the run has already left the approval queue.
    if (!existing || (existing.status === 'waiting' && run.status !== 'waiting')) {
      byId.set(id, run);
    }
  }
  return [...byId.values()];
}

async function githubRequest(url, {
  token,
  fetchImpl,
  method = 'GET',
  body,
  allowConflict = false,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (allowConflict && response.status === 409) return { conflict: true };
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${response.status}: ${detail || response.statusText}`);
  }
  if (response.status === 204 || response.status === 202) return null;
  return response.json();
}

function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
