const STYLE_COLOR_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/i;
const MIND_001_PATTERN = /nike\s*mind[\s\u00a0]*001/i;

const DISCOVERY_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

export const DEFAULT_DISCOVERY_URL = 'https://www.nike.com/jp/w/nike-mind-shoes-a60iizy7ok';

export const DEFAULT_MIND_001_URLS = [
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-OtHAj1G8/HQ4307-001',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-003',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-UMBfsYYs/HQ4307-200',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-Rq84j0JD/HQ4307-300',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-Z6Ec8rYA/HQ4309-001',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-slikdOGA/HQ4309-400',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-Z6Ec8rYA/HQ4309-601',
];

export async function discoverNikeMind001Products(options = {}) {
  const catalogUrl = options.catalogUrl || DEFAULT_DISCOVERY_URL;
  const timeoutMs = options.timeoutMs || 20000;
  const fetchImpl = options.fetchImpl || fetch;

  try {
    const response = await fetchWithTimeout(fetchImpl, catalogUrl, {
      headers: DISCOVERY_HEADERS,
      timeoutMs,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const products = extractNikeMind001Products(html, catalogUrl);
    if (products.length === 0) {
      throw new Error('Nike公式一覧からMind 001を1件も検出できませんでした');
    }
    return {
      products,
      sourceUrl: catalogUrl,
      error: null,
    };
  } catch (error) {
    return {
      products: [],
      sourceUrl: catalogUrl,
      error: error.message || String(error),
    };
  }
}

export function extractNikeMind001Products(html, sourceUrl = 'https://www.nike.com/jp/') {
  const found = new Map();
  const normalizedHtml = normalizeEscapedHtml(html);

  const linkPattern = /((?:https?:\/\/www\.nike\.com)?\/jp\/(?:[a-z]{2}\/)?t\/[^"'<>\\\s]*mind-001[^"'<>\\\s]*\/([A-Z0-9]{5,8}-[A-Z0-9]{3}))/gi;
  for (const match of normalizedHtml.matchAll(linkPattern)) {
    addProduct(found, {
      styleColor: match[2],
      url: match[1],
    }, sourceUrl);
  }

  const nextData = parseNextData(normalizedHtml);
  if (nextData) collectProductsFromValue(nextData, found, sourceUrl);

  return [...found.values()].sort((a, b) => a.styleColor.localeCompare(b.styleColor));
}

function collectProductsFromValue(value, found, sourceUrl) {
  if (Array.isArray(value)) {
    for (const item of value) collectProductsFromValue(item, found, sourceUrl);
    return;
  }

  if (!value || typeof value !== 'object') return;

  const styleColor = firstPresent([
    value.styleColor,
    value.merchProduct?.styleColor,
    value.productInfo?.styleColor,
  ]);
  const contextText = [
    value.title,
    value.fullTitle,
    value.labelName,
    value.slug,
    value.pdpUrl,
    value.url,
    value.productInfo?.title,
    value.productInfo?.fullTitle,
    value.productInfo?.url,
    value.productContent?.title,
    value.productContent?.fullTitle,
    value.merchProduct?.labelName,
  ]
    .filter(Boolean)
    .join(' ');

  if (STYLE_COLOR_PATTERN.test(String(styleColor || '')) && MIND_001_PATTERN.test(contextText)) {
    addProduct(found, {
      styleColor,
      url: firstPresent([
        value.pdpUrl,
        value.url,
        value.productInfo?.url,
        value.productContent?.url,
      ]),
    }, sourceUrl);
  }

  for (const child of Object.values(value)) {
    collectProductsFromValue(child, found, sourceUrl);
  }
}

function addProduct(found, product, sourceUrl) {
  const styleColor = String(product.styleColor || '').toUpperCase();
  if (!STYLE_COLOR_PATTERN.test(styleColor)) return;

  const url = productUrl(product.url, styleColor, sourceUrl);
  const previous = found.get(styleColor);
  found.set(styleColor, {
    styleColor,
    url: previous?.url?.includes(styleColor) ? previous.url : url,
  });
}

function productUrl(value, styleColor, sourceUrl) {
  try {
    const url = new URL(value || `/jp/t/nike-mind-001/${styleColor}`, sourceUrl);
    if (!url.pathname.toUpperCase().includes(styleColor)) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${styleColor}`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `https://www.nike.com/jp/t/nike-mind-001/${styleColor}`;
  }
}

function normalizeEscapedHtml(value) {
  return String(value || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseNextData(html) {
  const idIndex = html.indexOf('__NEXT_DATA__');
  if (idIndex === -1) return null;

  const scriptStart = html.lastIndexOf('<script', idIndex);
  const jsonStart = html.indexOf('>', scriptStart) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (scriptStart === -1 || jsonStart === 0 || jsonEnd === -1) return null;

  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await fetchImpl(url, {
      headers: options.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function firstPresent(values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
}
