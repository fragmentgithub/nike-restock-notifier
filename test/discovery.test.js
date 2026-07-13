import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIND_001_URLS,
  discoverNikeMind001Products,
  extractNikeMind001Products,
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
      'HQ4309-001',
      'HQ4309-400',
      'HQ4309-601',
    ],
  );
});

test('商品リンクからMind 001だけを検出する', () => {
  const html = `
    <a href="/jp/t/nike-mind-001-mens-pregame-mules-one/HQ4307-003">Mind 001</a>
    <a href="/jp/t/nike-mind-001-womens-pregame-mules-two/HQ4309-777">New color</a>
    <a href="/jp/t/nike-mind-002-mens-pregame-shoes/HQ4310-001">Mind 002</a>
  `;

  assert.deepEqual(
    extractNikeMind001Products(html).map((product) => product.styleColor),
    ['HQ4307-003', 'HQ4309-777'],
  );
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

test('探索失敗時も例外を投げず既知商品の監視を継続できる', async () => {
  const result = await discoverNikeMind001Products({
    fetchImpl: async () => { throw new Error('blocked'); },
  });

  assert.deepEqual(result.products, []);
  assert.equal(result.error, 'blocked');
});
