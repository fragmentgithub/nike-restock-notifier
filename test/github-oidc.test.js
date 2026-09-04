import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubOidcVerifier, GITHUB_MIGRATION_TRUST as TRUST, GITHUB_HEALTH_TRUST } from '../src/github-oidc.js';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const seconds = NOW / 1000;
const keys = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
}, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'local-test-key', use: 'sig', alg: 'RS256' };

function claims(overrides = {}) {
  return {
    iss: TRUST.issuer, aud: TRUST.audience,
    repository: TRUST.repository, repository_id: TRUST.repositoryId,
    repository_owner: TRUST.owner, repository_owner_id: TRUST.ownerId,
    workflow_ref: TRUST.workflowRef, ref: TRUST.ref, ref_type: 'branch',
    event_name: 'workflow_dispatch', sub: `repo:${TRUST.repository}:ref:${TRUST.ref}`,
    run_id: '33895000001', run_attempt: '1', jti: 'local-test-jti-1234',
    iat: seconds - 30, nbf: seconds - 60, exp: seconds + 270,
    ...overrides,
  };
}

async function sign(payload = claims(), header = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function verifier(options = {}) {
  return createGitHubOidcVerifier({
    now: () => NOW,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
      assert.equal(request.redirect, 'manual');
      assert.deepEqual(request.headers, { accept: 'application/json' });
      return Response.json({ keys: [jwk] });
    },
    ...options,
  });
}

test('a signed JWT for the pinned workflow grants only its run-bound migration identity', async () => {
  const verify = verifier();
  assert.deepEqual(await verify(await sign()), {
    runId: '33895000001', runAttempt: '1', migrationId: '33895000001:1',
  });
  const immutable = `repo:${TRUST.owner}@${TRUST.ownerId}/nike-restock-notifier@${TRUST.repositoryId}:ref:${TRUST.ref}`;
  assert.ok(await verify(await sign(claims({ sub: immutable }))));
});

test('health identity accepts only the pinned watchdog and cannot authorize migration', async () => {
  const health = verifier({ trust: GITHUB_HEALTH_TRUST });
  for (const event_name of ['schedule', 'workflow_dispatch']) {
    const token = await sign(claims({ workflow_ref: GITHUB_HEALTH_TRUST.workflowRef,
      aud: GITHUB_HEALTH_TRUST.audience, event_name }));
    assert.ok(await health(token));
    assert.equal(await verifier()(token), null);
  }
  assert.equal(await health(await sign()), null);
  assert.equal(await health(await sign(claims({ workflow_ref: GITHUB_HEALTH_TRUST.workflowRef,
    aud: GITHUB_HEALTH_TRUST.audience, event_name: 'pull_request' }))), null);
});

test('repository, immutable IDs, workflow, branch, trigger, issuer, audience and subject must all match', async () => {
  let fetches = 0;
  const verify = verifier({ fetchImpl: async () => { fetches++; throw new Error('must not fetch'); } });
  const cases = [
    { iss: 'https://attacker.test' }, { aud: 'https://other.workers.dev' }, { aud: [TRUST.audience] },
    { repository: 'attacker/nike-restock-notifier' }, { repository_id: '98765' },
    { repository_owner: 'attacker' }, { repository_owner_id: '98765' },
    { workflow_ref: TRUST.workflowRef.replace('cloudflare-transfer.yml', 'other.yml') },
    { workflow_ref: TRUST.workflowRef.replace('main', 'untrusted') },
    { ref: 'refs/heads/untrusted' }, { ref_type: 'tag' }, { event_name: 'pull_request' },
    { sub: `repo:${TRUST.repository}:pull_request` }, { sub: 'repo:another/repo:ref:refs/heads/main' },
    { run_id: '01' }, { run_attempt: '-1' }, { run_id: 123 }, { jti: '' },
  ];
  for (const changed of cases) assert.equal(await verify(await sign(claims(changed))), null, JSON.stringify(changed));
  assert.equal(fetches, 0);
});

test('expiry, not-before, issue time, lifetime and clock skew are bounded', async () => {
  const verify = verifier();
  const cases = [
    { exp: seconds - 61 }, { nbf: seconds + 61 }, { iat: seconds + 61 },
    { iat: seconds - 901 }, { exp: seconds + 901 }, { exp: 'future' },
    { nbf: undefined }, { iat: null }, { exp: 0 }, { nbf: seconds + 999 },
  ];
  for (const changed of cases) assert.equal(await verify(await sign(claims(changed))), null);
  assert.ok(await verify(await sign(claims({ iat: seconds - 120, nbf: seconds - 120, exp: seconds - 30 }))));
});

test('signature tampering, unsupported headers and malformed or oversized JWTs fail closed', async () => {
  const verify = verifier();
  const signed = await sign();
  const segments = signed.split('.');
  segments[1] = Buffer.from(JSON.stringify(claims({ run_id: '99999999999' }))).toString('base64url');
  assert.equal(await verify(segments.join('.')), null);
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { typ: 'JWE' }, { kid: '../key' },
    { crit: ['custom'] }, { jku: 'https://attacker.test/keys' }, { jwk }, { x5u: 'https://attacker.test/cert' }]) {
    assert.equal(await verify(await sign(claims(), header)), null);
  }
  for (const token of ['', 'a.b.c', 'a.b', 'a'.repeat(16385), `${signed}=`, null]) {
    assert.equal(await verify(token), null);
  }
});

test('JWKS fetch is cached, refreshes for a rotated key, and never receives a bearer credential', async () => {
  let currentTime = NOW;
  let fetches = 0;
  const verify = verifier({
    now: () => currentTime,
    fetchImpl: async (_url, request) => {
      fetches++;
      assert.equal(request.headers.authorization, undefined);
      return Response.json({ keys: [{ ...jwk, kid: fetches === 1 ? jwk.kid : 'rotated-key' }] });
    },
  });
  assert.ok(await verify(await sign()));
  assert.ok(await verify(await sign()));
  assert.equal(fetches, 1);
  assert.equal(await verify(await sign(claims(), { kid: 'unknown-key' })), null);
  assert.equal(fetches, 1);
  currentTime += 31000;
  assert.ok(await verify(await sign(claims(), { kid: 'rotated-key' })));
  assert.equal(fetches, 2);
});

test('JWKS network, size, malformed-key and response errors produce only authentication failure', async () => {
  const token = await sign();
  const responses = [
    () => { throw new Error('private network error'); },
    () => new Response('not json'),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.test/jwks' } }),
    () => new Response('x'.repeat(65537)),
    () => Response.json({ keys: [{ ...jwk, kty: 'oct' }] }),
    () => Response.json({ keys: [jwk, jwk] }),
  ];
  for (const response of responses) assert.equal(await verifier({ fetchImpl: response })(token), null);
});
