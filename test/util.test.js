import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, firstPresent, parseNextData } from '../src/util.js';

test('firstPresentは0やfalseも有効な値として保持する', () => {
  assert.equal(firstPresent([undefined, 0, 1]), 0);
  assert.equal(firstPresent([null, false, true]), false);
});

test('__NEXT_DATA__要素だけを属性順に依存せず解析する', () => {
  const expected = { props: { pageProps: { value: 1 } } };
  const html = `
    <script>window.note = "__NEXT_DATA__";</script>
    <script type="application/json" data-extra="1" id="__NEXT_DATA__">${JSON.stringify(expected)}</script>`;
  assert.deepEqual(parseNextData(html), expected);
  assert.equal(parseNextData('<script>"__NEXT_DATA__"</script>'), null);
});

test('fetchWithTimeoutは呼び出し元のAbortSignalも引き継ぐ', async () => {
  const controller = new AbortController();
  let receivedSignal;

  await fetchWithTimeout('https://example.com', {
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal;
      return new Response('{}');
    },
  });
  controller.abort();

  assert.equal(receivedSignal.aborted, true);
});
