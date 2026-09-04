import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FRAGMENT_PRODUCTS,
  DEFAULT_MIND_001_URLS,
  discoverNikeFragmentProducts,
  discoverNikeMind001Products,
  extractNikeFragmentProducts,
  extractNikeMind001Products,
  isWomensNikeProduct,
} from '../src/discovery.js';

test('確認済みのMind 001を初期シードとして用意する', () => {
  assert.deepEqual(
    DEFAULT_MIND_001_URLS.map((url) => url.match(/([A-Z0-9]+-[A-Z0-9]+)$/)?.[1]),
    [
      'HQ4307-001',
      'HQ4307-003',
      'HQ4307-005',
      'HQ4307-200',
      'HQ4307-300',
    ],
  );
});

test('確認済みのFragmentコラボを初期シードとして用意する', () => {
  assert.deepEqual(
    DEFAULT_FRAGMENT_PRODUCTS.map((product) => product.styleColor),
    ['IQ8502-001', 'IQ8504-002'],
  );
  assert.ok(DEFAULT_FRAGMENT_PRODUCTS.every((product) => product.url.includes('/jp/launch/t/')));
});

test('商品リンクからメンズのMind 001だけを検出する', () => {
  const html = `
    <a href="/jp/t/nike-mind-001-mens-pregame-mules-one/HQ4307-003">Mind 001</a>
    <a href="/jp/t/nike-mind-001-womens-pregame-mules-two/HQ4309-777">New color</a>
    <a href="/jp/t/nike-mind-002-mens-pregame-shoes/HQ4310-001">Mind 002</a>
  `;

  assert.deepEqual(
    extractNikeMind001Products(html).map((product) => product.styleColor),
    ['HQ4307-003'],
  );
});

test('日本語URLでもウィメンズ品番を除外する', () => {
  const html = `
    <a href="/jp/t/nike-mind-001-%E3%83%A1%E3%83%B3%E3%82%BA/HQ4307-302">Men</a>
    <a href="/jp/t/nike-mind-001-%E3%82%A6%E3%82%A3%E3%83%A1%E3%83%B3%E3%82%BA/HQ4309-101">Women</a>
  `;

  assert.deepEqual(
    extractNikeMind001Products(html).map((product) => product.styleColor),
    ['HQ4307-302'],
  );
});

test('ウィメンズ表記または既知のウィメンズ品番を判定する', () => {
  assert.equal(isWomensNikeProduct({ url: '/mind-001-womens/HQ9999-001' }), true);
  assert.equal(isWomensNikeProduct({ title: 'Nike Mind 001 \u30a6\u30a3\u30e1\u30f3\u30ba' }), true);
  assert.equal(isWomensNikeProduct({ styleColor: 'HQ4309-400' }), true);
  assert.equal(isWomensNikeProduct({ url: '/jp/t/nike-mind-001/HQ4309-101' }), true);
  assert.equal(isWomensNikeProduct({ genders: ['WOMEN'] }), true);
  assert.equal(isWomensNikeProduct({ genders: ['MEN', 'WOMEN'] }), false);
  assert.equal(isWomensNikeProduct({ styleColor: 'HQ4307-400', title: 'Nike Mind 001 \u30e1\u30f3\u30ba' }), false);
});

test('SNKRS一覧からFragment商品だけを検出しウィメンズを除外する', () => {
  const payload = fragmentLaunchPayload([
    {
      styleColor: 'IQ8502-001',
      slug: 'mind-001-fragment-black',
      title: 'Mind 001 x \u30d5\u30e9\u30b0\u30e1\u30f3\u30c8',
      genders: ['MEN'],
    },
    {
      styleColor: 'IQ9999-100',
      slug: 'fragment-womens-shoes',
      title: 'Fragment Women\'s Shoes',
      genders: ['WOMEN'],
    },
    {
      styleColor: 'IQ8888-200',
      slug: 'ordinary-shoes',
      title: 'Ordinary Shoes',
      genders: ['MEN'],
    },
  ]);

  assert.deepEqual(extractNikeFragmentProducts(payload), [{
    styleColor: 'IQ8502-001',
    url: 'https://www.nike.com/jp/launch/t/mind-001-fragment-black',
  }]);
});

