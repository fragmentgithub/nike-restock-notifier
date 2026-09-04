import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudflareExport } from '../scripts/export-cloudflare-state.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const WEBHOOK = 'https://discord.com/api/webhooks/123456/fake-migration-test-token';
const STATE = {
  knownProducts: {
    'HQ4307-005': {
      styleColor: 'HQ4307-005',
      url: 'https://www.nike.com/jp/t/nike-mind-001/HQ4307-005',
      lastStockKey: '26|27',
      oosStreak: 1,
    },
  },
  events: [], history: [], checkSamples: [],
};

async function fixture(t, state = STATE) {
  const directory = await mkdtemp(join(tmpdir(), 'nike-cloudflare-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify(state));
  return {
    directory,
    options: {
      statePath,
      outputDirectory: join(directory, 'export'),
      now: () => new Date('2026-09-04T00:00:00Z'),
      env: {
        MIGRATION_PUBLIC_KEY: publicPem,
        DISCORD_WEBHOOK: WEBHOOK,
        REPOSITORY_VARIABLES: JSON.stringify({
          SIZE_FILTERS: '26,27',
          INTERVAL_SECONDS: '120',
          PRODUCT_CONFIG_JSON: '{"HQ4307-005":{"notify":true}}',
          CLOUDFLARE_MIGRATION_PUBLIC_KEY: publicPem,
          DISCORD_WEBHOOK: WEBHOOK,
          UNKNOWN: WEBHOOK,
        }),
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: 'abc123',
      },
    },
  };
}

test('export preserves notification state, filters variables, and encrypts webhook without plaintext artifacts', async (t) => {
  const { options } = await fixture(t);
  const result = await createCloudflareExport(options);
  assert.equal(result.productCount, 1);
  const names = await readdir(options.outputDirectory);
  assert.deepEqual(names.sort(), ['metadata.json', 'state.json', 'variables.json', 'webhook.enc']);
  for (const name of names) {
    const contents = await readFile(join(options.outputDirectory, name));
    assert.equal(contents.includes(Buffer.from(WEBHOOK)), false);
    assert.equal(contents.includes(Buffer.from('fake-migration-test-token')), false);
  }
  const state = JSON.parse(await readFile(join(options.outputDirectory, 'state.json'), 'utf8'));
  assert.deepEqual(state, STATE);
  const variables = JSON.parse(await readFile(join(options.outputDirectory, 'variables.json'), 'utf8'));
  assert.deepEqual(variables, {
    SIZE_FILTERS: '26,27',
    INTERVAL_SECONDS: '120',
    PRODUCT_CONFIG_JSON: '{"HQ4307-005":{"notify":true}}',
  });
  const decrypted = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, await readFile(join(options.outputDirectory, 'webhook.enc')));
  assert.equal(decrypted.toString('utf8'), WEBHOOK);
  const metadata = JSON.parse(await readFile(join(options.outputDirectory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.runId, '123');
  assert.equal(metadata.exportedAt, '2026-09-04T00:00:00.000Z');
  assert.equal(metadata.encryption, 'RSA-OAEP-SHA256');
});

test('missing and invalid key, secret, variables, or cache fails before creating artifacts', async (t) => {
  const cases = [
    { name: 'missing public key', env: { MIGRATION_PUBLIC_KEY: '' } },
    { name: 'invalid public key', env: { MIGRATION_PUBLIC_KEY: 'invalid' } },
    { name: 'malformed public PEM', env: { MIGRATION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\ninvalid' } },
    { name: 'private key supplied', env: { MIGRATION_PUBLIC_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) } },
    { name: 'missing secret', env: { DISCORD_WEBHOOK: '' } },
    { name: 'invalid secret', env: { DISCORD_WEBHOOK: 'not-a-webhook' } },
    { name: 'missing variables', env: { REPOSITORY_VARIABLES: undefined } },
    { name: 'invalid variables', env: { REPOSITORY_VARIABLES: '{invalid' } },
    { name: 'variables array', env: { REPOSITORY_VARIABLES: '[]' } },
    { name: 'nonstring variable', env: { REPOSITORY_VARIABLES: '{"SIZE_FILTERS":false}' } },
    { name: 'missing cache', removeSource: true },
    { name: 'malformed cache', source: '{invalid' },
    { name: 'missing products', source: '{}' },
    { name: 'empty products', source: '{"knownProducts":{}}' },
    { name: 'array products', source: '{"knownProducts":[]}' },
    { name: 'invalid entry', source: '{"knownProducts":{"HQ4307-005":null}}' },
    { name: 'invalid product URL', source: JSON.stringify({ knownProducts: { 'HQ4307-005': { url: 'https://example.com/HQ4307-005' } } }) },
    { name: 'mismatched product URL', source: JSON.stringify({ knownProducts: { 'HQ4307-005': { url: 'https://www.nike.com/jp/t/nike/HQ4307-003' } } }) },
    { name: 'invalid notification state', source: JSON.stringify({ knownProducts: { 'HQ4307-005': { ...STATE.knownProducts['HQ4307-005'], lastStockKey: {} } } }) },
    { name: 'plaintext webhook in cache', source: JSON.stringify({ ...STATE, lastError: WEBHOOK }) },
    { name: 'plaintext webhook in allowed variable', env: { REPOSITORY_VARIABLES: JSON.stringify({ PRODUCT_URL: WEBHOOK }) } },
  ];
  for (const invalid of cases) {
    await t.test(invalid.name, async (t) => {
      const { directory, options } = await fixture(t);
      Object.assign(options.env, invalid.env);
      if (invalid.removeSource) await rm(options.statePath);
      if (invalid.source) await writeFile(options.statePath, invalid.source);
      await assert.rejects(createCloudflareExport(options), (error) => {
        assert.equal(error.message.includes(WEBHOOK), false);
        return true;
      });
      assert.equal((await readdir(directory)).includes('export'), false);
    });
  }
});

test('a pre-existing export directory is rejected so unrelated files cannot be uploaded', async (t) => {
  const { options } = await fixture(t);
  await createCloudflareExport(options);
  await assert.rejects(createCloudflareExport(options), { code: 'EEXIST' });
});
