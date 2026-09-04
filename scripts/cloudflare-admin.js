import { readFile, writeFile } from 'node:fs/promises';

const DEFAULT_URL = 'https://nike-restock-notifier.only-this-moment.workers.dev';
const [command = 'health', argument, outputPath] = process.argv.slice(2);
const base = new URL(process.env.CLOUDFLARE_MONITOR_URL || DEFAULT_URL);
if (base.protocol !== 'https:' || base.username || base.password) throw new Error('An HTTPS Worker URL is required');
const token = String(process.env.ADMIN_TOKEN || await readFile('.cloudflare-migration/admin-token', 'utf8')).trim();
if (!token) throw new Error('ADMIN_TOKEN is required');
const routes = { health: 'health', status: 'status', trends: 'trends', state: 'state', mode: 'mode', probe: 'probe', import: 'import', credential: 'migration-credential', 'clear-credential': 'migration-credential' };
if (!routes[command]) throw new Error('Use health, state, mode, probe, or import');
let payload;
if (command === 'mode') {
  if (!['paused', 'shadow', 'active'].includes(argument)) throw new Error('Mode must be paused, shadow, or active');
  payload = { mode: argument };
}
if (command === 'probe') {
  if (!['mind', 'fragment', 'catalog'].includes(argument)) throw new Error('Probe target must be mind, fragment, or catalog');
  payload = { target: argument };
}
if (command === 'import') {
  if (!argument) throw new Error('Provide the exported artifact directory');
  const state = JSON.parse(await readFile(`${argument}/state.json`, 'utf8'));
  const vars = JSON.parse(await readFile(`${argument}/variables.json`, 'utf8'));
  const metadata = JSON.parse(await readFile(`${argument}/metadata.json`, 'utf8'));
  payload = { state, vars, migrationId: String(metadata.runId || metadata.exportedAt || metadata.createdAt || '') };
}
const requestUrl = new URL(`/admin/${routes[command]}`, base);
if (command === 'clear-credential') {
  if (!argument) throw new Error('Provide the migration ID to clear');
  requestUrl.searchParams.set('migrationId', argument);
}
const response = await fetch(requestUrl, {
  method: command === 'clear-credential' ? 'DELETE' : payload ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  body: payload ? JSON.stringify(payload) : undefined,
  signal: AbortSignal.timeout(command === 'mode' ? 180000 : 90000),
});
const result = await response.json();
if (!response.ok) {
  if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2));
  throw new Error(`Cloudflare admin request failed (${response.status}): ${JSON.stringify(result).slice(0,200)}`);
}
if (command === 'credential') {
  if (!argument) throw new Error('Encrypted credential export requires an output file path');
  await writeFile(argument, Buffer.from(result.encryptedWebhook, 'base64'));
  console.log('Encrypted migration credential downloaded.');
} else if (command === 'state' || command === 'status' || command === 'trends') {
  if (!argument) throw new Error('State export requires an output file path');
  await writeFile(argument, JSON.stringify(result, null, 2));
  console.log('Private monitor state exported.');
} else if (outputPath) {
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log('Result saved.');
} else {
  console.log(JSON.stringify(result, null, 2));
}
