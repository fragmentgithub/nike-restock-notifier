import { extractNikeMind001Products } from './discovery.js';
import { errorMessage, fetchWithTimeout, firstPresent, parseNextData } from './util.js';

const NIKE_CHANNEL_ID = 'd9a5bc42-4b9c-4976-858a-f159cf99c647';

const MARKETPLACE_BY_PATH = new Map([
  ['jp', { marketplace: 'JP', language: 'ja' }],
  ['us', { marketplace: 'US', language: 'en' }],
  ['gb', { marketplace: 'GB', language: 'en-GB' }],
  ['ca', { marketplace: 'CA', language: 'en-CA' }],
  ['au', { marketplace: 'AU', language: 'en-GB' }],
  ['de', { marketplace: 'DE', language: 'de' }],
  ['fr', { marketplace: 'FR', language: 'fr' }],
  ['it', { marketplace: 'IT', language: 'it' }],
  ['es', { marketplace: 'ES', language: 'es-ES' }],
  ['kr', { marketplace: 'KR', language: 'ko' }],
]);

const DEFAULT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  origin: 'https://www.nike.com',
  referer: 'https://www.nike.com/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

export function parseNikeProductUrl(productUrl) {
  let url;

  try {
    url = new URL(productUrl);
  } catch {
    throw new Error('Nikeの商品URLを正しく入力してください。');
  }

  if (url.hostname.toLowerCase() === 'nike.com') {
    url.hostname = 'www.nike.com';
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'www.nike.com' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('https://www.nike.com の商品URLを入力してください。');
  }

  const styleColorMatch = url.pathname.match(/\/([A-Z0-9]{5,8}-[A-Z0-9]{3})(?:[/?#]|$)/i);
  const localeMatch = url.pathname.match(/^\/([a-z]{2})(?:\/|$)/i);
  const locale = (localeMatch?.[1] || 'jp').toLowerCase();
  const market = MARKETPLACE_BY_PATH.get(locale) || MARKETPLACE_BY_PATH.get('jp');

  if (!styleColorMatch) {
    throw new Error('URLからスタイルカラーを読み取れませんでした。例: HQ4307-005');
  }

  return {
    url: url.toString(),
    styleColor: styleColorMatch[1].toUpperCase(),
    locale,
    marketplace: market.marketplace,
    language: market.language,
  };
}

export function normalizeSizeFilters(input) {
  if (!input) return [];

  return [...new Set(
    String(input)
      .split(',')
      .map((value) => normalizeSize(value))
      .filter(Boolean),
  )];
}

export function normalizeSize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/センチ/g, 'cm')
    .trim();
}

export function sizeMatches(size, filters) {
  if (!filters.length) return true;

  const candidates = sizeMatchCandidates(size);
  return filters.some((filter) => candidates.has(normalizeSize(filter)));
}

export async function checkNikeStock(productUrl, options = {}) {
  const productRef = parseNikeProductUrl(productUrl);
  const sizeFilters = normalizeSizeFilters(options.sizeFilters);
  const timeoutMs = options.timeoutMs ?? 15000;
  const fetchImpl = options.fetchImpl || fetch;
  const errors = [];
  let explicitNotFound = false;

  try {
    const response = await fetchWithTimeout(productRef.url, {
      headers: {
        ...DEFAULT_HEADERS,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs,
      fetchImpl,
    });

    if (!response.ok) {
      explicitNotFound = response.status === 404 || response.status === 410;
      await response.body?.cancel();
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const parsed = parseProductPage(html, productRef, sizeFilters);
    if (!isParsedPageUsable(parsed, html, productRef)) {
      throw new Error('Nikeの商品データをページから読み取れませんでした');
    }
    const relatedProducts = extractNikeMind001Products(html, productRef.url);

    return {
      ...parsed,
      ok: true,
      checkedAt: new Date().toISOString(),
      source: parsed.source || 'nike-product-page',
      sourceUrl: productRef.url,
      relatedProducts,
      notFound: false,
      errors,
    };
  } catch (error) {
    errors.push(`${errorMessage(error)}: ${productRef.url}`);
  }

  for (const endpoint of buildProductFeedUrls(productRef)) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        headers: DEFAULT_HEADERS,
        timeoutMs,
        fetchImpl,
      });

      if (!response.ok) {
        await response.body?.cancel();
        errors.push(`${response.status} ${response.statusText}: ${endpoint}`);
        continue;
      }

      const payload = await response.json();
      const parsed = parseProductFeed(payload, productRef, sizeFilters);

      if (parsed.product || parsed.sizes.length) {
        return {
          ...parsed,
          ok: true,
          checkedAt: new Date().toISOString(),
          source: 'nike-product-api',
          sourceUrl: endpoint,
          notFound: false,
          errors,
        };
      }

      errors.push(`商品データが見つかりませんでした: ${endpoint}`);
    } catch (error) {
      errors.push(`${errorMessage(error)}: ${endpoint}`);
    }
  }

  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    source: 'none',
    sourceUrl: null,
    product: {
      title: 'Nike product',
      subtitle: '',
      styleColor: productRef.styleColor,
      url: productRef.url,
      imageUrl: '',
      price: '',
    },
    sizes: [],
    availableSizes: [],
    matchingSizes: [],
    inStock: false,
    statusLabel: '確認できません',
    availabilityState: 'unknown',
    releaseAt: null,
    relatedProducts: [],
    notFound: explicitNotFound,
    errors,
  };
}

