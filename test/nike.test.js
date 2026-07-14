import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNikeStock } from '../src/nike.js';

const PRODUCT_URL = 'https://www.nike.com/jp/t/nike-mind-001/HQ4307-005';

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
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('<html><title>Access Denied</title><body>Request blocked</body></html>');
    }
    return new Response('{}');
  };

  try {
    const result = await checkNikeStock(PRODUCT_URL);
    assert.equal(result.ok, false);
    assert.equal(calls, 3);
    assert.match(result.errors[0], /商品データをページから読み取れませんでした/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  const originalFetch = globalThis.fetch;
  const payload = { props: { pageProps } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  globalThis.fetch = async () => new Response(html);

  try {
    return await checkNikeStock(PRODUCT_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function checkWithResponses(responses) {
  const originalFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async () => responses[index++] || new Response('{}');

  try {
    return await checkNikeStock(PRODUCT_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
