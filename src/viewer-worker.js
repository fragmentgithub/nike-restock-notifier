import { VIEWER_ASSETS } from '../.viewer-build/assets.js';

const PRIVATE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
});

export default {
  async fetch(request, env, ctx) {
    // Only the runtime-provided Access context is trusted; caller-supplied
    // identity headers and cookies cannot authorize this Worker.
    if (!await allowedViewer(env, ctx)) return reply(request, 'Unauthorized', 401);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply(request, 'Method not allowed', 405, { allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/status.json') {
        return jsonReply(request, await env.MONITOR_VIEWER.getStatus());
      }
      if (url.pathname === '/api/trends') {
        const options = trendOptions(url.searchParams);
        if (!options) return reply(request, 'Invalid trend filters', 400);
        return jsonReply(request, await env.MONITOR_VIEWER.getTrends(options));
      }
      const assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
      if (Object.hasOwn(VIEWER_ASSETS, assetPath)) {
        const asset = VIEWER_ASSETS[assetPath];
        return reply(request, asset.body, 200, { 'content-type': asset.contentType });
      }
      return reply(request, 'Not found', 404);
    } catch {
      // RPC or configuration errors must not expose internal state or credentials.
      return reply(request, 'Temporarily unavailable', 503);
    }
  },
};

async function allowedViewer(env, ctx) {
  try {
    const audience = typeof env.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
    const email = typeof env.VIEWER_EMAIL === 'string' ? env.VIEWER_EMAIL.trim().toLowerCase() : '';
    if (!audience || !email || !ctx?.access || ctx.access.aud !== audience) return false;
    const identity = await ctx.access.getIdentity();
    return typeof identity?.email === 'string' && identity.email.toLowerCase() === email;
  } catch {
    return false;
  }
}

function trendOptions(params) {
  if ([...params.keys()].some((key) => key !== 'days' && key !== 'styleColor')) return null;
  if (params.getAll('days').length > 1 || params.getAll('styleColor').length > 1) return null;
  const days = params.get('days') ?? 'all';
  const product = params.get('styleColor') ?? 'all';
  const styleColor = product === 'all' ? 'all' : product.toUpperCase();
  if (!['all', '7', '30', '90', '365', '730'].includes(days)) return null;
  if (styleColor !== 'all' && !/^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/.test(styleColor)) return null;
  return { days: days === 'all' ? 'all' : Number(days), styleColor };
}

function jsonReply(request, data) {
  if (data === undefined) throw new Error('Missing viewer data');
  return reply(request, JSON.stringify(data), 200, { 'content-type': 'application/json; charset=utf-8' });
}

function reply(request, body, status, headers = {}) {
  return new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers, ...PRIVATE_HEADERS },
  });
}
