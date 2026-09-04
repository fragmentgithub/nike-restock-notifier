import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDirectTransfer, transferToCloudflare, MIGRATION_DESTINATION } from '../scripts/transfer-cloudflare-state.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const webhook = 'https://discord.com/api/webhooks/123456/testing-only-token';
const state = { knownProducts: { 'HQ4307-001': {
  styleColor: 'HQ4307-001', url: 'https://www.nike.com/jp/t/mind/HQ4307-001', lastStockKey: '27',
} }, checkSamples: [] };
const env = {
  GITHUB_REPOSITORY: 'fragmentgithub/nike-restock-notifier', GITHUB_RUN_ID: '12345678', GITHUB_RUN_ATTEMPT: '1',
  MIGRATION_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  DISCORD_WEBHOOK: webhook, REPOSITORY_VARIABLES: JSON.stringify({ INTERVAL_SECONDS: '120', RANDOM_SECRET: 'exclude-me' }),
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/test/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-job-test-only',
};

test('direct transfer encrypts credentials in memory and preserves notification state', () => {
  const payload = prepareDirectTransfer(state, env);
  assert.equal(payload.migrationId, '12345678:1');
  assert.equal(payload.state.knownProducts['HQ4307-001'].lastStockKey, '27');
  assert.deepEqual(payload.vars, { INTERVAL_SECONDS: '120' });
  assert.ok(!JSON.stringify(payload).includes(webhook));
  assert.ok(!JSON.stringify(payload).includes('exclude-me'));
  const decoded = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(payload.encryptedWebhook, 'base64'));
  assert.equal(decoded.toString(), webhook);
  assert.throws(() => prepareDirectTransfer(state, { ...env, GITHUB_REPOSITORY: 'someone/else' }), /configured GitHub/);
  assert.throws(() => prepareDirectTransfer({ ...state, secret: webhook }, env), /plaintext/);
});

test('workflow sends only to GitHub identity service and authorized Cloudflare target, with no new artifacts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nike-direct-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify(state));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      assert.equal(new URL(url).hostname, 'pipelines.actions.githubusercontent.com');
      assert.equal(new URL(url).searchParams.get('audience'), MIGRATION_DESTINATION);
      return Response.json({ value: 'signed-oidc-test-token' });
    }
    assert.equal(String(url), `${MIGRATION_DESTINATION}/migration/transfer`);
    assert.equal(options.headers.authorization, 'Bearer signed-oidc-test-token');
    assert.equal(options.redirect, 'error');
    assert.ok(!options.body.includes(webhook));
    return Response.json({ imported: true, products: 1 });
  };
  assert.deepEqual(await transferToCloudflare({ statePath, env, fetchImpl }), { migrationId: '12345678:1', imported: true, products: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(await readdir(directory), ['state.json']);
  await assert.rejects(transferToCloudflare({ statePath, env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://untrusted.example/oidc' }, fetchImpl }), /Unexpected GitHub/);
  assert.equal(calls.length, 2);
});