function sizeMatchCandidates(size) {
  const candidates = new Set();
  const descriptiveValues = [size.label, size.localizedSize, size.nikeSize, size.size];

  for (const value of descriptiveValues) {
    const normalized = normalizeSize(value);
    if (!normalized) continue;
    candidates.add(normalized);

    for (const match of normalized.matchAll(/(?:us|uk|eu)?\d+(?:\.\d+)?(?:cm)?/g)) {
      const token = match[0];
      candidates.add(token);
      if (token.endsWith('cm')) candidates.add(token.slice(0, -2));
    }
  }

  const id = normalizeSize(size.id);
  if (id) candidates.add(id);
  return candidates;
}

function buildProductFeedUrls(productRef) {
  const query = new URLSearchParams();
  query.append('filter', `marketplace(${productRef.marketplace})`);
  query.append('filter', `language(${productRef.language})`);
  query.append('filter', `channelId(${NIKE_CHANNEL_ID})`);
  query.append('filter', `styleColor(${productRef.styleColor})`);

  return [
    `https://api.nike.com/product_feed/threads/v3?${query.toString()}`,
    `https://api.nike.com/product_feed/rollup_threads/v2?${query.toString()}`,
  ];
}

function parseProductFeed(payload, productRef, sizeFilters) {
  const containers = [
    ...asArray(payload?.objects),
    ...asArray(payload?.pages).flatMap((page) => asArray(page?.objects)),
    ...asArray(payload?.items),
  ];

  const productInfos = containers.flatMap((container) => asArray(container?.productInfo));
  const matchingInfo =
    productInfos.find((info) => {
      const merchProduct = info?.merchProduct || {};
      return String(merchProduct.styleColor || '').toUpperCase() === productRef.styleColor;
    }) || null;

  if (!matchingInfo) {
    return emptyParsedProduct();
  }

  const product = buildProductFromFeed(matchingInfo, productRef);
  const releaseAt = nextProductReleaseAt(matchingInfo);
  const unavailableReason = feedProductUnavailableReason(matchingInfo, releaseAt);
  const sizes = buildSizesFromFeed(matchingInfo).map((size) => ({
    ...size,
    available: unavailableReason ? false : size.available,
  }));
  const availableSizes = sizes.filter((size) => size.available);
  const matchingSizes = availableSizes.filter((size) => sizeMatches(size, sizeFilters));

  return {
    product,
    sizes,
    availableSizes,
    matchingSizes,
    inStock: matchingSizes.length > 0,
    statusLabel: unavailableReason === 'coming-soon'
      ? '販売開始前'
      : statusLabelFor(sizes, matchingSizes, sizeFilters),
    availabilityState: unavailableReason || (matchingSizes.length > 0 ? 'available' : 'out-of-stock'),
    releaseAt,
  };
}

