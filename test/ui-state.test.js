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

function trendSummary(filters = { styleColor: 'all', days: 'all' }, {
  count = 1, products = [FIRST, SECOND], retainedFrom = '2026-09-05T19:00:00Z',
  ...overrides
} = {}) {
  return {
    timezone: 'Asia/Tokyo', styleColor: filters.styleColor,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 4 ? count : 0 })),
    totalEvents: count, products,
    period: { days: filters.days === 'all' ? 'all' : Number(filters.days),
      retainedFrom, retainedTo: retainedFrom, windowEnd: new Date(NOW).toISOString() },
    notes: { retentionLabel: '履歴は最大2年（730日）保存します。開始前は残存履歴のみです。' },
    ...overrides,
  };
}

function analytics({ comparisonStatus = 'up' } = {}) {
  const cells = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ weekday, hour, restockEvents: 0, observedProductHours: 10, ratePer100ProductHours: 0 });
    }
  }
  Object.assign(cells.find((cell) => cell.weekday === 1 && cell.hour === 4), {
    restockEvents: 2, observedProductHours: 20, ratePer100ProductHours: 10,
  });
  Object.assign(cells.find((cell) => cell.weekday === 2 && cell.hour === 3), {
    restockEvents: 1, observedProductHours: null, ratePer100ProductHours: null,
  });
  return {
    coverage: { recordingStartedAt: '2026-09-05T00:00:00Z', observedProductHours: 1680,
      reliableSegments: 84, excludedGaps: 3 },
    weekdayHours: { cells },
    sellout: { sampleCount: 6, censoredCount: 2, medianMinutes: 90, p25Minutes: 45,
      p75Minutes: 150, medianLowerMinutes: 75, medianUpperMinutes: 105 },
    comparison: {
      current: { events: 8, observedProductHours: 720, ratePer100ProductHours: 1.1 },
      previous: { events: 4, observedProductHours: 680, ratePer100ProductHours: 0.6 },
      changePercent: comparisonStatus === 'insufficient' ? null : 83.3,
      status: comparisonStatus,
      minSampleRequired: { eventsPerPeriod: 3, observedProductHoursPerPeriod: 24 },
    },
  };
}

async function loadApp(t, initialResponse, { trends = (filters) => trendSummary(filters) } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = createDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  t.mock.method(Date, 'now', () => NOW);
  let response = initialResponse;
  let trendResponse = trends;
  const requests = [];
  let tick;
  t.mock.method(globalThis, 'setInterval', (callback) => { tick = callback; return 1; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    let data = response;
    if (String(url).startsWith('/api/trends?')) {
      const filters = Object.fromEntries(new URL(url, 'https://example.test').searchParams);
      requests.push({ filters, signal: options.signal });
      data = typeof trendResponse === 'function' ? await trendResponse(filters, options) : trendResponse;
    }
    if (data instanceof Error) throw data;
    if (data?.responseStatus) return { ok: false, status: data.responseStatus, body: { async cancel() {} } };
    return { ok: true, json: async () => structuredClone(data) };
  });
  await import(`../public/app.js?ui-test=${++importId}`);
  await setImmediate();
  return {
    node: (id) => doc.querySelector(`#${id}`),
    requests,
    setTrends(value) { trendResponse = value; },
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
    assert.match(app.node('trendMessage').textContent, /監視状態は取得できていません/);
  }
});

test('initial fetch failure shows unavailable data and enables filters after a successful retry', async (t) => {
  const app = await loadApp(t, new Error('offline'), { trends: new Error('offline') });
  assert.equal(app.node('productCount').textContent, '-');
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.equal(app.node('trendChart').children.length, 0);
  app.setTrends((filters) => trendSummary(filters));
  await app.refresh(state());
  assert.equal(app.node('trendTotal').textContent, '1件');
  assert.equal(app.node('trendProduct').disabled, false);
  assert.equal(app.node('trendChart').children.length, 24);
});