test('複数のSNKRS一覧からFragment商品を重複なく探索する', async () => {
  const html = fragmentLaunchPayload([{
    styleColor: 'IQ8504-002',
    slug: 'mind-002-fragment-black',
    title: 'Mind 002 x Fragment',
    genders: ['MEN'],
  }]);
  const result = await discoverNikeFragmentProducts({
    catalogUrls: ['https://www.nike.com/jp/launch', 'https://www.nike.com/jp/launch?s=upcoming'],
    fetchImpl: async () => new Response(html),
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.products.map((product) => product.styleColor), ['IQ8504-002']);
});

test('Fragment探索はHTTP 200のシェルHTMLを解析成功扱いしない', async () => {
  const catalogUrls = [
    'https://www.nike.com/jp/launch',
    'https://www.nike.com/jp/launch?s=upcoming',
  ];
  const result = await discoverNikeFragmentProducts({
    catalogUrls,
    fetchImpl: async () => new Response('<html><body>SNKRS shell</body></html>'),
  });

  assert.deepEqual(result.products, []);
  assert.match(result.error, /カタログ構造を解析できませんでした/);
  assert.equal(result.warnings.length, catalogUrls.length);
});

test('有効なSNKRSカタログ構造ならFragmentが0件でも探索成功とする', async () => {
  const result = await discoverNikeFragmentProducts({
    catalogUrls: [
      'https://www.nike.com/jp/launch',
      'https://www.nike.com/jp/launch?s=upcoming',
    ],
    fetchImpl: async (url) => new Response(
      url.includes('upcoming')
        ? '<html><body>SNKRS shell</body></html>'
        : fragmentLaunchPayload([]),
    ),
  });

  assert.deepEqual(result.products, []);
  assert.equal(result.error, null);
  assert.equal(result.warnings.length, 1);
});

test('__NEXT_DATA__内のウィメンズ商品を除外する', () => {
  const payload = {
    props: {
      pageProps: {
        products: [{
          styleColor: 'HQ9999-777',
          productInfo: {
            fullTitle: 'Nike Mind 001 \u30a6\u30a3\u30e1\u30f3\u30ba \u30d7\u30ec\u30b2\u30fc\u30e0 \u30df\u30e5\u30fc\u30eb',
            url: '/jp/t/nike-mind-001/HQ9999-777',
          },
        }],
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;

  assert.deepEqual(extractNikeMind001Products(html), []);
});

test('__NEXT_DATA__内の新カラーを検出してURLへスタイルコードを補う', () => {
  const payload = {
    props: {
      pageProps: {
        productGroups: [{
          products: {
            'HQ9999-123': {
              styleColor: 'HQ9999-123',
              productInfo: {
                fullTitle: 'Nike Mind 001 メンズ プレゲーム ミュール',
                url: '/jp/t/nike-mind-001-new-color',
              },
            },
          },
        }],
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const [product] = extractNikeMind001Products(html);

  assert.equal(product.styleColor, 'HQ9999-123');
  assert.match(product.url, /\/HQ9999-123$/);
});

test('URL形式の nike-mind-001(ハイフン区切り)でも新カラーを検出する', () => {
  // styleColor パスセグメントを持たない URL は linkPattern では拾えない。
  // タイトルに空白区切りの "Nike Mind 001" が無くても、URL の nike-mind-001 で検出できること。
  const payload = {
    props: {
      pageProps: {
        productGroups: [{
          products: {
            'HQ8888-200': {
              styleColor: 'HQ8888-200',
              productInfo: { url: '/jp/t/nike-mind-001-pregame-mule' },
            },
          },
        }],
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const found = extractNikeMind001Products(html).map((product) => product.styleColor);

  assert.ok(found.includes('HQ8888-200'));
});

test('NikeのpdpUrlオブジェクトから新カラーのURLを読み取り文字列へ誤変換しない', () => {
  const products = ['HQ4307-200', 'HQ4307-300', 'HQ4307-302'].map((styleColor) => {
    const path = `/jp/t/mind-001-mens-pregame-mules-Wwm9WFWW/${styleColor}`;
    return {
      styleColor,
      pdpUrl: { url: `https://www.nike.com${path}`, canonicalUrl: path.replace(`/${styleColor}`, ''), path },
      productInfo: { fullTitle: 'Nike Mind 001 メンズ プレゲーム ミュール', url: path },
    };
  });
  const payload = { props: { pageProps: { productGroups: [{ products }] } } };
  const html = `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`;
  assert.deepEqual(extractNikeMind001Products(html), products.map((product) => ({
    styleColor: product.styleColor, url: product.pdpUrl.url,
  })));
});

test('解析不能なURLオブジェクトは正しい代替URLやページ内リンクを隠さない', () => {
  const payload = { props: { pageProps: { products: [
    {
      styleColor: 'HQ4307-200', pdpUrl: { trackingId: 'unknown-shape' },
      productInfo: { fullTitle: 'Nike Mind 001', url: '/jp/t/mind-001-current/HQ4307-200' },
    },
    {
      styleColor: 'HQ4307-300', pdpUrl: { trackingId: 'unknown-shape' },
      productInfo: { fullTitle: 'Nike Mind 001' },
    },
  ] } } };
  const html = `<script id="__NEXT_DATA__">${JSON.stringify(payload)}</script>
    <a href="/jp/t/mind-001-current/HQ4307-300">Mind 001</a>`;
  assert.deepEqual(extractNikeMind001Products(html), ['HQ4307-200', 'HQ4307-300'].map((styleColor) => ({
    styleColor, url: `https://www.nike.com/jp/t/mind-001-current/${styleColor}`,
  })));
});

test('探索失敗時も例外を投げず既知商品の監視を継続できる', async () => {
  const result = await discoverNikeMind001Products({
    fetchImpl: async () => { throw new Error('blocked'); },
  });

  assert.deepEqual(result.products, []);
  assert.equal(result.error, 'blocked');
});

test('探索HTTPエラーの未使用本文を破棄する', async () => {
  let cancelled = 0;
  const fetchImpl = async () => new Response(new ReadableStream({
    cancel() { cancelled += 1; },
  }), { status: 503 });
  await discoverNikeMind001Products({ fetchImpl });
  await discoverNikeFragmentProducts({
    fetchImpl,
    catalogUrls: ['https://www.nike.com/jp/launch'],
  });
  assert.equal(cancelled, 2);
});

test('HTTP成功でも商品が0件なら探索異常として扱う', async () => {
  const result = await discoverNikeMind001Products({
    fetchImpl: async () => new Response('<html><body>No products</body></html>'),
  });

  assert.deepEqual(result.products, []);
  assert.match(result.error, /1件も検出できませんでした/);
});

function fragmentLaunchPayload(products) {
  const productItems = {};
  const threadItems = {};
  for (const [index, product] of products.entries()) {
    const productId = `product-${index}`;
    productItems[productId] = {
      styleColor: product.styleColor,
      title: product.title,
      genders: product.genders,
    };
    threadItems[`thread-${index}`] = {
      seo: { slug: product.slug },
      coverCard: { subtitle: product.title },
      cards: [{
        actions: [{ product: { productId, styleColor: product.styleColor } }],
      }],
    };
  }
  const initialState = {
    product: {
      products: { data: { items: productItems } },
      threads: { data: { items: threadItems } },
    },
  };
  const nextData = {
    props: { pageProps: { initialState: JSON.stringify(initialState) } },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;
}