function feedProductUnavailableReason(info, releaseAt) {
  const merchProduct = info?.merchProduct || {};
  const productContent = info?.productContent || {};
  const markers = [
    merchProduct.status,
    merchProduct.statusModifier,
    merchProduct.commerceStatus,
    merchProduct.publishType,
    productContent.statusModifier,
    ...asArray(productContent.featuredAttributes),
  ].join(' ');
  if (/COMING_SOON|NOTIFY_ME|NOT_YET_AVAILABLE|UPCOMING/i.test(markers)) return 'coming-soon';

  const releaseTimestamp = Date.parse(releaseAt || '');
  if (Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now()) return 'coming-soon';
  return null;
}

function buildProductFromFeed(info, productRef) {
  const product = info?.productContent || {};
  const merchProduct = info?.merchProduct || {};
  const merchPrice = info?.merchPrice || {};
  const imageCandidates = [
    product?.nodes?.[0]?.nodes?.[0]?.properties?.squarishURL,
    product?.nodes?.[0]?.properties?.squarishURL,
    product?.fullTitleImage,
    product?.imageUrl,
    merchProduct?.imageUrl,
  ].filter(Boolean);

  return {
    title: product?.fullTitle || product?.title || merchProduct?.labelName || 'Nike product',
    subtitle: product?.subtitle || product?.descriptionHeading || '',
    styleColor: merchProduct?.styleColor || productRef.styleColor,
    url: productRef.url,
    imageUrl: imageCandidates[0] || '',
    price: formatPrice(merchPrice),
  };
}

function buildSizesFromFeed(info) {
  const skus = asArray(info?.skus);
  const availableSkus = asArray(info?.availableSkus);
  const availableBySkuId = new Map();

  for (const availableSku of availableSkus) {
    const id = String(availableSku?.skuId || availableSku?.id || '');
    if (!id) continue;
    availableBySkuId.set(id, availableSku);
  }

  return skus.map((sku) => {
    const availableSku = availableBySkuId.get(String(sku?.id || '')) || {};
    const level = String(availableSku?.level || availableSku?.inventoryLevel || '').toUpperCase();
    const available =
      availableSku?.available === true ||
      availableSku?.available === 'true' ||
      ['LOW', 'MEDIUM', 'HIGH', 'AVAILABLE'].includes(level);
    const label = firstPresent([
      sku?.localizedSize,
      sku?.nikeSize,
      sku?.size,
      sku?.countrySpecifications?.[0]?.localizedSize,
      sku?.id,
    ]);

    return {
      id: sku?.id || '',
      label,
      localizedSize: sku?.localizedSize || '',
      nikeSize: sku?.nikeSize || '',
      size: sku?.size || '',
      available,
      level: level || (available ? 'AVAILABLE' : 'OOS'),
    };
  });
}

function parseProductPage(html, productRef, sizeFilters) {
  const nextData = parseNextData(html);
  const nextParsed = nextData ? parseNextProductData(nextData, productRef, sizeFilters) : null;
  if (nextParsed) return nextParsed;

  const title =
    textByTestId(html, 'product_title') ||
    decodeHtml(
      html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+\.\s+Nike.*$/i, '') ||
        'Nike product',
    );
  const subtitle = textByTestId(html, 'product_subtitle');
  const price = textByTestId(html, 'currentPrice-container');
  const imageUrl =
    decodeHtml(html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] || '') ||
    firstImageByTestId(html, 'HeroImg');
  const pageText = decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const soldOut = /在庫なし|売り切れ|sold\s*out|out\s*of\s*stock/i.test(pageText);
  const addToCart = /カートに追加|バッグに追加|add\s+to\s+bag|add\s+to\s+cart/i.test(pageText);
  const sizes = [...extractSizesFromHtmlControls(html), ...extractSizesFromJsonFragments(html)].map(
    (size) => ({
      ...size,
      available: addToCart && !soldOut && size.available,
    }),
  );
  const availableSizes = sizes.filter((size) => size.available);
  const matchingSizes = availableSizes.filter((size) => sizeMatches(size, sizeFilters));

  return {
    product: {
      title,
      subtitle,
      styleColor: productRef.styleColor,
      url: productRef.url,
      imageUrl,
      price,
    },
    sizes,
    availableSizes,
    matchingSizes,
    inStock: matchingSizes.length > 0 || (sizeFilters.length === 0 && addToCart && !soldOut),
    statusLabel:
      sizes.length > 0
        ? statusLabelFor(sizes, matchingSizes, sizeFilters)
        : soldOut
          ? '在庫なし'
          : addToCart && !soldOut
          ? '販売中の可能性あり'
          : '在庫なし、またはページから判定不可',
    availabilityState: addToCart && !soldOut ? 'available' : soldOut ? 'out-of-stock' : 'unknown',
    releaseAt: null,
  };
}

