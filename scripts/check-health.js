import { mkdir } from 'node:fs/promises';
import { normalizeDiscordWebhook, postDiscordWebhook } from '../src/discord.js';
import { readJsonFile, writeJsonFileAtomic } from '../src/json-file.js';
import { CLOUDFLARE_HEALTH_URL, githubHealthHeaders } from './github-health-auth.js';
import {
  createHealthNotificationPayload,
  evaluateMonitorHealth,
  evaluateStatusFetchFailure,
  evaluateWorkerHealth,
  resolveStatusPageUrl,
  shouldNotifyHealthTransition,
} from '../src/health.js';

const STATE_DIR = '.health-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const statusUrl = validHttpUrl(
  process.env.STATUS_URL || 'https://fragmentgithub.github.io/nike-restock-notifier/status.json',
  'STATUS_URL',
);
const webhook = configuredDiscordWebhook(process.env.DISCORD_WEBHOOK || '');
const statusPageUrl = resolveStatusPageUrl(process.env.STATUS_PAGE_URL);
const staleMinutes = clampNumber(process.env.HEALTH_STALE_MINUTES, 50, 10, 360);

await mkdir(STATE_DIR, { recursive: true });
const previous = await readJsonFile(STATE_PATH, {});
let status = null;
let health;
let fetchFailureStreak = 0;

try {
  const cloudflare = statusUrl === CLOUDFLARE_HEALTH_URL;
  const headers = cloudflare ? await githubHealthHeaders() : {};
  const response = await fetch(statusUrl, { cache: 'no-store', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok && !(cloudflare && response.status === 503)) throw new Error(`${response.status} ${response.statusText}`);
  status = await response.json();
  health = cloudflare ? evaluateWorkerHealth(status) : evaluateMonitorHealth(status, { staleMinutes });
} catch (error) {
  const failure = evaluateStatusFetchFailure(previous, error, { threshold: 2 });
  fetchFailureStreak = failure.fetchFailureStreak;
  health = failure.health;
}

const currentState = health.healthy ? 'healthy' : 'unhealthy';
const changed = previous.status !== currentState;
let notifiedStatus = previous.notifiedStatus;
if (shouldNotifyHealthTransition(previous.notifiedStatus, currentState) && webhook) {
  await sendHealthNotification(webhook, health, statusPageUrl);
  notifiedStatus = currentState;
}

await writeJsonFileAtomic(STATE_PATH, {
  status: currentState,
  checkedAt: new Date().toISOString(),
  statusUpdatedAt: health.updatedAt,
  reason: health.reason,
  notifiedStatus,
  fetchFailureStreak,
});

console.log(JSON.stringify({ status: currentState, changed, ...health }, null, 2));

async function sendHealthNotification(url, result, pageUrl) {
  await postDiscordWebhook(url, createHealthNotificationPayload(result, pageUrl));
}

function validHttpUrl(value, name) {
  const normalized = optionalHttpUrl(value);
  if (!normalized) throw new Error(`${name} must be an http(s) URL`);
  return normalized;
}

function optionalHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function configuredDiscordWebhook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeDiscordWebhook(raw);
  if (!normalized) {
    console.warn('DISCORD_WEBHOOK is not a valid Discord webhook; health notifications are disabled.');
  }
  return normalized;
}

function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