test('filter selections survive failed refreshes and zero matches remain distinct from missing data', async (t) => {
  const app = await loadApp(t, state(), { trends: (filters) => trendSummary(filters, {
    count: filters.styleColor === SECOND && filters.days === '7' ? 0 : 1,
    retainedFrom: filters.styleColor === SECOND ? '2025-12-31T19:00:00Z' : '2026-09-05T19:00:00Z',
  }) });
  app.node('trendProduct').change(SECOND);
  await setImmediate();
  assert.match(app.node('trendRange').textContent, /2026\/01\/01/);
  app.node('trendPeriod').change('7');
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.equal(app.node('trendPeak').textContent, '-');
  assert.match(app.node('trendMessage').textContent, /該当する入荷検出の記録はありません/);
  app.setTrends(new Error('offline'));
  await app.refresh(state());
  assert.equal(app.node('trendProduct').value, SECOND);
  assert.equal(app.node('trendPeriod').value, '7');
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.match(app.node('trendMessage').textContent, /選択中の条件で前回取得した集計/);
  app.node('trendProduct').change(FIRST);
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.match(app.node('trendMessage').textContent, /この条件の長期集計を取得できません/);
  assert.equal(app.node('trendChart').children.length, 0);
  app.node('trendProduct').change(SECOND);
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.match(app.node('trendMessage').textContent, /選択中の条件で前回取得した集計/);
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

test('long-term totals come only from the archive API and all supported periods are requested', async (t) => {
  const app = await loadApp(t, state(), { trends: (filters) => trendSummary(filters, { count: 42 }) });
  assert.equal(app.node('trendTotal').textContent, '42件');
  assert.match(app.node('trendChart').getAttribute('aria-label'), /4時台42件/);
  for (const days of ['7', '30', '90', '365', '730', 'all']) {
    app.node('trendPeriod').change(days);
    await setImmediate();
    assert.equal(app.requests.at(-1).filters.days, days);
    assert.equal(app.node('trendTotal').textContent, '42件');
  }
  assert.match(app.node('trendRetention').textContent, /最大2年/);
});

test('older filter responses and errors cannot replace the newest response even when abort is ignored', async (t) => {
  const app = await loadApp(t, state());
  const pending = new Map();
  app.setTrends((filters) => new Promise((resolve, reject) => pending.set(filters.days, { resolve, reject, filters })));
  app.node('trendPeriod').change('90');
  assert.equal(app.node('trendTotal').textContent, '-');
  const oldSignal = app.requests.at(-1).signal;
  app.node('trendPeriod').change('365');
  assert.equal(oldSignal.aborted, true);
  pending.get('365').resolve(trendSummary(pending.get('365').filters, { count: 9 }));
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '9件');
  pending.get('90').resolve(trendSummary(pending.get('90').filters, { count: 4 }));
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '9件');
  assert.equal(app.node('trendPeriod').value, '365');

  app.node('trendPeriod').change('7');
  app.node('trendPeriod').change('730');
  pending.get('730').resolve(trendSummary(pending.get('730').filters, { count: 12 }));
  await setImmediate();
  pending.get('7').reject(new Error('old failure'));
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '12件');
  assert.doesNotMatch(app.node('trendMessage').textContent, /old failure|取得できません/);
  assert.equal(app.node('trendChart').getAttribute('aria-busy'), 'false');
});

test('mismatched filters or malformed counts never fall back to short-term status history', async (t) => {
  const app = await loadApp(t, state(), { trends: new Error('archive unavailable') });
  assert.equal(app.node('productCount').textContent, '1');
  assert.equal(app.node('trendTotal').textContent, '-');
  app.setTrends(() => trendSummary({ styleColor: 'all', days: 'all' }));
  app.node('trendPeriod').change('90');
  await setImmediate();
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.match(app.node('trendMessage').textContent, /応答形式が不正/);
  app.setTrends((filters) => trendSummary(filters, { totalEvents: 99 }));
  await app.refresh(state());
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.equal(app.node('trendChart').children.length, 0);
});

