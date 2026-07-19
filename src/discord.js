import { fetchWithTimeout } from './util.js';

const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
const DISCORD_WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/;

export function normalizeDiscordWebhook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const valid =
      url.protocol === 'https:' &&
      DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password &&
      !url.port &&
      DISCORD_WEBHOOK_PATH.test(url.pathname);
    if (!valid) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeDiscordMention(value) {
  const raw = String(value || '').trim();
  return /^(?:<@&\d+>|<@!?\d+>)$/.test(raw) ? raw : '';
}

export function discordAllowedMentions(mention) {
  const normalized = normalizeDiscordMention(mention);
  const role = normalized.match(/^<@&(\d+)>$/)?.[1];
  if (role) return { parse: [], roles: [role] };
  const user = normalized.match(/^<@!?(\d+)>$/)?.[1];
  if (user) return { parse: [], users: [user] };
  return { parse: [] };
}

export function scrubDiscordWebhook(text, configuredWebhook = '') {
  let output = String(text || '');
  if (configuredWebhook) output = output.split(configuredWebhook).join('[webhook]');
  return output.replace(
    /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\S+/gi,
    '[webhook]',
  );
}

export async function postDiscordWebhook(
  webhook,
  payload,
  { fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  const normalizedWebhook = normalizeDiscordWebhook(webhook);
  if (!normalizedWebhook) {
    throw new Error('Discord webhook URL is invalid.');
  }

  const response = await fetchWithTimeout(normalizedWebhook, {
    fetchImpl,
    timeoutMs,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Discord request failed: ${response.status} ${response.statusText}`);
  }
  await response.body?.cancel();
}
