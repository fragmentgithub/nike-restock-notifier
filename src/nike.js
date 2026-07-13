import { extractNikeMind001Products } from './discovery.js';

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

  return String(input)
    .split(',')
    .map((value) => normalizeSize(value))
    .filter(Boolean);
}

export function normalizeSize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/センチ/g, 'cm')
    .replace(/ｃｍ/g, 'cm')
    .trim();
}

export function sizeMatches(size, filters) {
  if (!filters.length) return true;

  const candidates = [
    size.label,
    size.localizedSize,
    size.nikeSize,
    size.size,
    size.id,
  ]
    .map(normalizeSize)
    .filter(Boolean);

  return filters.some((filter) =>
    candidates.some((candidate) => candidate.includes(filter) || filter.includes(candidate)),
  );
}

export async function checkNikeStock(productUrl, options = {}) {
  const productRef = parseNikeProductUrl(productUrl);
  const sizeFilters = normalizeSizeFilters(options.sizeFilters);
  const errors = [];

  try {
    const response = await fetchWithTimeout(productRef.url, {
      headers: {
        ...DEFAULT_HEADERS,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: options.timeoutMs || 15000,
    });

    if (!response.ok) {
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
      errors,
    };
  } catch (error) {
    errors.push(`${error.message}: ${productRef.url}`);
  }

  for (const endpoint of buildProductFeedUrls(productRef)) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        headers: DEFAULT_HEADERS,
        timeoutMs: options.timeoutMs || 15000,
      });

      if (!response.ok) {
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
          errors,
        };
      }

      errors.push(`商品データが見つかりませんでした: ${endpoint}`);
    } catch (error) {
      errors.push(`${error.message}: ${endpoint}`);
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
    relatedProducts: [],
    errors,
  };
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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
    }) ||
    productInfos[0] ||
    null;

  if (!matchingInfo) {
    return emptyParsedProduct(productRef, sizeFilters);
  }

  const product = buildProductFromFeed(matchingInfo, productRef);
  const sizes = buildSizesFromFeed(matchingInfo);
  const availableSizes = sizes.filter((size) => size.available);
  const matchingSizes = availableSizes.filter((size) => sizeMatches(size, sizeFilters));

  return {
    product,
    sizes,
    availableSizes,
    matchingSizes,
    inStock: matchingSizes.length > 0,
    statusLabel: statusLabelFor(sizes, matchingSizes, sizeFilters),
  };
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
  const sizes = [...extractSizesFromHtmlControls(html), ...extractSizesFromJsonFragments(html)].map((size) => ({
    ...size,
    available: addToCart && !soldOut ? size.available : size.available && !soldOut,
  }));
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
  };
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
  const unavailableReason = nextProductUnavailableReason(selectedProduct);
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

function nextProductUnavailableReason(product) {
  const featuredAttributes = asArray(product.featuredAttributes).join(' ');
  const statusModifier = String(product.statusModifier || '');
  const markers = `${featuredAttributes} ${statusModifier}`;
  if (/COMING_SOON|NOTIFY_ME|NOT_YET_AVAILABLE|UPCOMING/i.test(markers)) return 'coming-soon';
  if (/OUT_OF_STOCK|SOLD_OUT|UNAVAILABLE/i.test(markers)) return 'out-of-stock';
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
        available: !nearSoldOutText(html, match.index || 0),
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

function emptyParsedProduct(productRef) {
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

function firstPresent(values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
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
  const attrs = section.match(/<img\\b([^>]*)>/i)?.[1] || '';
  return attrValue(attrs, 'src');
}

function isParsedPageUsable(parsed, html, productRef) {
  if (parsed?.source === 'nike-next-data') return true;
  const title = String(parsed?.product?.title || '');
  return (
    html.toUpperCase().includes(productRef.styleColor) ||
    /nike[\s\u00a0]*mind[\s\u00a0]*001/i.test(title)
  );
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