function parseNextProductData(nextData, productRef, sizeFilters) {
  const pageProps = nextData?.props?.pageProps || {};
  const groupedProduct = findProductInGroups(pageProps.productGroups, productRef.styleColor);
  const pageSelectedProduct = pageProps.selectedProduct || null;
  const selectedProduct =
    groupedProduct ||
    (String(pageSelectedProduct?.styleColor || '').toUpperCase() === productRef.styleColor
      ? pageSelectedProduct
      : null) ||
    null;

  if (!selectedProduct) return null;

  const product = buildProductFromNextData(selectedProduct, pageProps, productRef);
  const releaseAt = nextProductReleaseAt(selectedProduct);
  const unavailableReason = nextProductUnavailableReason(selectedProduct, releaseAt);
  const productUnavailable = Boolean(unavailableReason);
  const sizes = asArray(selectedProduct.sizes).map((size) => {
    const available = !productUnavailable && isNextSizeAvailable(size);
    const label = firstPresent([
      size.localizedLabel,
      withPrefix(size.localizedLabelPrefix, size.localizedLabel),
      withPrefix(size.localizedLabelPrefix, size.label),
      size.label,
      size.merchSkuId,
    ]);

    return {
      id: size.merchSkuId || size.gtin || size.label || '',
      label,
      localizedSize: size.localizedLabel || '',
      nikeSize: size.label || '',
      size: size.label || '',
      available,
      level: available ? normalizeInventoryLevel(size.status) || 'AVAILABLE' : 'OUT_OF_STOCK',
    };
  });
  const availableSizes = sizes.filter((size) => size.available);
  const matchingSizes = availableSizes.filter((size) => sizeMatches(size, sizeFilters));

  return {
    product,
    sizes,
    availableSizes,
    matchingSizes,
    inStock: matchingSizes.length > 0,
    statusLabel:
      unavailableReason === 'coming-soon'
        ? '販売開始前'
        : statusLabelFor(sizes, matchingSizes, sizeFilters),
    availabilityState: unavailableReason || (matchingSizes.length > 0 ? 'available' : 'out-of-stock'),
    releaseAt,
    source: 'nike-next-data',
  };
}

function findProductInGroups(productGroups, styleColor) {
  for (const group of asArray(productGroups)) {
    const product = group?.products?.[styleColor];
    if (product) return product;
  }

  return null;
}

function buildProductFromNextData(selectedProduct, pageProps, productRef) {
  const productInfo = selectedProduct.productInfo || {};
  const imageUrl = firstPresent([
    selectedProduct.contentImages?.[0]?.properties?.squarish?.url,
    selectedProduct.contentImages?.[0]?.properties?.portrait?.url,
  ]);

  return {
    title: productInfo.fullTitle || productInfo.title || 'Nike product',
    subtitle: productInfo.subtitle || selectedProduct.colorDescription || '',
    styleColor: selectedProduct.styleColor || productRef.styleColor,
    url: absoluteNikeUrl(productInfo.url || selectedProduct.pdpUrl || pageProps.slug, productRef.url),
    imageUrl,
    price: formatNextPrice(selectedProduct.prices),
  };
}

