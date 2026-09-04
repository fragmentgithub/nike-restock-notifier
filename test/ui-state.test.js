import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

const NOW = Date.parse('2026-09-06T03:00:00Z');
const FIRST = 'HQ4307-001';
const SECOND = 'HQ4307-200';
let importId = 0;

// A minimal DOM surface lets the real fetch/render cycle run without a browser.
// Browser layout and interaction checks remain separate from these data tests.
class Element {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  change(value) { this.value = value; this.listeners.get('change')?.(); }
  append(...children) {
    this.children.push(...children.flatMap((child) => child.fragment ? child.children : [child]));
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'title') this.title = ''; }
  getAttribute(name) { return this.attributes.get(name); }
}

function createDocument() {
  const elements = new Map();
  const doc = {
    createElement() { return new Element(doc); },
    createDocumentFragment() { const node = new Element(doc); node.fragment = true; return node; },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element(doc));
      return elements.get(selector);
    },
  };
  doc.querySelector('#trendProduct').value = 'all';
  doc.querySelector('#trendPeriod').value = 'all';
  return doc;
}

function product(styleColor = FIRST, overrides = {}) {
  return {
    styleColor,
    lastResult: {
      ok: true, inStock: true, availabilityState: 'available', statusLabel: '在庫あり',
      checkedAt: new Date(NOW - 1000).toISOString(),
      product: { title: styleColor, styleColor },
      sizes: [{ label: '27', available: true }],
    },
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    updatedAt: new Date(NOW).toISOString(),
    config: { runtime: 'cloudflare', intervalSeconds: 120 },
    products: [product()],
    history: [{ at: '2026-09-05T19:00:00Z', styleColor: FIRST, added: ['27'], message: '入荷' }],
    events: [],
    ...overrides,
  };
}

async function loadApp(t, initialResponse) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = createDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  t.mock.method(Date, 'now', () => NOW);
  let response = initialResponse;
  let tick;
  t.mock.method(globalThis, 'setInterval', (callback) => { tick = callback; return 1; });
  t.mock.method(globalThis, 'fetch', async () => {
    if (response instanceof Error) throw response;
    return { ok: true, json: async () => structuredClone(response) };
  });
  await import(`../public/app.js?ui-test=${++importId}`);
  return {
    node: (id) => doc.querySelector(`#${id}`),
    async refresh(nextResponse) {
      response = nextResponse;
      tick();
      await setImmediate();
      assert.equal(doc.querySelector('#appShell').getAttribute('aria-busy'), 'false');
    },
  };
}

test('a successfully fetched stale snapshot marks both status and trends, then clears on recovery', async (t) => {
  const app = await loadApp(t, state({ updatedAt: new Date(NOW - 11 * 60000).toISOString() }));
  assert.equal(app.node('runStatus').textContent, '更新遅延');
  assert.match(app.node('trendMessage').textContent, /更新が遅延/);
  assert.equal(app.node('trendTotal').textContent, '1件');
  app.node('trendPeriod').change('7');
  assert.match(app.node('trendMessage').textContent, /更新が遅延/);
  await app.refresh(state());
  assert.equal(app.node('runStatus').textContent, '自動監視中');
  assert.doesNotMatch(app.node('trendMessage').textContent, /更新が遅延|前回取得/);
  assert.equal(app.node('trendPeriod').value, '7');
});

test('malformed refreshes preserve the complete prior snapshot instead of partially changing it', async (t) => {
  const app = await loadApp(t, state());
  const originalCards = app.node('productGrid').innerHTML;
  const originalHistory = app.node('stockHistory').innerHTML;
  const invalidSnapshots = [
    state({ products: [product(), product(SECOND)], history: { length: 1 } }),
    state({ products: [null] }),
    state({ products: [product(FIRST, { lastResult: { sizes: [null] } })] }),
    state({ events: [null] }),
  ];
  for (const invalid of invalidSnapshots) {
    await app.refresh(invalid);
    assert.equal(app.node('productCount').textContent, '1');
    assert.equal(app.node('productGrid').innerHTML, originalCards);
    assert.equal(app.node('stockHistory').innerHTML, originalHistory);
    assert.equal(app.node('trendTotal').textContent, '1件');
    assert.equal(app.node('runStatus').textContent, '取得失敗');
    assert.match(app.node('trendMessage').textContent, /前回取得した履歴/);
  }
});

test('initial fetch failure shows unavailable data and enables filters after a successful retry', async (t) => {
  const app = await loadApp(t, new Error('offline'));
  assert.equal(app.node('productCount').textContent, '-');
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.equal(app.node('trendProduct').disabled, true);
  assert.equal(app.node('trendChart').children.length, 0);
  await app.refresh(state());
  assert.equal(app.node('trendTotal').textContent, '1件');
  assert.equal(app.node('trendProduct').disabled, false);
  assert.equal(app.node('trendChart').children.length, 24);
});

test('filter selections survive failed refreshes and zero matches remain distinct from missing data', async (t) => {
  const app = await loadApp(t, state({
    products: [product(), product(SECOND)],
    history: [
      { at: '2026-09-05T19:00:00Z', styleColor: FIRST, added: ['27'] },
      { at: '2025-12-31T19:00:00Z', styleColor: SECOND, added: ['28'] },
    ],
  }));
  app.node('trendProduct').change(SECOND);
  assert.match(app.node('trendRange').textContent, /2026\/01\/01/);
  app.node('trendPeriod').change('7');
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.equal(app.node('trendPeak').textContent, '-');
  assert.match(app.node('trendMessage').textContent, /該当する入荷検出の記録はありません/);
  await app.refresh(new Error('offline'));
  assert.equal(app.node('trendProduct').value, SECOND);
  assert.equal(app.node('trendPeriod').value, '7');
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.match(app.node('trendMessage').textContent, /前回取得した履歴/);
  app.node('trendProduct').change(FIRST);
  assert.equal(app.node('trendTotal').textContent, '1件');
  assert.match(app.node('trendMessage').textContent, /前回取得した履歴/);
  assert.match(app.node('trendChart').getAttribute('aria-label'), /4時台1件/);
});

test('unknown inventory and a newer runtime failure cannot present old sizes as current stock', async (t) => {
  const unknown = product(FIRST);
  unknown.lastResult.availabilityState = 'unknown';
  unknown.lastResult.inStock = false;
  unknown.lastResult.sizes = [{ label: '27', available: false, level: 'UNKNOWN' }];
  const app = await loadApp(t, state({ products: [unknown] }));
  assert.equal(app.node('availableProductCount').textContent, '0');
  assert.match(app.node('productGrid').innerHTML, /在庫判定不可/);
  assert.doesNotMatch(app.node('productGrid').innerHTML, /在庫ありサイズなし/);
  await app.refresh(state({ products: [product(FIRST, { lastError: '確認タイムアウト' })] }));
  assert.equal(app.node('availableProductCount').textContent, '0');
  assert.match(app.node('productGrid').innerHTML, /stock-badge error/);
  assert.match(app.node('productGrid').innerHTML, /最新の在庫は不明/);
});

test('an explicit empty product list stays empty while legacy lastResult-only snapshots remain supported', async (t) => {
  const lastResult = product().lastResult;
  const app = await loadApp(t, state({ products: [], lastResult }));
  assert.equal(app.node('productCount').textContent, '0');
  assert.equal(app.node('lastChecked').textContent, '-');
  await app.refresh(state({ products: undefined, lastResult, history: null, events: null }));
  assert.equal(app.node('productCount').textContent, '1');
  assert.equal(app.node('availableProductCount').textContent, '1');
});
