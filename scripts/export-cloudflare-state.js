import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDiscordWebhook } from '../src/discord.js';
import { parseNikeProductUrl } from '../src/nike.js';

export const MONITOR_VARIABLES = Object.freeze([
  'PRODUCT_URL', 'PRODUCT_URLS', 'SIZE_FILTERS', 'INTERVAL_SECONDS',
  'DISCOVERY_URL', 'FRAGMENT_DISCOVERY_URLS', 'DISCOVERY_INTERVAL_HOURS',
  'DISCOVERY_RETRY_MINUTES', 'PRODUCT_CHECK_DELAY_MS', 'PRODUCT_CONFIG_JSON',
  'DELIST_FAILURE_THRESHOLD', 'PAUSED_RECHECK_HOURS', 'UPCOMING_INTERVAL_SECONDS',
  'UPCOMING_WINDOW_MINUTES', 'DISCORD_MENTION',
]);

// Export preparation only: no network requests, monitor execution, or cutover.
export async function createCloudflareExport({
  statePath = '.monitor-state/state.json',
  outputDirectory = '.cloudflare-export',
  env = process.env,
  now = () => new Date(),
} = {}) {
  const publicKey = readMigrationPublicKey(env.MIGRATION_PUBLIC_KEY);
  const rawWebhook = String(env.DISCORD_WEBHOOK || '').trim();
  const webhook = normalizeDiscordWebhook(rawWebhook);
  if (!webhook) throw new Error('DISCORD_WEBHOOK is missing or invalid.');

  let source;
  try {
    source = await readFile(statePath, 'utf8');
  } catch {
    throw new Error('Required monitor state could not be read.');
  }
  const state = parseObject(source, 'Monitor state');
  validateMonitorState(state);
  const repositoryVariables = parseObject(env.REPOSITORY_VARIABLES, 'REPOSITORY_VARIABLES');
  const variables = {};
  for (const name of MONITOR_VARIABLES) {
    if (!Object.hasOwn(repositoryVariables, name)) continue;
    if (typeof repositoryVariables[name] !== 'string') {
      throw new Error('Monitor variable values must be strings.');
    }
    variables[name] = repositoryVariables[name];
  }

  const metadata = {
    schemaVersion: 1,
    exportedAt: new Date(now()).toISOString(),
    repository: String(env.GITHUB_REPOSITORY || ''),
    runId: String(env.GITHUB_RUN_ID || ''),
    runAttempt: String(env.GITHUB_RUN_ATTEMPT || ''),
    commit: String(env.GITHUB_SHA || ''),
    productCount: Object.keys(state.knownProducts).length,
    encryption: 'RSA-OAEP-SHA256',
  };
  const jsonFiles = {
    'state.json': `${JSON.stringify(state, null, 2)}\n`,
    'variables.json': `${JSON.stringify(variables, null, 2)}\n`,
    'metadata.json': `${JSON.stringify(metadata, null, 2)}\n`,
  };
  for (const contents of Object.values(jsonFiles)) {
    if (contents.includes(rawWebhook) || contents.includes(webhook) ||
        /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\//i.test(contents)) {
      throw new Error('Export data contains a plaintext Discord webhook.');
    }
  }

  let encryptedWebhook;
  try {
    encryptedWebhook = publicEncrypt({
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, Buffer.from(webhook, 'utf8'));
  } catch {
    throw new Error('Webhook encryption failed. Check the migration public key size.');
  }

  // Validate and encrypt before any artifacts exist. A fresh directory prevents
  // stale files from a previous export being included in the uploaded artifact.
  await mkdir(outputDirectory, { mode: 0o700 });
  for (const [name, contents] of Object.entries(jsonFiles)) {
    await writeFile(resolve(outputDirectory, name), contents, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(resolve(outputDirectory, 'webhook.enc'), encryptedWebhook, { flag: 'wx', mode: 0o600 });
  return { directory: resolve(outputDirectory), productCount: metadata.productCount };
}

export function readMigrationPublicKey(value) {
  const pem = String(value || '').trim();
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n/.test(pem)) {
    throw new Error('MIGRATION_PUBLIC_KEY must contain an RSA public PEM key.');
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error('MIGRATION_PUBLIC_KEY is invalid.');
  }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new Error('MIGRATION_PUBLIC_KEY must be an RSA key of at least 2048 bits.');
  }
  return key;
}

function parseObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

export function validateMonitorState(state) {
  if (!isObject(state.knownProducts) || Object.keys(state.knownProducts).length === 0) {
    throw new Error('Monitor state must contain knownProducts entries.');
  }
  for (const [key, entry] of Object.entries(state.knownProducts)) {
    if (!/^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/i.test(key) || !isObject(entry) ||
        typeof entry.url !== 'string' || !entry.url ||
        (entry.styleColor !== undefined && String(entry.styleColor).toUpperCase() !== key.toUpperCase()) ||
        (entry.lastStockKey !== undefined && typeof entry.lastStockKey !== 'string')) {
      throw new Error('Monitor state contains an invalid product entry.');
    }
    try {
      const product = parseNikeProductUrl(entry.url, { styleColor: entry.styleColor || key });
      if (product.styleColor !== key.toUpperCase()) throw new Error();
    } catch {
      throw new Error('Monitor state contains an invalid Nike product URL.');
    }
  }
  for (const key of ['events', 'history', 'checkSamples']) {
    if (state[key] !== undefined && !Array.isArray(state[key])) {
      throw new Error('Monitor state contains invalid history data.');
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await createCloudflareExport();
    console.log(`Encrypted migration export prepared for ${result.productCount} products.`);
  } catch (error) {
    // All validation messages are fixed text; filesystem paths and key material
    // from underlying exceptions are never printed.
    const safeMessage = String(error?.message || '').replace(/https?:\/\/\S+/g, '[redacted]');
    console.error(`Cloudflare export failed: ${safeMessage}`);
    process.exitCode = 1;
  }
}
