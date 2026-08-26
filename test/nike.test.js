import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNikeStock,
  normalizeSizeFilters,
  parseNikeProductUrl,
  sizeMatches,
} from '../src/nike.js';

const PRODUCT_URL = 'https://www.nike.com/jp/t/nike-mind-001/HQ4307-005';
const FRAGMENT_LAUNCH_URL = 'https://www.nike.com/jp/launch/t/mind-001-fragment-black';

test('Nike公式HTTPSの商品URLだけを受け付ける', () => {
  assert.equal(
    parseNikeProductUrl('https://nike.com/jp/t/nike-mind-001/HQ4307-005').url,
    PRODUCT_URL,
  );
  assert.throws(
    () => parseNikeProductUrl('https://example.com/jp/t/nike-mind-001/HQ4307-005'),
    /www\.nike\.com/,
  );
  assert.throws(
    () => parseNikeProductUrl('http://www.nike.com/jp/t/nike-mind-001/HQ4307-005'),
    /www\.nike\.com/,
  );
  assert.equal(
    parseNikeProductUrl(FRAGMENT_LAUNCH_URL, { styleColor: 'IQ8502-001' }).styleColor,
    'IQ8502-001',
  );
  assert.throws(() => parseNikeProductUrl(FRAGMENT_LAUNCH_URL), /スタイルカラー/);
});

test('SNKRSのFragment発売ページから購入可能サイズを検出する', async () => {
  const result = await checkWithSnkrsData({
    isActive: true,
    launchStatus: 'ACTIVE',
    merchStatus: 'ACTIVE',
    commerceStartDate: '2020-03-19T00:00:00Z',
    skus: [snkrsSize('27', true, 'HIGH'), snkrsSize('28', false, 'OOS')],
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'nike-snkrs-next-data');
  assert.equal(result.product.styleColor, 'IQ8502-001');
  assert.equal(result.product.title, 'Mind 001 x フラグメント');
  assert.equal(result.inStock, true);
  assert.deepEqual(result.matchingSizes.map((size) => size.label), ['27']);
});

test('SNKRSの発売前Fragment商品はサイズ在庫があっても通知対象にしない', async () => {
  const result = await checkWithSnkrsData({
    isActive: true,
    launchStatus: 'ACTIVE',
    merchStatus: 'ACTIVE',
    commerceStartDate: '2099-03-19T00:00:00Z',
    skus: [snkrsSize('27', true, 'HIGH')],
  });

  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.statusLabel, '販売開始前');
  assert.equal(result.availabilityState, 'coming-soon');
});

test('サイズは数値の部分一致ではなくサイズ単位で照合する', () => {
  const filters = normalizeSizeFilters('27, 27');
  assert.deepEqual(filters, ['27']);
  assert.equal(sizeMatches({ label: '27 cm (US 9)' }, filters), true);
  assert.equal(sizeMatches({ label: '27.5' }, filters), false);
  assert.equal(sizeMatches({ label: '7' }, filters), false);
  assert.equal(sizeMatches({ label: '27' }, normalizeSizeFilters('7')), false);
});

test('COMING_SOONでサイズがACTIVEでも在庫ありにしない', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', {
      statusModifier: 'NOTIFY_ME',
      featuredAttributes: ['COMING_SOON', 'LAUNCH'],
      launchDate: '2026-08-01T01:00:00Z',
      sizes: [size('27', 'ACTIVE')],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.statusLabel, '販売開始前');
  assert.equal(result.availabilityState, 'coming-soon');
  assert.equal(result.releaseAt, '2026-08-01T01:00:00.000Z');
  assert.equal(result.sizes[0].available, false);
});

test('発売日時が未来ならマーカーなしでサイズがACTIVEでも在庫ありにしない', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', {
      launchDate: '2099-08-01T01:00:00Z',
      sizes: [size('27', 'ACTIVE')],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.statusLabel, '販売開始前');
  assert.equal(result.availabilityState, 'coming-soon');
  assert.equal(result.releaseAt, '2099-08-01T01:00:00.000Z');
  assert.equal(result.sizes[0].available, false);
});

test('販売中の商品でACTIVEのサイズだけを在庫ありにする', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', {
      featuredAttributes: ['JUST_IN'],
      sizes: [size('27', 'ACTIVE'), size('28', 'OUT_OF_STOCK')],
    }),
  });

  assert.equal(result.inStock, true);
  assert.deepEqual(result.matchingSizes.map((item) => item.label), ['27']);
});

test('未知のサイズ状態を在庫ありにしない', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', {
      sizes: [size('27', 'RESERVED_FOR_LAUNCH')],
    }),
  });

  assert.equal(result.inStock, false);
  assert.equal(result.sizes[0].available, false);
});

test('ページのデフォルトカラーよりURL指定カラーを優先する', async () => {
  const requested = product('HQ4307-005', { sizes: [] });
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-003', { title: 'Wrong color', sizes: [] }),
    productGroups: [{ products: { 'HQ4307-005': requested } }],
  });

  assert.equal(result.product.styleColor, 'HQ4307-005');
  assert.equal(result.product.title, 'Nike Mind 001 HQ4307-005');
});

test('Nike商品ではない200応答を成功扱いしない', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('<html><title>Access Denied</title><body>Request blocked</body></html>');
    }
    return new Response('{}');
  };

  const result = await checkNikeStock(PRODUCT_URL, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.match(result.errors[0], /商品データをページから読み取れませんでした/);
});

