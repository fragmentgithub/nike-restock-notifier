import { recoverStaleMonitorRuns } from '../src/github-monitor-recovery.js';

const result = await recoverStaleMonitorRuns({
  token: process.env.GITHUB_TOKEN,
  repository: process.env.GITHUB_REPOSITORY,
  workflow: process.env.MONITOR_WORKFLOW || 'pages.yml',
  ref: process.env.MONITOR_REF || 'main',
  staleMinutes: process.env.MONITOR_WAITING_STALE_MINUTES,
});

console.log(JSON.stringify(result, null, 2));
