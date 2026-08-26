import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIND_001_URLS,
  discoverNikeMind001Products,
  extractNikeMind001Products,
  isWomensNikeMind001Product,
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
  assert.equal(isWomensNikeMind001Product({ url: '/mind-001-womens/HQ9999-001' }), true);
  assert.equal(isWomensNikeMind001Product({ title: 'Nike Mind 001 \u30a6\u30a3\u30e1\u30f3\u30ba' }), true);
  assert.equal(isWomensNikeMind001Product({ styleColor: 'HQ4309-400' }), true);
  assert.equal(isWomensNikeMind001Product({ url: '/jp/t/nike-mind-001/HQ4309-101' }), true);
  assert.equal(isWomensNikeMind001Product({ styleColor: 'HQ4307-400', title: 'Nike Mind 001 \u30e1\u30f3\u30ba' }), false);
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

test('探索失敗時も例外を投げず既知商品の監視を継続できる', async () => {
  const result = await discoverNikeMind001Products({
    fetchImpl: async () => { throw new Error('blocked'); },
  });

  assert.deepEqual(result.products, []);
  assert.equal(result.error, 'blocked');
});

test('HTTP成功でも商品が0件なら探索異常として扱う', async () => {
  const result = await discoverNikeMind001Products({
    fetchImpl: async () => new Response('<html><body>No products</body></html>'),
  });

  assert.deepEqual(result.products, []);
  assert.match(result.error, /1件も検出できませんでした/);
});
