import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { normalizeDiscordWebhook, postDiscordWebhook } from '../src/discord.js';
import {
  evaluateMonitorHealth,
  evaluateStatusFetchFailure,
  shouldNotifyHealthTransition,
} from '../src/health.js';

const STATE_DIR = '.health-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const statusUrl = validHttpUrl(
  process.env.STATUS_URL || 'https://fragmentgithub.github.io/nike-restock-notifier/status.json',
  'STATUS_URL',
);
const webhook = configuredDiscordWebhook(process.env.DISCORD_WEBHOOK || '');
const staleMinutes = clampNumber(process.env.HEALTH_STALE_MINUTES, 50, 10, 360);

await mkdir(STATE_DIR, { recursive: true });
const previous = await readJson(STATE_PATH, {});
let status = null;
let health;
let fetchFailureStreak = 0;

try {
  const response = await fetch(statusUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  status = await response.json();
  health = evaluateMonitorHealth(status, { staleMinutes });
} catch (error) {
  const failure = evaluateStatusFetchFailure(previous, error, { threshold: 2 });
  fetchFailureStreak = failure.fetchFailureStreak;
  health = failure.health;
}

const currentState = health.healthy ? 'healthy' : 'unhealthy';
const changed = previous.status !== currentState;
let notifiedStatus = previous.notifiedStatus;
if (shouldNotifyHealthTransition(previous.notifiedStatus, currentState) && webhook) {
  await sendHealthNotification(webhook, health, statusUrl);
  notifiedStatus = currentState;
}

await writeFile(STATE_PATH, JSON.stringify({
  status: currentState,
  checkedAt: new Date().toISOString(),
  statusUpdatedAt: health.updatedAt,
  reason: health.reason,
  notifiedStatus,
  fetchFailureStreak,
}, null, 2), 'utf8');

console.log(JSON.stringify({ status: currentState, changed, ...health }, null, 2));

async function sendHealthNotification(url, result, pageUrl) {
  const recovered = result.healthy;
  await postDiscordWebhook(url, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: recovered ? 'Nike監視が復旧しました' : 'Nike監視の更新が停止しています',
      description: recovered ? 'ステータス更新が正常範囲へ戻りました。' : result.reason,
      url: pageUrl.replace(/\/status\.json(?:\?.*)?$/, '/'),
      color: recovered ? 0x26734d : 0xa43f3a,
      fields: result.updatedAt
        ? [{ name: '最終更新', value: `<t:${Math.floor(Date.parse(result.updatedAt) / 1000)}:R>` }]
        : [],
      timestamp: new Date().toISOString(),
    }],
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
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
