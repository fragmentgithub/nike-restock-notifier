import test from 'node:test';
import assert from 'node:assert/strict';
import { githubHealthHeaders, CLOUDFLARE_HEALTH_URL } from '../scripts/github-health-auth.js';

test('watchdog requests only a short lived health identity and refuses arbitrary issuers', async () => {
  let requests = 0;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/identity',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only-request-token' };
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(url.origin, 'https://pipelines.actions.githubusercontent.com');
    assert.equal(url.searchParams.get('audience'), CLOUDFLARE_HEALTH_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer test-only-request-token');
    return Response.json({ value: 'test-only-health-identity' });
  };
  assert.deepEqual(await githubHealthHeaders({ env, fetchImpl }), { authorization: 'Bearer test-only-health-identity' });
  await assert.rejects(githubHealthHeaders({ env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://unknown.example/identity' }, fetchImpl }), /unavailable/);
  assert.equal(requests, 1);
});
