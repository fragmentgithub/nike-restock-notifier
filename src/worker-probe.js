import { checkNikeStock } from './nike.js';
import { DEFAULT_MIND_001_URLS, DEFAULT_FRAGMENT_PRODUCTS, DEFAULT_DISCOVERY_URL, discoverNikeMind001Products } from './discovery.js';
import { boundedFetch } from './worker-network.js';

export async function probeNike(target = 'mind') {
  const startedAt = Date.now();
  if (target === 'catalog') {
    const result = await discoverNikeMind001Products({ catalogUrl: DEFAULT_DISCOVERY_URL, fetchImpl: boundedFetch, timeoutMs: 20000 });
    return { target, durationMs: Date.now() - startedAt, ...result };
  }
  if (!['mind', 'fragment'].includes(target)) throw new Error('Unknown probe target');
  let product = DEFAULT_FRAGMENT_PRODUCTS[0];
  if (target === 'mind') {
    const catalog = await discoverNikeMind001Products({ catalogUrl: DEFAULT_DISCOVERY_URL, fetchImpl: boundedFetch, timeoutMs: 20000 });
    product = catalog.products?.[0] || { url: DEFAULT_MIND_001_URLS[0] };
  }
  const result = await checkNikeStock(product.url, { styleColor: product.styleColor, fetchImpl: boundedFetch, timeoutMs: 20000 });
  return { target, durationMs: Date.now() - startedAt, ...result };
}
