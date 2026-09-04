// GitHub's issuer metadata and claim reference:
// https://token.actions.githubusercontent.com/.well-known/openid-configuration
// https://docs.github.com/en/actions/reference/security/oidc
export const GITHUB_MIGRATION_TRUST = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'https://nike-restock-notifier.only-this-moment.workers.dev',
  repository: 'fragmentgithub/nike-restock-notifier',
  repositoryId: '1292467518',
  owner: 'fragmentgithub',
  ownerId: '75737556',
  workflowRef: 'fragmentgithub/nike-restock-notifier/.github/workflows/cloudflare-transfer.yml@refs/heads/main',
  ref: 'refs/heads/main',
  events: ['workflow_dispatch'],
});
export const GITHUB_HEALTH_TRUST = Object.freeze({
  ...GITHUB_MIGRATION_TRUST,
  audience: 'https://nike-restock-notifier.only-this-moment.workers.dev/healthz',
  workflowRef: 'fragmentgithub/nike-restock-notifier/.github/workflows/health.yml@refs/heads/main',
  events: ['workflow_dispatch', 'schedule'],
});
const JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const MAX_TOKEN_BYTES = 16384;
const MAX_JWKS_BYTES = 65536;
const CLOCK_SKEW_SECONDS = 60;

/** Only the named manual workflow receives the narrow migration permission. */
export function createGitHubOidcVerifier({ fetchImpl = fetch, now = Date.now, trust = GITHUB_MIGRATION_TRUST } = {}) {
  let cache;
  let refreshing;

  async function loadKeys(force = false) {
    const timestamp = now();
    if (cache && cache.expiresAt > timestamp && !force) return cache.keys;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let reader;
      try {
        const response = await fetchImpl(JWKS_URL, {
          headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
        });
        if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_JWKS_BYTES) {
          await response.body?.cancel();
          throw new Error('OIDC verification unavailable');
        }
        reader = response.body.getReader();
        const chunks = [];
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_JWKS_BYTES) { await reader.cancel(); throw new Error('OIDC verification unavailable'); }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        const jwks = JSON.parse(chunks.join(''));
        if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 32) {
          throw new Error('OIDC verification unavailable');
        }
        const keys = new Map();
        for (const key of jwks.keys) {
          if (key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' ||
              typeof key.kid !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(key.kid) ||
              typeof key.n !== 'string' || !/^[A-Za-z0-9_-]{256,1400}$/.test(key.n) ||
              typeof key.e !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(key.e) || keys.has(key.kid)) {
            throw new Error('OIDC verification unavailable');
          }
          keys.set(key.kid, await crypto.subtle.importKey('jwk', {
            kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true, key_ops: ['verify'],
          }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        }
        cache = { keys, fetchedAt: now(), expiresAt: now() + 300000 };
        return keys;
      } finally { clearTimeout(timer); reader?.releaseLock(); }
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  return async function verify(token) {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) return null;
      const segments = token.split('.');
      if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
      const [head, body, signature] = segments;
      if (head.length > 2048 || signature.length > 2048) return null;
      const header = decodeJson(head);
      const claims = decodeJson(body);
      if (!header || header.alg !== 'RS256' || header.typ !== 'JWT' ||
          typeof header.kid !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid) ||
          header.crit !== undefined || header.b64 !== undefined || header.jku !== undefined ||
          header.jwk !== undefined || header.x5u !== undefined || !validClaims(claims, now(), trust)) return null;
      let key = (await loadKeys()).get(header.kid);
      // Permit key rotation while bounding forced refreshes caused by unknown kids.
      if (!key && cache && now() - cache.fetchedAt >= 30000) key = (await loadKeys(true)).get(header.kid);
      if (!key) return null;
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', key, decodeBytes(signature), new TextEncoder().encode(`${head}.${body}`),
      );
      if (!valid || !validClaims(claims, now(), trust)) return null;
      // Never pass the bearer token, raw JWT, or unnecessary identity claims downstream.
      return { runId: claims.run_id, runAttempt: claims.run_attempt, migrationId: `${claims.run_id}:${claims.run_attempt}` };
    } catch { return null; }
  };
}

export const verifyGitHubOidc = createGitHubOidcVerifier();
export const verifyGitHubHealthOidc = createGitHubOidcVerifier({ trust: GITHUB_HEALTH_TRUST });

function validClaims(claims, timestamp, trust) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return false;
  if (claims.iss !== trust.issuer || claims.aud !== trust.audience ||
      claims.repository !== trust.repository || claims.repository_id !== trust.repositoryId ||
      claims.repository_owner !== trust.owner || claims.repository_owner_id !== trust.ownerId ||
      claims.workflow_ref !== trust.workflowRef || claims.ref !== trust.ref ||
      !trust.events.includes(claims.event_name) || claims.ref_type !== 'branch') return false;
  const subjects = [
    `repo:${trust.repository}:ref:${trust.ref}`,
    `repo:${trust.owner}@${trust.ownerId}/nike-restock-notifier@${trust.repositoryId}:ref:${trust.ref}`,
  ];
  if (!subjects.includes(claims.sub) || typeof claims.jti !== 'string' || claims.jti.length < 8 || claims.jti.length > 256 ||
      typeof claims.run_id !== 'string' || !/^[1-9][0-9]{0,29}$/.test(claims.run_id) ||
      typeof claims.run_attempt !== 'string' || !/^[1-9][0-9]{0,7}$/.test(claims.run_attempt)) return false;
  if (![claims.exp, claims.iat, claims.nbf].every((value) => Number.isSafeInteger(value) && value > 0)) return false;
  const seconds = Math.floor(timestamp / 1000);
  return claims.exp > seconds - CLOCK_SKEW_SECONDS && claims.exp > claims.iat &&
    claims.exp - claims.iat <= 900 && claims.iat >= seconds - 900 &&
    claims.iat <= seconds + CLOCK_SKEW_SECONDS && claims.nbf <= seconds + CLOCK_SKEW_SECONDS &&
    claims.nbf <= claims.exp;
}

function decodeBytes(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function decodeJson(text) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBytes(text))); }