test('商品ページの404を販売終了候補として返す', async () => {
  const result = await checkWithResponses([
    new Response('Not found', { status: 404 }),
    new Response('{}'),
    new Response('{}'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
});

test('商品ページの403と5xxは販売終了候補にしない', async () => {
  for (const status of [403, 503]) {
    const result = await checkWithResponses([
      new Response('temporary failure', { status }),
      new Response('{}'),
      new Response('{}'),
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.notFound, false);
  }
});

test('HTML断片の未知サイズを購入ボタンなしで在庫扱いしない', async () => {
  const html = `
    <html>
      <head><meta property="og:title" content="Nike Mind 001"></head>
      <body>
        <script>{"localizedSize":"27"}</script>
        <p>近日発売</p>
      </body>
    </html>`;
  const result = await checkWithResponses([
    new Response(html),
    new Response('{}'),
    new Response('{}'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.sizes[0].available, false);
});

test('API代替取得で指定カラーが無ければ別カラーを採用しない', async () => {
  const apiPayload = {
    objects: [{
      productInfo: [{
        merchProduct: { styleColor: 'HQ4307-003' },
        productContent: { fullTitle: 'Nike Mind 001 wrong color' },
        skus: [{ id: 'wrong-sku', localizedSize: '27' }],
        availableSkus: [{ skuId: 'wrong-sku', level: 'HIGH' }],
      }],
    }],
  };
  const result = await checkWithResponses([
    new Response('<html><title>Access Denied</title></html>'),
    Response.json(apiPayload),
    new Response('{}'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.inStock, false);
  assert.equal(result.product.styleColor, 'HQ4307-005');
});

test('API代替取得でも発売日時と発売前状態を維持する', async () => {
  const apiPayload = {
    objects: [{
      productInfo: [{
        merchProduct: {
          styleColor: 'HQ4307-005',
          commerceStartDate: '2099-08-01T01:00:00Z',
        },
        productContent: { fullTitle: 'Nike Mind 001' },
        skus: [{ id: 'sku-27', localizedSize: '27' }],
        availableSkus: [{ skuId: 'sku-27', level: 'HIGH' }],
      }],
    }],
  };
  const result = await checkWithResponses([
    new Response('<html><title>Access Denied</title></html>'),
    Response.json(apiPayload),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'coming-soon');
  assert.equal(result.statusLabel, '販売開始前');
  assert.equal(result.releaseAt, '2099-08-01T01:00:00.000Z');
});

test('スタイルカラーを反射するだけのブロックページは使用可とせずAPIフォールバックへ回す', async () => {
  // 商品構造マーカー(size-selector 等)が無く styleColor だけ本文に反射している200応答。
  const blockHtml = '<html><title>Access Denied</title><body>Reference ID: HQ4307-005</body></html>';
  const result = await checkWithResponses([
    new Response(blockHtml),
    new Response('{}'),
    new Response('{}'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.inStock, false);
});

test('商品タイトルだけを残したブロックページもAPIフォールバックへ回す', async () => {
  const blockHtml = `
    <html>
      <head><meta property="og:title" content="Nike Mind 001"></head>
      <body>Request blocked</body>
    </html>`;
  const result = await checkWithResponses([
    new Response(blockHtml),
    new Response('{}'),
    new Response('{}'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.inStock, false);
  assert.match(result.errors[0], /商品データをページから読み取れませんでした/);
});

async function checkWithNextData(pageProps) {
  const payload = { props: { pageProps } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  return checkNikeStock(PRODUCT_URL, {
    fetchImpl: async () => new Response(html),
  });
}

async function checkWithResponses(responses) {
  let index = 0;
  return checkNikeStock(PRODUCT_URL, {
    fetchImpl: async () => responses[index++] || new Response('{}'),
  });
}

async function checkWithSnkrsData(overrides = {}) {
  const productId = 'fragment-product';
  const initialState = {
    product: {
      products: {
        data: {
          items: {
            [productId]: {
              styleColor: 'IQ8502-001',
              title: 'ナイキ マインド 001 SP FK',
              subtitle: 'メンズシューズ',
              imageSrc: 'https://static.nike.com/fragment.png',
              currentPrice: 13200,
              currency: 'JPY',
              ...overrides,
            },
          },
        },
      },
      threads: {
        data: {
          items: {
            fragment: {
              active: overrides.launchStatus || 'ACTIVE',
              coverCard: {
                subtitle: 'Mind 001 x フラグメント',
                title: 'Black',
              },
              cards: [{
                actions: [{ product: { productId, styleColor: 'IQ8502-001' } }],
              }],
            },
          },
        },
      },
    },
  };
  const payload = {
    props: { pageProps: { initialState: JSON.stringify(initialState) } },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  return checkNikeStock(FRAGMENT_LAUNCH_URL, {
    styleColor: 'IQ8502-001',
    fetchImpl: async () => new Response(html),
  });
}

function product(styleColor, overrides = {}) {
  return {
    styleColor,
    productInfo: {
      fullTitle: overrides.title || `Nike Mind 001 ${styleColor}`,
      url: `/jp/t/nike-mind-001/${styleColor}`,
    },
    statusModifier: overrides.statusModifier || '',
    featuredAttributes: overrides.featuredAttributes || [],
    launchDate: overrides.launchDate,
    sizes: overrides.sizes || [],
  };
}

function size(label, status) {
  return {
    merchSkuId: `sku-${label}`,
    localizedLabel: label,
    label,
    status,
  };
}

function snkrsSize(label, available, level) {
  return {
    id: `snkrs-${label}`,
    nike_size: label,
    available,
    level,
    country_specifications: [{ localized_size: label }],
  };
}