function nextProductUnavailableReason(product, releaseAt) {
  const featuredAttributes = asArray(product.featuredAttributes).join(' ');
  const statusModifier = String(product.statusModifier || '');
  const markers = `${featuredAttributes} ${statusModifier}`;
  if (/COMING_SOON|NOTIFY_ME|NOT_YET_AVAILABLE|UPCOMING/i.test(markers)) return 'coming-soon';
  const releaseTimestamp = Date.parse(releaseAt || '');
  if (Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now()) return 'coming-soon';
  if (/OUT_OF_STOCK|SOLD_OUT|UNAVAILABLE/i.test(markers)) return 'out-of-stock';
  return null;
}

function nextProductReleaseAt(product) {
  const values = [
    product?.launchDate,
    product?.commerceStartDate,
    product?.productInfo?.launchDate,
    product?.productInfo?.commerceStartDate,
    product?.merchProduct?.commerceStartDate,
    product?.merchProduct?.publishStartDate,
  ];
  for (const value of values) {
    const timestamp = Date.parse(value || '');
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

function isNextSizeAvailable(size) {
  const status = String(size.status || '').toUpperCase();
  // 未知の状態を在庫ありに倒すと誤通知になるため、購入可能と確認済みの状態だけを許可する。
  return ['ACTIVE', 'AVAILABLE', 'IN_STOCK'].includes(status);
}

function formatNextPrice(price) {
  if (!price) return '';
  const value = price.currentPrice ?? price.initialPrice;
  if (value === undefined || value === null || value === '') return '';

  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: price.currency || 'JPY',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${price.currency || ''} ${value}`.trim();
  }
}

function absoluteNikeUrl(value, fallback) {
  if (!value) return fallback;

  try {
    return new URL(value, 'https://www.nike.com').toString();
  } catch {
    return fallback;
  }
}

function withPrefix(prefix, value) {
  if (!value) return '';
  return prefix ? `${prefix} ${value}` : value;
}

function normalizeInventoryLevel(value) {
  const level = String(value || '').toUpperCase();
  if (level === 'ACTIVE') return 'AVAILABLE';
  return level;
}

function extractSizesFromHtmlControls(html) {
  const sizeSelectorIndex = html.indexOf('id="size-selector"');
  if (sizeSelectorIndex === -1) return [];

  const section = html.slice(sizeSelectorIndex, sizeSelectorIndex + 50000);
  const found = new Map();
  const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;

  for (const match of section.matchAll(buttonPattern)) {
    const attrs = match[1] || '';
    const body = decodeHtml(match[2].replace(/<[^>]+>/g, ' '));
    if (!body || !/\d/.test(body)) continue;

    const label = body.replace(/\s+/g, ' ').trim();
    const key = normalizeSize(label);
    if (!key || found.has(key)) continue;

    const disabled = /\bdisabled\b|aria-disabled=["']true["']/i.test(attrs);
    found.set(key, {
      id: attrValue(attrs, 'data-testid') || '',
      label,
      localizedSize: label,
      nikeSize: label,
      size: label,
      available: !disabled,
      level: disabled ? 'OUT_OF_STOCK' : 'AVAILABLE',
    });
  }

  return [...found.values()];
}

function extractSizesFromJsonFragments(html) {
  const found = new Map();
  const patterns = [
    /"localizedSize"\s*:\s*"([^"]+)"/gi,
    /"nikeSize"\s*:\s*"([^"]+)"/gi,
    /"displaySize"\s*:\s*"([^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const label = decodeJsonString(match[1]);
      if (!label || found.has(normalizeSize(label))) continue;
      found.set(normalizeSize(label), {
        id: '',
        label,
        localizedSize: label,
        nikeSize: label,
        size: label,
        // JSON断片だけでは、そのサイズを今購入できるか確定できない。
        available: false,
        level: nearSoldOutText(html, match.index || 0) ? 'OOS' : 'UNKNOWN',
      });
    }
  }

  return [...found.values()];
}

function nearSoldOutText(text, index) {
  const start = Math.max(0, index - 500);
  const end = Math.min(text.length, index + 500);
  return /"available"\s*:\s*false|"level"\s*:\s*"OOS"|"available"\s*:\s*"false"/i.test(
    text.slice(start, end),
  );
}

function emptyParsedProduct() {
  return {
    product: null,
    sizes: [],
    availableSizes: [],
    matchingSizes: [],
    inStock: false,
    statusLabel: '商品データなし',
  };
}

function statusLabelFor(sizes, matchingSizes, sizeFilters) {
  if (matchingSizes.length > 0) {
    return `${matchingSizes.map((size) => size.label).join(', ')} が在庫あり`;
  }

  if (sizeFilters.length > 0) {
    return '対象サイズは在庫なし';
  }

  if (sizes.some((size) => size.available)) {
    return '一部サイズが在庫あり';
  }

  if (sizes.length > 0) {
    return '全サイズ在庫なし';
  }

  return 'サイズ情報なし';
}

function formatPrice(price) {
  if (!price) return '';
  const currentPrice = price.currentPrice ?? price.fullPrice;
  const currency = price.currency || '';
  if (!currentPrice) return '';
  return `${currency} ${currentPrice}`.trim();
}

function attrValue(attrs, name) {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`, 'i');
  return decodeHtml(attrs.match(pattern)?.[1] || '');
}

function textByTestId(html, testId) {
  const escapedTestId = escapeRegExp(testId);
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*data-testid=["']${escapedTestId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  );
  const body = html.match(pattern)?.[2] || '';
  return decodeHtml(body.replace(/<[^>]+>/g, ' '));
}

function firstImageByTestId(html, testId) {
  const escapedTestId = escapeRegExp(testId);
  const marker = new RegExp(`data-testid=["']${escapedTestId}["']`, 'i');
  const index = html.search(marker);
  if (index === -1) return '';
  const section = html.slice(index, index + 10000);
  const attrs = section.match(/<img\b([^>]*)>/i)?.[1] || '';
  return attrValue(attrs, 'src');
}

function isParsedPageUsable(parsed, html, productRef) {
  if (parsed?.source === 'nike-next-data') return true;

  const title = String(parsed?.product?.title || '');
  const hasProductTitle = /nike[\s\u00a0]*mind[\s\u00a0]*001/i.test(title);

  // \u30b9\u30bf\u30a4\u30eb\u30ab\u30e9\u30fc\u306e\u6587\u5b57\u5217\u4e00\u81f4\u3060\u3051\u3092\u4fe1\u983c\u3059\u308b\u3068\u3001\u8981\u6c42URL\u3092\u672c\u6587\u3078\u53cd\u5c04\u3059\u308b
  // \u30d6\u30ed\u30c3\u30af/\u30a8\u30e9\u30fc\u30da\u30fc\u30b8\u3092\u300c\u4f7f\u7528\u53ef\u300d\u3068\u8aa4\u5224\u5b9a\u3057\u3001product_feed API\u3078\u306e\u30d5\u30a9\u30fc\u30eb\u30d0\u30c3\u30af\u3092
  // \u6291\u6b62\u3057\u3066\u3057\u307e\u3046\u3002\u5b9f\u969b\u306e\u5546\u54c1\u69cb\u9020\u30de\u30fc\u30ab\u30fc\u306e\u4f75\u5b58\u3082\u8981\u6c42\u3059\u308b\u3002
  const hasStyleColor = html.toUpperCase().includes(productRef.styleColor);
  const hasProductMarkers =
    parsed?.sizes?.length > 0 ||
    /id=["']size-selector["']|data-testid=["'](?:currentPrice-container|product_title)["']/i.test(
      html,
    );
  // タイトルやスタイルカラーだけでは SEO 情報を残したブロックページを正常ページと
  // 誤認しうるため、実際の商品構造マーカーとの併存を必須にする。
  return hasProductMarkers && (hasProductTitle || hasStyleColor);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
