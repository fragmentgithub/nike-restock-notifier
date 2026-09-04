import { fetchWithTimeout, firstPresent, parseNextData } from './util.js';

const STYLE_COLOR_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/i;
// \u30cf\u30a4\u30d5\u30f3\u3082\u8a31\u5bb9\u3059\u308b\uff08URL/slug \u306e "nike-mind-001" \u8868\u8a18\u3092\u53d6\u308a\u3053\u307c\u3055\u306a\u3044\u305f\u3081\uff09\u3002
const MIND_001_PATTERN = /nike[\s\-\u00a0]*mind[\s\-\u00a0]*001/i;
const FRAGMENT_PATTERN = /(?:fragment|\u30d5\u30e9\u30b0\u30e1\u30f3\u30c8)/i;
const WOMENS_TEXT_PATTERN = /(?:women(?:'s|s)?|\u30a6\u30a3\u30e1\u30f3\u30ba|\u30a6\u30a4\u30e1\u30f3\u30ba|\u30ec\u30c7\u30a3\u30fc\u30b9)/i;
const WOMENS_STYLE_COLOR_PATTERN = /^HQ4309-/i;

const DISCOVERY_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

export const DEFAULT_DISCOVERY_URL = 'https://www.nike.com/jp/w/nike-mind-shoes-a60iizy7ok';
export const DEFAULT_FRAGMENT_DISCOVERY_URLS = [
  'https://www.nike.com/jp/launch',
  'https://www.nike.com/jp/launch?s=upcoming',
  'https://www.nike.com/jp/launch?s=in-stock',
];

export const DEFAULT_MIND_001_URLS = [
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-OtHAj1G8/HQ4307-001',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-003',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-8cpWgYfX/HQ4307-005',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-UMBfsYYs/HQ4307-200',
  'https://www.nike.com/jp/t/nike-mind-001-%E3%83%97%E3%83%AC%E3%82%B2%E3%83%BC%E3%83%A0%E2%81%A0-%E3%83%9F%E3%83%A5%E3%83%BC%E3%83%AB-Rq84j0JD/HQ4307-300',
];

export const DEFAULT_FRAGMENT_PRODUCTS = [
  {
    styleColor: 'IQ8502-001',
    url: 'https://www.nike.com/jp/launch/t/mind-001-fragment-black',
  },
  {
    styleColor: 'IQ8504-002',
    url: 'https://www.nike.com/jp/launch/t/mind-002-fragment-black',
  },
];

export function isWomensNikeProduct(product = {}) {
  const urlText = String(product.url || '');
  const styleColor = String(
    product.styleColor || urlText.match(/\/([A-Z0-9]{5,8}-[A-Z0-9]{3})(?:[/?#]|$)/i)?.[1] || '',
  ).toUpperCase();
  if (WOMENS_STYLE_COLOR_PATTERN.test(styleColor)) return true;

  const genders = Array.isArray(product.genders)
    ? product.genders.map((value) => String(value).toUpperCase())
    : [];
  if (
    genders.some((value) => /^WOM/.test(value)) &&
    !genders.some((value) => /^(?:MEN|MALE|UNISEX)$/.test(value))
  ) return true;

  const text = [
    urlText,
    product.title,
    product.fullTitle,
    product.subtitle,
    product.labelName,
    product.contextText,
  ]
    .filter(Boolean)
    .map(decodeText)
    .join(' ');
  return WOMENS_TEXT_PATTERN.test(text);
}

export const isWomensNikeMind001Product = isWomensNikeProduct;

export async function discoverNikeMind001Products(options = {}) {
  const catalogUrl = options.catalogUrl || DEFAULT_DISCOVERY_URL;
  const timeoutMs = options.timeoutMs || 20000;
  const fetchImpl = options.fetchImpl || fetch;

  try {
    const response = await fetchWithTimeout(catalogUrl, {
      headers: DISCOVERY_HEADERS,
      timeoutMs,
      fetchImpl,
    });

    if (!response.ok) {
      await response.body?.cancel();
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

export async function discoverNikeFragmentProducts(options = {}) {
  const catalogUrls = Array.isArray(options.catalogUrls) && options.catalogUrls.length
    ? options.catalogUrls
    : DEFAULT_FRAGMENT_DISCOVERY_URLS;
  const timeoutMs = options.timeoutMs || 20000;
  const fetchImpl = options.fetchImpl || fetch;
  const found = new Map();
  const errors = [];
  let successfulSources = 0;

  for (const catalogUrl of catalogUrls) {
    try {
      const response = await fetchWithTimeout(catalogUrl, {
        headers: DISCOVERY_HEADERS,
        timeoutMs,
        fetchImpl,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const catalog = parseNikeFragmentCatalog(await response.text(), catalogUrl);
      if (!catalog.parseable) {
        throw new Error('Nike SNKRS一覧のカタログ構造を解析できませんでした');
      }
      for (const product of catalog.products) found.set(product.styleColor, product);
      successfulSources += 1;
    } catch (error) {
      errors.push(`${catalogUrl}: ${error.message || String(error)}`);
    }
  }

  return {
    products: [...found.values()].sort((a, b) => a.styleColor.localeCompare(b.styleColor)),
    sourceUrls: catalogUrls,
    error: successfulSources === 0 ? errors.join(' / ') || 'Fragment商品一覧を取得できませんでした' : null,
    warnings: errors,
  };
}

export function extractNikeFragmentProducts(html, sourceUrl = 'https://www.nike.com/jp/launch') {
  return parseNikeFragmentCatalog(html, sourceUrl).products;
}

function parseNikeFragmentCatalog(html, sourceUrl) {
  const found = new Map();
  const nextData = parseNextData(normalizeEscapedHtml(html));
  const initialState = parseInitialState(nextData?.props?.pageProps?.initialState);
  const threadItems = initialState?.product?.threads?.data?.items;
  const rawProductItems = initialState?.product?.products?.data?.items;
  const parseable = isCatalogItemCollection(threadItems) &&
    isCatalogItemCollection(rawProductItems);
  if (!parseable) return { products: [], parseable: false };

  const threads = Object.values(threadItems);
  const productItems = Object.values(rawProductItems);
  const productsByStyleColor = new Map(productItems.map((product) => [
    String(product?.styleColor || '').toUpperCase(),
    product,
  ]));

  for (const thread of threads) {
    const contextText = JSON.stringify(thread || {});
    if (!FRAGMENT_PATTERN.test(decodeText(contextText))) continue;

    const slug = thread?.seo?.slug;
    const launchUrl = slug
      ? new URL(`/jp/launch/t/${slug}`, sourceUrl).toString()
      : sourceUrl;
    const styleColors = new Set(
      [...contextText.matchAll(/[A-Z0-9]{5,8}-[A-Z0-9]{3}/gi)]
        .map((match) => match[0].toUpperCase()),
    );

    for (const styleColor of styleColors) {
      const details = productsByStyleColor.get(styleColor);
      if (!details) continue;
      const product = {
        styleColor,
        url: launchUrl,
        title: thread?.coverCard?.subtitle || details.title,
        subtitle: details.subtitle,
        genders: details.genders,
        contextText,
      };
      if (!isWomensNikeProduct(product)) {
        found.set(styleColor, { styleColor, url: launchUrl });
      }
    }
  }

  return {
    products: [...found.values()].sort((a, b) => a.styleColor.localeCompare(b.styleColor)),
    parseable: true,
  };
}

export function extractNikeMind001Products(html, sourceUrl = 'https://www.nike.com/jp/', { nextData: parsedNextData } = {}) {
  const found = new Map();
  const excludedStyleColors = new Set();
  const normalizedHtml = normalizeEscapedHtml(html);

  const nextData = parsedNextData || parseNextData(normalizedHtml);
  if (nextData) collectProductsFromValue(nextData, found, sourceUrl, excludedStyleColors);

  const linkPattern = /((?:https?:\/\/www\.nike\.com)?\/jp\/(?:[a-z]{2}\/)?t\/[^"'<>\\\s]*mind-001[^"'<>\\\s]*\/([A-Z0-9]{5,8}-[A-Z0-9]{3}))/gi;
  for (const match of normalizedHtml.matchAll(linkPattern)) {
    if (excludedStyleColors.has(match[2].toUpperCase())) continue;
    addProduct(found, {
      styleColor: match[2],
      url: match[1],
    }, sourceUrl);
  }

  return [...found.values()].sort((a, b) => a.styleColor.localeCompare(b.styleColor));
}

function collectProductsFromValue(value, found, sourceUrl, excludedStyleColors) {
  if (Array.isArray(value)) {
    for (const item of value) collectProductsFromValue(item, found, sourceUrl, excludedStyleColors);
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
    ...productUrlCandidates(value.pdpUrl),
    ...productUrlCandidates(value.url),
    value.productInfo?.title,
    value.productInfo?.fullTitle,
    ...productUrlCandidates(value.productInfo?.url),
    value.productContent?.title,
    value.productContent?.fullTitle,
    value.merchProduct?.labelName,
  ]
    .filter(Boolean)
    .join(' ');

  if (STYLE_COLOR_PATTERN.test(String(styleColor || '')) && MIND_001_PATTERN.test(contextText)) {
    const product = {
      styleColor,
      contextText,
      url: normalizeNikeProductUrl([
        value.pdpUrl,
        value.url,
        value.productInfo?.url,
        value.productContent?.url,
      ], { styleColor, sourceUrl }),
    };
    if (isWomensNikeProduct(product)) {
      excludedStyleColors.add(String(styleColor).toUpperCase());
      found.delete(String(styleColor).toUpperCase());
    } else {
      addProduct(found, product, sourceUrl);
    }
  }

  for (const child of Object.values(value)) {
    collectProductsFromValue(child, found, sourceUrl, excludedStyleColors);
  }
}

function addProduct(found, product, sourceUrl) {
  const styleColor = String(product.styleColor || '').toUpperCase();
  if (!STYLE_COLOR_PATTERN.test(styleColor)) return;
  if (isWomensNikeProduct({ ...product, styleColor })) return;

  const url = productUrl(product.url, styleColor, sourceUrl);
  if (!url) return;
  const previous = found.get(styleColor);
  found.set(styleColor, {
    styleColor,
    url: previous?.url?.includes(styleColor) ? previous.url : url,
  });
}

function productUrl(value, styleColor, sourceUrl) {
  return normalizeNikeProductUrl(value, { styleColor, sourceUrl });
}

// Nike sometimes represents URL fields as structured link objects. Never coerce
// those objects into "[object Object]" or let an unusable first candidate hide a
// later canonical product link.
export function normalizeNikeProductUrl(value, {
  styleColor = '', sourceUrl = 'https://www.nike.com/',
} = {}) {
  const normalizedStyle = String(styleColor || '').toUpperCase();
  for (const candidate of productUrlCandidates(value)) {
    try {
      const url = new URL(candidate, sourceUrl);
      if (url.hostname === 'nike.com') url.hostname = 'www.nike.com';
      if (url.protocol !== 'https:' || url.hostname !== 'www.nike.com' ||
          url.username || url.password || url.port) continue;
      const path = decodeURIComponent(url.pathname);
      if (/\[object\s/i.test(path) || !/\/(?:launch\/)?t\/[^/]+/i.test(path)) continue;
      const pathStyle = url.pathname.match(/\/([A-Z0-9]{5,8}-[A-Z0-9]{3})\/?$/i)?.[1]?.toUpperCase();
      if (pathStyle && !/\/t\/[^/]+/i.test(url.pathname.replace(/\/[^/]+\/?$/, ''))) continue;
      if (normalizedStyle) {
        if (!STYLE_COLOR_PATTERN.test(normalizedStyle)) continue;
        if (pathStyle && pathStyle !== normalizedStyle) continue;
        if (!pathStyle) url.pathname = `${url.pathname.replace(/\/$/, '')}/${normalizedStyle}`;
      }
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // Unsupported URL objects and malformed links are not usable product URLs.
    }
  }
  return '';
}

function productUrlCandidates(value, depth = 0) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!value || typeof value !== 'object' || depth > 3) return [];
  const candidates = Array.isArray(value)
    ? value
    : [value.pdpUrl, value.url, value.href, value.path, value.canonicalUrl];
  return candidates.flatMap((item) => productUrlCandidates(item, depth + 1));
}

function normalizeEscapedHtml(value) {
  return String(value || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeText(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function parseInitialState(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isCatalogItemCollection(value) {
  return Array.isArray(value) || (value !== null && typeof value === 'object');
}
