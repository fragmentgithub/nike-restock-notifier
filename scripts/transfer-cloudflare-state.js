import { readFile } from 'node:fs/promises';
import { constants, publicEncrypt } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDiscordWebhook } from '../src/discord.js';
import { MONITOR_VARIABLES, readMigrationPublicKey, validateMonitorState } from './export-cloudflare-state.js';

export const MIGRATION_DESTINATION = 'https://nike-restock-notifier.only-this-moment.workers.dev';

// Memory-only preparation. No artifacts, logs, or plaintext credential files are created.
export function prepareDirectTransfer(state, env) {
  if (env.GITHUB_REPOSITORY !== 'fragmentgithub/nike-restock-notifier' ||
      !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Migration must run in the configured GitHub repository.');
  }
  validateMonitorState(state);
  const publicKey = readMigrationPublicKey(env.MIGRATION_PUBLIC_KEY);
  const webhook = normalizeDiscordWebhook(env.DISCORD_WEBHOOK);
  if (!webhook) throw new Error('A valid Discord webhook is required.');
  let sourceVariables;
  try { sourceVariables = JSON.parse(env.REPOSITORY_VARIABLES); }
  catch { throw new Error('Repository variables are invalid.'); }
  if (!sourceVariables || typeof sourceVariables !== 'object' || Array.isArray(sourceVariables)) {
    throw new Error('Repository variables must be an object.');
  }
  const vars = {};
  for (const key of MONITOR_VARIABLES) {
    if (!Object.hasOwn(sourceVariables, key)) continue;
    if (typeof sourceVariables[key] !== 'string') throw new Error('Repository settings must be strings.');
    vars[key] = sourceVariables[key];
  }
  const plainData = JSON.stringify({ state, vars });
  if (plainData.includes(webhook) || /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\//i.test(plainData)) {
    throw new Error('Monitor state contains unexpected plaintext credentials.');
  }
  let encryptedWebhook;
  try {
    encryptedWebhook = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(webhook)).toString('base64');
  } catch { throw new Error('Credential encryption failed.'); }
  return { state, vars, migrationId: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`, encryptedWebhook };
}

export async function transferToCloudflare({ env = process.env, fetchImpl = fetch, statePath = '.monitor-state/state.json' } = {}) {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch { throw new Error('The saved GitHub monitor state could not be read.'); }
  const payload = prepareDirectTransfer(state, env);
  let oidcUrl;
  try { oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); }
  catch { throw new Error('GitHub OIDC is unavailable.'); }
  if (oidcUrl.protocol !== 'https:' || !oidcUrl.hostname.endsWith('.actions.githubusercontent.com') ||
      oidcUrl.username || oidcUrl.password || oidcUrl.port) throw new Error('Unexpected GitHub OIDC endpoint.');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub OIDC permission is missing.');
  oidcUrl.searchParams.set('audience', MIGRATION_DESTINATION);
  const tokenResponse = await fetchImpl(oidcUrl, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!tokenResponse.ok) throw new Error(`GitHub OIDC request failed (${tokenResponse.status}).`);
  const { value: identityToken } = await tokenResponse.json();
  if (typeof identityToken !== 'string' || !identityToken) throw new Error('GitHub did not issue an identity token.');
  const response = await fetchImpl(`${MIGRATION_DESTINATION}/migration/transfer`, {
    method: 'POST', headers: { authorization: `Bearer ${identityToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(90000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Cloudflare migration was rejected (${response.status}).`);
  const result = await response.json();
  return { migrationId: payload.migrationId, products: result.products, imported: result.imported };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await transferToCloudflare();
    console.log(`Monitor state transferred directly to Cloudflare (${result.products} products; ${result.migrationId}).`);
  } catch (error) {
    console.error(`Direct migration failed: ${String(error?.message || 'Unknown error').replace(/https?:\/\/\S+/g, '[redacted]')}`);
    process.exitCode = 1;
  }
}
