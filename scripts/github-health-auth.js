export const CLOUDFLARE_HEALTH_URL = 'https://nike-restock-notifier.only-this-moment.workers.dev/healthz';

// GitHub already authenticates this job; no persistent Cloudflare key is stored in GitHub.
export async function githubHealthHeaders({ env = process.env, fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); }
  catch { throw new Error('GitHub identity is unavailable.'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com') ||
      url.username || url.password || url.port || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('GitHub identity is unavailable.');
  }
  url.searchParams.set('audience', CLOUDFLARE_HEALTH_URL);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub identity request failed.');
  const { value } = await response.json();
  if (typeof value !== 'string' || !value || value.length > 16384) throw new Error('GitHub identity is invalid.');
  return { authorization: `Bearer ${value}` };
}