test('status failures do not prevent independent archive refreshes', async (t) => {
  const app = await loadApp(t, new Error('status offline'), {
    trends: (filters) => trendSummary(filters, { count: 17 }),
  });
  assert.equal(app.node('runStatus').textContent, '取得失敗');
  assert.equal(app.node('trendTotal').textContent, '17件');
  assert.match(app.node('trendMessage').textContent, /監視状態は取得できていません/);
  app.setTrends((filters) => trendSummary(filters, { count: 18 }));
  await app.refresh(new Error('still offline'));
  assert.equal(app.node('trendTotal').textContent, '18件');
  assert.equal(app.requests.length, 2);
});

test('archive login expiry retains only matching data and asks for renewed login', async (t) => {
  const app = await loadApp(t, state());
  app.setTrends({ responseStatus: 401 });
  await app.refresh(state());
  assert.equal(app.node('trendTotal').textContent, '1件');
  assert.match(app.node('trendMessage').textContent, /選択中の条件で前回取得した集計/);
  assert.match(app.node('trendMessage').textContent, /ログインし直してください/);
});

test('an expired product stays selected for its zero result and archive limits are shown', async (t) => {
  const app = await loadApp(t, state());
  app.setTrends((filters) => trendSummary(filters, {
    count: 0, products: [FIRST], retainedFrom: null,
    notes: { retentionLabel: '保存件数の上限に達したため古い履歴を削除しました。', productsTruncated: true },
  }));
  app.node('trendProduct').change(SECOND);
  await setImmediate();
  assert.equal(app.node('trendProduct').value, SECOND);
  assert.equal(app.node('trendTotal').textContent, '0件');
  assert.match(app.node('trendMessage').textContent, /選択肢の一部を省略/);
  assert.match(app.node('trendRetention').textContent, /保存件数の上限/);
});

test('analytics show corrected weekday rates, unobserved cells and sellout exclusions', async (t) => {
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: analytics() }),
  });
  assert.equal(app.node('selloutEstimate').textContent, '約1.5時間');
  assert.match(app.node('selloutDetail').textContent, /確定した売り切れ 6件/);
  assert.match(app.node('selloutDetail').textContent, /打ち切り 2件は推定から除外/);
  assert.match(app.node('selloutDetail').textContent, /1.3時間〜1.8時間/);
  assert.equal(app.node('comparisonValue').textContent, '増加（+83.3%）');
  assert.match(app.node('comparisonDetail').textContent, /最近30日: 8件、100商品時間あたり1.1件/);
  assert.equal(app.node('coverageValue').textContent, '1,680商品時間');
  assert.match(app.node('coverageDetail').textContent, /84区間を集計 \/ 3区間を除外/);
  assert.match(app.node('analysisNote').textContent, /補完せず、未観測/);
  assert.equal(app.node('trendHeatmapHead').children[0].children.length, 25);
  assert.equal(app.node('trendHeatmapBody').children.length, 7);
  const observed = app.node('trendHeatmapBody').children[1].children[5];
  assert.equal(observed.className, 'heat-4');
  assert.equal(observed.children[0].textContent, '2件');
  assert.equal(observed.children[1].textContent, '10.0');
  assert.match(observed.title, /観測20商品時間/);
  const unobserved = app.node('trendHeatmapBody').children[2].children[4];
  assert.equal(unobserved.className, 'unobserved');
  assert.equal(unobserved.children[0].textContent, '1件');
  assert.equal(unobserved.children[1].textContent, '未観測');
  assert.match(unobserved.title, /補正不可/);
  const observedZero = app.node('trendHeatmapBody').children[0].children[1];
  assert.equal(observedZero.children[0].textContent, '0件');
  assert.equal(observedZero.children[1].textContent, '0.0');
});

