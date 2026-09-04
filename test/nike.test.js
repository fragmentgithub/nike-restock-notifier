import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNikeStock,
  normalizeSizeFilters,
  parseNikeProductUrl,
  sizeMatches,
} from '../src/nike.js';
import { applyCheckState, notificationDecision } from '../src/monitor-state.js';

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

test('商品URLオブジェクトを解決し、不明な形式なら正しい代替候補を使う', async () => {
  const currentPath = '/jp/t/mind-001-current/HQ4307-005';
  const selectedProduct = product('HQ4307-005', { sizes: [size('27', 'ACTIVE')] });
  selectedProduct.productInfo.url = { unexpected: 'unknown-url-shape' };
  selectedProduct.pdpUrl = { url: `https://www.nike.com${currentPath}`, path: currentPath };
  const result = await checkWithNextData({ selectedProduct });
  assert.equal(result.ok, true);
  assert.equal(result.product.url, `https://www.nike.com${currentPath}`);

  selectedProduct.productInfo.url = '/[object%20Object]/HQ4307-005';
  selectedProduct.pdpUrl = { url: 'https://example.com/jp/t/product/HQ4307-005' };
  const fallback = await checkWithNextData({ selectedProduct });
  assert.equal(fallback.product.url, PRODUCT_URL);
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
  assert.equal(result.availabilityState, 'unknown');
  assert.equal(result.statusLabel, 'サイズ情報あり・在庫判定不可');
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

test('商品構造があっても別カラーのHTMLを指定カラーの在庫扱いしない', async () => {
  const wrongColorHtml = `
    <html>
      <head>
        <link rel="canonical" href="https://www.nike.com/jp/t/nike-mind-001/HQ4307-003">
        <meta property="og:title" content="Nike Mind 001">
      </head>
      <body>
        <div id="size-selector"><button>27</button></div>
        <button>カートに追加</button>
      </body>
    </html>`;
  const result = await checkWithResponses([
    new Response(wrongColorHtml),
    new Response('{}'),
    new Response('{}'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.inStock, false);
  assert.match(result.errors[0], /商品データをページから読み取れませんでした/);
});

test('構造化商品情報からサイズ在庫が欠落しても通知済み在庫を消さない', async () => {
  const entry = { lastStockKey: '27' };
  for (let count = 0; count < 2; count += 1) {
    const result = await checkWithNextData({ selectedProduct: product('HQ4307-005', { sizes: [] }) });
    assert.equal(result.ok, true);
    assert.equal(result.availabilityState, 'unknown');
    const decision = notificationDecision(entry, result);
    entry.lastResult = result;
    applyCheckState(entry, result, { ...decision, notified: false, webhookConfigured: true });
  }
  assert.equal(entry.lastStockKey, '27');
});

test('未知のサイズ状態は売り切れとして確定しない', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', { sizes: [size('27', 'RESERVED_FOR_LAUNCH')] }),
  });
  assert.equal(result.availabilityState, 'unknown');
  assert.equal(result.sizes[0].level, 'UNKNOWN');
});

test('一部サイズだけ不明になっても在庫構成の縮小を確定しない', async () => {
  const result = await checkWithNextData({
    selectedProduct: product('HQ4307-005', { sizes: [size('27', 'ACTIVE'), size('28', 'UNKNOWN')] }),
  });
  assert.equal(result.availabilityState, 'unknown');
});

test('全サイズ無効のHTMLでは購入ボタンの文言だけで在庫ありにしない', async () => {
  const html = `<title>Nike Mind 001</title>
    <div id="size-selector"><button disabled>27</button><button disabled>28</button></div>
    <button>カートに追加</button>`;
  const result = await checkWithResponses([new Response(html)]);
  assert.equal(result.ok, true);
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'out-of-stock');
});

test('HTMLのaria-disabled falseと一重引用符のサイズ選択欄を正しく読む', async () => {
  const html = `<title>Nike Mind 001</title>
    <div id='size-selector'><button aria-disabled="false">27</button><button aria-disabled="true">28</button></div>
    <button>カートに追加</button>`;
  const result = await checkWithResponses([new Response(html)]);
  assert.equal(result.inStock, true);
  assert.deepEqual(result.matchingSizes.map((size) => size.label), ['27']);
});

test('SNKRSの在庫情報欠落を売り切れと混同しない', async () => {
  for (const skus of [undefined, [], [{ id: 'sku-27', nike_size: '27' }]]) {
    const result = await checkWithSnkrsData({ isActive: true, skus });
    assert.equal(result.availabilityState, 'unknown');
  }
});

test('SNKRSの明示的なavailable falseは残ったHIGH表示より優先する', async () => {
  const result = await checkWithSnkrsData({ isActive: true, skus: [snkrsSize('27', false, 'HIGH')] });
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'out-of-stock');
});

test('SNKRSの商品全体の売り切れ表示を残ったSKU在庫より優先する', async () => {
  for (const unavailable of [
    { launchStatus: 'SOLD_OUT' },
    { merchStatus: 'UNAVAILABLE' },
    { statusModifier: 'OUT_OF_STOCK_SEARCHABLE' },
  ]) {
    const result = await checkWithSnkrsData({
      isActive: true,
      skus: [snkrsSize('27', true, 'HIGH')],
      ...unavailable,
    });
    assert.equal(result.ok, true);
    assert.equal(result.inStock, false, JSON.stringify(unavailable));
    assert.equal(result.availabilityState, 'out-of-stock');
    assert.deepEqual(result.availableSizes, []);
    assert.deepEqual(result.matchingSizes, []);
  }
});

test('SNKRSはNOT_YET_AVAILABLEを売り切れと誤読せず発売前として扱う', async () => {
  const result = await checkWithSnkrsData({
    launchStatus: 'NOT_YET_AVAILABLE',
    merchStatus: 'UNAVAILABLE',
    skus: [snkrsSize('27', true, 'HIGH')],
  });
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'coming-soon');
});

test('API在庫一覧の欠落を売り切れと混同しない', async () => {
  const result = await checkWithResponses([
    new Response('blocked', { status: 403 }),
    Response.json({ objects: [{ productInfo: [{
      merchProduct: { styleColor: 'HQ4307-005' },
      skus: [{ id: 'sku-27', localizedSize: '27' }],
    }] }] }),
  ]);
  assert.equal(result.availabilityState, 'unknown');
});

test('APIの明示的なavailable falseは残ったHIGH表示より優先する', async () => {
  const result = await checkWithResponses([
    new Response('blocked', { status: 403 }),
    Response.json({ objects: [{ productInfo: [{
      merchProduct: { styleColor: 'HQ4307-005' },
      skus: [{ id: 'sku-27', localizedSize: '27' }],
      availableSkus: [{ skuId: 'sku-27', available: false, level: 'HIGH' }],
    }] }] }),
  ]);
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'out-of-stock');
});

test('APIでも商品全体の在庫なし表示をSKUの残存在庫より優先する', async () => {
  const result = await checkWithResponses([
    new Response('blocked', { status: 403 }),
    Response.json({ objects: [{ productInfo: [{
      merchProduct: { styleColor: 'HQ4307-005', statusModifier: 'OUT_OF_STOCK_SEARCHABLE' },
      skus: [{ id: 'sku-27', localizedSize: '27' }],
      availableSkus: [{ skuId: 'sku-27', level: 'HIGH' }],
    }] }] }),
  ]);
  assert.equal(result.inStock, false);
  assert.equal(result.availabilityState, 'out-of-stock');
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