test('insufficient comparisons and missing monitoring coverage are stated without a direction', async (t) => {
  const insufficient = analytics({ comparisonStatus: 'insufficient' });
  insufficient.coverage.observedProductHours = null;
  insufficient.coverage.reliableSegments = 0;
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: insufficient }),
  });
  assert.equal(app.node('comparisonValue').textContent, 'データ不足');
  assert.match(app.node('comparisonDetail').textContent, /各期間3件以上かつ24商品時間以上/);
  assert.doesNotMatch(app.node('comparisonValue').textContent, /増加|減少|横ばい/);
  assert.equal(app.node('coverageValue').textContent, '未観測');
});

test('malformed analytics keep the matching previous result and are never partly rendered', async (t) => {
  const original = analytics();
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: original }),
  });
  assert.equal(app.node('selloutEstimate').textContent, '約1.5時間');
  const malformed = structuredClone(original);
  malformed.weekdayHours.cells.pop();
  malformed.sellout.medianMinutes = 1;
  app.setTrends((filters) => trendSummary(filters, { analytics: malformed }));
  await app.refresh(state());
  assert.equal(app.node('selloutEstimate').textContent, '約1.5時間');
  assert.equal(app.node('trendHeatmapBody').children.length, 7);
  assert.match(app.node('trendMessage').textContent, /前回取得した集計/);
  assert.match(app.node('trendMessage').textContent, /応答形式が不正/);
});

test('changing to an uncached filter clears the previous analytics while it loads', async (t) => {
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: analytics() }),
  });
  const pending = Promise.withResolvers();
  app.setTrends(() => pending.promise);
  app.node('trendPeriod').change('90');
  assert.equal(app.node('selloutEstimate').textContent, '-');
  assert.equal(app.node('comparisonValue').textContent, '-');
  assert.equal(app.node('trendHeatmapBody').children.length, 1);
  assert.match(app.node('trendHeatmapBody').children[0].children[0].textContent, /記録がありません/);
  pending.resolve(trendSummary({ styleColor: 'all', days: '90' }, { analytics: analytics() }));
  await setImmediate();
  assert.equal(app.node('selloutEstimate').textContent, '約1.5時間');
  assert.equal(app.node('trendHeatmapBody').children.length, 7);
});

test('bounded analytics never present partial coverage rates or sellout durations as trends', async (t) => {
  const bounded = analytics();
  bounded.coverage.segmentsTruncated = true;
  bounded.coverage.observedProductHours = null;
  bounded.weekdayHours.cells.forEach((cell) => {
    cell.observedProductHours = null;
    cell.ratePer100ProductHours = null;
  });
  bounded.comparison.status = 'insufficient';
  bounded.comparison.changePercent = null;
  bounded.sellout.samplesTruncated = true;
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: bounded }),
  });
  assert.equal(app.node('coverageValue').textContent, '補正不可');
  assert.match(app.node('coverageDetail').textContent, /集計上限を超えたため/);
  assert.equal(app.node('selloutEstimate').textContent, '表示不可');
  assert.match(app.node('selloutDetail').textContent, /部分的な記録から所要時間を推定しません/);
  assert.equal(app.node('comparisonValue').textContent, 'データ不足');
  assert.match(app.node('analysisNote').textContent, /補正率と売り切れまでの所要時間は表示できません/);
  const firstCell = app.node('trendHeatmapBody').children[0].children[1];
  assert.equal(firstCell.children[1].textContent, '補正不可');
  assert.match(firstCell.title, /集計上限超過/);
});

test('analytics truncation markers must be booleans when present', async (t) => {
  const malformed = analytics();
  malformed.coverage.segmentsTruncated = 'false';
  const app = await loadApp(t, state(), {
    trends: (filters) => trendSummary(filters, { analytics: malformed }),
  });
  assert.equal(app.node('trendTotal').textContent, '-');
  assert.match(app.node('trendMessage').textContent, /応答形式が不正/);
});
