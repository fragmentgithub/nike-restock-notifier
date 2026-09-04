import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorEngine } from '../src/monitor-engine.js';
import { DEFAULT_MIND_001_URLS, DEFAULT_FRAGMENT_PRODUCTS } from '../src/discovery.js';

const TARGET = 'HQ4307-005';
const OTHER = 'HQ4307-003';
const WEBHOOK = 'https://discord.com/api/webhooks/123456/test-token';
const ALL = [...DEFAULT_MIND_001_URLS.map((url) => url.split('/').at(-1)),
  ...DEFAULT_FRAGMENT_PRODUCTS.map((product) => product.styleColor)];
const urlFor = (styleColor) => `https://www.nike.com/jp/t/nike-mind-001/${styleColor}`;
const iso = (timestamp) => new Date(timestamp).toISOString();

function environment(enabled = [TARGET], overrides = {}) {
  return {
    PRODUCT_CONFIG_JSON: JSON.stringify(Object.fromEntries(ALL.map((key) =>
      [key, { enabled: enabled.includes(key) }]))),
    ...overrides,
  };
}

function cache(timestamp, product = {}, more = {}) {
  return {
    lastDiscoveryAt: iso(timestamp), lastDiscoverySuccessAt: iso(timestamp),
    knownProducts: {
      [TARGET]: { styleColor: TARGET, url: urlFor(TARGET), ...product },
    },
    ...more,
  };
}

function productPage(styleColor = TARGET, labels = ['27'], overrides = {}) {
  const selectedProduct = {
    styleColor,
    productInfo: { fullTitle: `Nike Mind 001 ${styleColor}`, url: urlFor(styleColor) },
    sizes: labels.map((label) => ({ merchSkuId: `sku-${label}`, localizedLabel: label,
      label, status: 'ACTIVE' })),
    ...overrides,
  };
  return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { selectedProduct } },
  })}</script>`);
}

test('one alarm checks only one due product and does not mutate the supplied cache', async () => {
  const timestamp = Date.now();
  const source = cache(timestamp);
  const original = structuredClone(source);
  const requests = [];
  const engine = createMonitorEngine({ env: environment([TARGET, OTHER]), state: source,
    now: () => timestamp, fetchImpl: async (url) => {
      requests.push(url);
      return productPage(url.split('/').at(-1));
    } });
  const result = await engine.tick();
  assert.equal(result.kind, 'check');
  assert.equal(requests.length, 1);
  assert.equal(engine.status().metrics.checks, 1);
  assert.equal(engine.nextAlarmAt(), timestamp + 1500);
  assert.deepEqual(source, original);
  assert.equal(createMonitorEngine({ state: source, now: () => timestamp }).snapshot().checkSamples.length, 0);
});

test('shadow leaves notification keys and pending eligibility intact through a restart', async () => {
  let timestamp = Date.now();
  let posts = 0;
  const env = environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK });
  const fetchImpl = async (url) => {
    if (url.startsWith('https://discord.com')) {
      posts += 1;
      return new Response(null, { status: 204 });
    }
    return productPage();
  };
  const shadow = createMonitorEngine({ env, state: cache(timestamp), notify: false,
    now: () => timestamp, fetchImpl });
  await shadow.tick();
  assert.equal(posts, 0);
  const saved = shadow.snapshot();
  assert.equal(saved.knownProducts[TARGET].lastStockKey, '');
  assert.equal(saved.knownProducts[TARGET].pendingNotification.stockKey, '27');
  timestamp += 120000;
  const active = createMonitorEngine({ env, state: saved, now: () => timestamp, fetchImpl });
  assert.equal((await active.tick()).notified, true);
  assert.equal(posts, 1);
  assert.equal(active.snapshot().knownProducts[TARGET].lastStockKey, '27');
  assert.equal(active.snapshot().knownProducts[TARGET].pendingNotification, null);
  timestamp += 120000;
  await active.tick();
  assert.equal(posts, 1);
});

test('a failed Discord send retains the key and candidate and retries after rehydration', async () => {
  let timestamp = Date.now();
  let saved;
  let failing = true;
  const env = environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK });
  const fetchImpl = async (url) => {
    if (url.startsWith('https://discord.com')) {
      assert.ok(saved.knownProducts[TARGET].pendingNotification);
      assert.equal(saved.knownProducts[TARGET].lastStockKey, '');
      if (failing) throw new Error(`failed at ${WEBHOOK}`);
      return new Response(null, { status: 204 });
    }
    return productPage();
  };
  let engine = createMonitorEngine({ env, state: cache(timestamp), now: () => timestamp,
    fetchImpl, persist: async (state) => { saved = state; } });
  assert.equal((await engine.tick()).notified, false);
  assert.equal(saved.knownProducts[TARGET].lastStockKey, '');
  assert.ok(saved.knownProducts[TARGET].pendingNotification);
  assert.ok(!JSON.stringify(engine.status()).includes('test-token'));
  failing = false;
  timestamp += 120000;
  engine = createMonitorEngine({ env, state: saved, now: () => timestamp,
    fetchImpl, persist: async (state) => { saved = state; } });
  assert.equal((await engine.tick()).notified, true);
  assert.equal(saved.knownProducts[TARGET].lastStockKey, '27');
});

test('shadow remembers a confirmed sellout so the same sizes can notify on restock', async () => {
  let timestamp = Date.now();
  let inStock = false;
  let posts = 0;
  const env = environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK });
  const fetchImpl = async (url) => {
    if (url.startsWith('https://discord.com')) {
      posts += 1;
      return new Response(null, { status: 204 });
    }
    return productPage(TARGET, [], {
      sizes: [{ merchSkuId: 'sku-27', localizedLabel: '27', status: inStock ? 'ACTIVE' : 'OUT_OF_STOCK' }],
    });
  };
  let engine = createMonitorEngine({ env, state: cache(timestamp, { lastStockKey: '27' }),
    now: () => timestamp, notify: false, fetchImpl });
  await engine.tick();
  timestamp += 120000;
  await engine.tick();
  assert.equal(engine.snapshot().knownProducts[TARGET].lastStockKey, '27');
  assert.equal(engine.snapshot().knownProducts[TARGET].shadowNotificationState.lastStockKey, '');
  inStock = true;
  timestamp += 120000;
  engine = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp, fetchImpl });
  assert.equal((await engine.tick()).notified, true);
  assert.equal(posts, 1);
});

test('failed observation persistence prevents any Discord send', async () => {
  let posts = 0;
  const timestamp = Date.now();
  const engine = createMonitorEngine({
    env: environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK }), state: cache(timestamp),
    now: () => timestamp,
    fetchImpl: async (url) => {
      if (url.startsWith('https://discord.com')) posts += 1;
      return productPage();
    },
    persist: async () => { throw new Error('storage unavailable'); },
  });
  await assert.rejects(engine.tick(), /保存に失敗/);
  assert.equal(posts, 0);
});

test('upcoming items keep the thirty second cadence across cache rehydration', async () => {
  const timestamp = Date.now();
  const env = environment();
  const engine = createMonitorEngine({ env, state: cache(timestamp), now: () => timestamp,
    fetchImpl: async () => productPage(TARGET, ['27'], {
      launchDate: iso(timestamp + 3600000), featuredAttributes: ['COMING_SOON'],
    }) });
  await engine.tick();
  const next = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp });
  assert.equal(next.nextAlarmAt(), timestamp + 30000);
  assert.equal(next.status().nextCheckAt, iso(timestamp + 30000));
  assert.equal(next.status().lastResult.availabilityState, 'coming-soon');
});

test('two independent product failures trigger persisted fleet backoff', async () => {
  let timestamp = Date.now();
  let requests = 0;
  const env = environment([TARGET, OTHER]);
  const fetchImpl = async () => {
    requests += 1;
    return new Response('Unavailable', { status: 503 });
  };
  const engine = createMonitorEngine({ env, state: cache(timestamp), now: () => timestamp, fetchImpl });
  await engine.tick();
  assert.equal(engine.snapshot().consecutiveFailedCycles, 0);
  timestamp += 1500;
  await engine.tick();
  assert.equal(engine.snapshot().consecutiveFailedCycles, 1);
  assert.equal(engine.nextAlarmAt(), timestamp + 240000);
  const restored = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp, fetchImpl });
  assert.equal((await restored.tick()).kind, 'idle');
  assert.equal(requests, 6);
});

test('failing upcoming products cannot starve an unseen healthy product that clears fleet backoff', async () => {
  let timestamp = Date.now();
  const normal = 'HQ4307-001';
  const state = cache(timestamp, {}, { knownProducts: Object.fromEntries(
    [TARGET, OTHER, normal].map((styleColor) => [styleColor, {
      styleColor, url: urlFor(styleColor),
      ...(styleColor !== normal ? { upcomingReleaseAt: iso(timestamp + 3600000) } : {}),
    }]),
  ) });
  let checking;
  const attempts = [];
  const engine = createMonitorEngine({
    env: environment([TARGET, OTHER, normal]), state, now: () => timestamp,
    fetchImpl: async (url) => {
      if (url.includes('/t/')) checking = url.match(/HQ4307-\d{3}/)[0];
      if (checking === normal) return productPage(normal);
      // Three failed fallback requests take as long as an upcoming interval.
      timestamp += 10000;
      return new Response('Unavailable', { status: 503 });
    },
  });
  for (let step = 0; step < 3; step += 1) {
    const result = await engine.tick();
    assert.equal(result.kind, 'check');
    attempts.push(result.styleColor);
    if (step === 1) {
      assert.equal(engine.snapshot().consecutiveFailedCycles, 1);
      assert.equal(engine.nextAlarmAt(), timestamp + 240000);
    }
    timestamp = engine.nextAlarmAt();
  }
  assert.deepEqual(attempts, [OTHER, TARGET, normal]);
  assert.equal(engine.snapshot().consecutiveFailedCycles, 0);
  assert.equal(engine.snapshot().failureBackoffUntil, null);
});

test('an overdue normal deadline precedes a recently due upcoming check', async () => {
  const timestamp = Date.now();
  let checked;
  const state = cache(timestamp, { lastSeenAt: iso(timestamp - 600000) });
  state.knownProducts[OTHER] = {
    styleColor: OTHER, url: urlFor(OTHER), lastSeenAt: iso(timestamp - 60000),
    upcomingReleaseAt: iso(timestamp + 3600000),
  };
  const engine = createMonitorEngine({ env: environment([TARGET, OTHER]), state,
    now: () => timestamp, fetchImpl: async (url) => {
      checked = url.match(/HQ4307-\d{3}/)[0];
      return productPage(checked);
    } });
  await engine.tick();
  assert.equal(checked, TARGET);
  assert.equal(engine.nextAlarmAt(), timestamp + 1500);
});

test('unknown observations freeze OOS confirmation and notification keys', async () => {
  let timestamp = Date.now();
  const env = environment();
  let engine = createMonitorEngine({ env, state: cache(timestamp, { lastStockKey: '27', oosStreak: 1 }),
    now: () => timestamp, fetchImpl: async () => new Response(`
      <html><head><meta property="og:title" content="Nike Mind 001"></head>
      <body><script>{"localizedSize":"27"}</script><p>近日発売</p></body></html>`),
  });
  await engine.tick();
  assert.equal(engine.status().lastResult.availabilityState, 'unknown');
  assert.equal(engine.snapshot().knownProducts[TARGET].oosStreak, 1);
  assert.equal(engine.snapshot().knownProducts[TARGET].lastStockKey, '27');
  timestamp += 120000;
  engine = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp,
    fetchImpl: async () => productPage(TARGET, [], {
      sizes: [{ merchSkuId: 'sku-27', localizedLabel: '27', status: 'OUT_OF_STOCK' }],
    }) });
  await engine.tick();
  assert.equal(engine.snapshot().knownProducts[TARGET].oosStreak, 2);
  assert.equal(engine.snapshot().knownProducts[TARGET].lastStockKey, '');
});

test('mixed size replacement requires two observations before notification', async () => {
  let timestamp = Date.now();
  let posts = 0;
  const env = environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK });
  const fetchImpl = async (url) => {
    if (url.startsWith('https://discord.com')) {
      posts += 1;
      return new Response(null, { status: 204 });
    }
    return productPage(TARGET, ['28']);
  };
  let engine = createMonitorEngine({ env, state: cache(timestamp, { lastStockKey: '27' }),
    now: () => timestamp, fetchImpl });
  await engine.tick();
  assert.equal(posts, 0);
  assert.equal(engine.snapshot().knownProducts[TARGET].lastStockKey, '27');
  timestamp += 120000;
  engine = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp, fetchImpl });
  await engine.tick();
  assert.equal(posts, 1);
  assert.equal(engine.snapshot().knownProducts[TARGET].lastStockKey, '28');
});

test('a delisted product pauses, rechecks after its pause cadence, then resumes on success', async () => {
  let timestamp = Date.now();
  const env = environment([TARGET], { DELIST_FAILURE_THRESHOLD: '3', PAUSED_RECHECK_HOURS: '1' });
  let engine = createMonitorEngine({
    env, state: cache(timestamp, { missingStreak: 2 }), now: () => timestamp,
    fetchImpl: async () => new Response('Not Found', { status: 404 }),
  });
  await engine.tick();
  assert.equal(engine.snapshot().knownProducts[TARGET].pausedReason, 'delisted');
  assert.equal(engine.nextAlarmAt(), timestamp + 3600000);
  timestamp += 3600000;
  engine = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp,
    fetchImpl: async () => productPage() });
  await engine.tick();
  assert.equal(engine.snapshot().knownProducts[TARGET].pausedAt, null);
  assert.equal(engine.status().metrics.activeProducts, 1);
  assert.equal(engine.nextAlarmAt(), timestamp + 120000);
});

test('catalog discovery is one page per alarm and partial failure cannot mark products absent', async () => {
  let timestamp = Date.now();
  let requests = 0;
  const env = environment([], { FRAGMENT_DISCOVERY_URLS: 'https://www.nike.com/jp/launch' });
  let engine = createMonitorEngine({ env, state: {
    knownProducts: { [TARGET]: { styleColor: TARGET, url: urlFor(TARGET), catalogPresent: true } },
  }, now: () => timestamp, fetchImpl: async () => {
    requests += 1;
    return new Response(`<a href="/jp/t/nike-mind-001-mens/HQ4307-003">Mind 001</a>`);
  } });
  const first = await engine.tick();
  assert.equal(first.kind, 'discovery');
  assert.equal(first.completed, false);
  assert.equal(requests, 1);
  assert.equal(engine.snapshot().discoveryCycle.index, 1);
  timestamp += 1500;
  engine = createMonitorEngine({ env, state: engine.snapshot(), now: () => timestamp,
    fetchImpl: async () => { requests += 1; return new Response('Unavailable', { status: 503 }); } });
  assert.equal((await engine.tick()).completed, true);
  assert.equal(requests, 2);
  assert.equal(engine.snapshot().knownProducts[TARGET].catalogPresent, true);
  assert.equal(engine.snapshot().discoveryCycle, null);
  assert.match(engine.status().discovery.lastError, /Fragment/);
  assert.equal(engine.nextAlarmAt(), timestamp + 30 * 60000);
});

test('legacy state and ten thousand quality samples survive while women products are excluded', () => {
  const timestamp = Date.now();
  const state = cache(timestamp, {}, {
    lastStockKey: '27',
    events: Array.from({ length: 90 }, (_, id) => ({ id, at: iso(timestamp), type: 'check' })),
    history: Array.from({ length: 310 }, () => ({ styleColor: TARGET, at: iso(timestamp) })),
    checkSamples: Array.from({ length: 10030 }, () => ({
      at: iso(timestamp), styleColor: TARGET, ok: true, durationMs: 20,
    })),
  });
  state.knownProducts['HQ4309-001'] = { url: urlFor('HQ4309-001'), lastStockKey: '27' };
  const engine = createMonitorEngine({ state, now: () => timestamp });
  const status = engine.status();
  const snapshot = engine.snapshot();
  assert.equal(snapshot.knownProducts[TARGET].lastStockKey, '27');
  assert.equal(snapshot.lastStockKey, undefined);
  assert.equal(snapshot.knownProducts['HQ4309-001'], undefined);
  assert.equal(snapshot.checkSamples.length, 10000);
  assert.equal(status.metrics.checks, 10000);
  assert.equal(status.events.length, 80);
  assert.equal(status.history.length, 300);
  assert.equal(status.schemaVersion, 3);
});

test('initial seeds retain imported canonical URLs while fresh catalog results may update them', async () => {
  const timestamp = Date.now();
  const canonicalUrl = `https://www.nike.com/jp/t/mind-001-current/${TARGET}`;
  const env = environment([]);
  const imported = createMonitorEngine({ env, state: cache(timestamp, {
    url: canonicalUrl, source: 'catalog', lastStockKey: '27',
  }), now: () => timestamp });
  assert.equal(imported.snapshot().knownProducts[TARGET].url, canonicalUrl);
  const state = imported.snapshot();
  delete state.lastDiscoverySuccessAt;
  delete state.lastDiscoveryAt;
  const updatedPath = `/jp/t/mind-001-updated/${TARGET}`;
  const refreshed = createMonitorEngine({ env, state, now: () => timestamp,
    fetchImpl: async () => new Response(`<a href="${updatedPath}">Mind 001</a>`),
  });
  await refreshed.tick();
  assert.equal(refreshed.snapshot().knownProducts[TARGET].url, `https://www.nike.com${updatedPath}`);
  assert.equal(refreshed.snapshot().knownProducts[TARGET].lastStockKey, '27');
  const restarted = createMonitorEngine({ env, state: refreshed.snapshot(), now: () => timestamp });
  assert.equal(restarted.snapshot().knownProducts[TARGET].url, `https://www.nike.com${updatedPath}`);
});

test('an initial seed can repair a malformed imported URL without dropping notification state', () => {
  const timestamp = Date.now();
  const engine = createMonitorEngine({ state: cache(timestamp, {
    url: `https://www.nike.com/jp/t/[object%20Object]/${TARGET}`, lastStockKey: '27',
  }), now: () => timestamp });
  const entry = engine.snapshot().knownProducts[TARGET];
  assert.equal(entry.url, DEFAULT_MIND_001_URLS.find((url) => url.endsWith(`/${TARGET}`)));
  assert.equal(entry.lastStockKey, '27');
});

test('legacy object-path repair retains a pause until authoritative rediscovery schedules a probe', async () => {
  const timestamp = Date.now();
  const target = 'HQ4307-300';
  const canonical = `https://www.nike.com/jp/t/mind-001-current/${target}`;
  const env = environment([target]);
  const state = {
    knownProducts: { [target]: {
      styleColor: target,
      url: `https://www.nike.com/jp/t/mind-001-current/[object%20Object]/${target}`,
      lastStockKey: '27', pausedAt: iso(timestamp), pausedReason: 'unreachable',
      catalogPresent: true, lastSeenAt: iso(timestamp),
    } },
  };
  const engine = createMonitorEngine({ env, state, now: () => timestamp,
    fetchImpl: async () => new Response(`<a href="${canonical}">Mind 001</a>`),
  });
  let entry = engine.snapshot().knownProducts[target];
  assert.equal(entry.url, canonical);
  assert.equal(entry.pausedAt, iso(timestamp));
  assert.equal(entry.catalogReprobePending, false);
  assert.equal(entry.urlRepairPending, true);
  assert.equal((await engine.tick()).kind, 'discovery');
  entry = engine.snapshot().knownProducts[target];
  assert.equal(entry.lastStockKey, '27');
  assert.equal(entry.pausedAt, iso(timestamp));
  assert.equal(entry.catalogReprobePending, true);
  assert.equal(entry.lastSeenAt, null);
  assert.equal(entry.urlRepairPending, false);
});

test('response size limit rejects an oversized body before parsing and fails closed', async () => {
  const timestamp = Date.now();
  let requests = 0;
  const engine = createMonitorEngine({
    env: environment([TARGET], { MAX_NIKE_RESPONSE_BYTES: '65536' }), state: cache(timestamp),
    now: () => timestamp, fetchImpl: async () => {
      requests += 1;
      return new Response('x'.repeat(65537));
    },
  });
  const result = await engine.tick();
  assert.equal(result.ok, false);
  assert.equal(requests, 3);
  assert.match(engine.status().lastResult.errors[0], /maximum allowed size/);
});

test('invalid product settings disable alarms and all outbound requests', async () => {
  let requests = 0;
  const engine = createMonitorEngine({ env: { PRODUCT_CONFIG_JSON: '{broken' },
    fetchImpl: async () => { requests += 1; throw new Error('unexpected request'); } });
  assert.equal((await engine.tick()).kind, 'idle');
  assert.equal(engine.nextAlarmAt(), null);
  assert.equal(requests, 0);
  assert.ok(engine.status().config.productConfigError);
});

test('a normal unchanged stock check commits its observation and scheduling once', async () => {
  const timestamp = Date.now();
  const saves = [];
  const engine = createMonitorEngine({ env: environment(), state: cache(timestamp, { lastStockKey: '27' }),
    now: () => timestamp, fetchImpl: async () => productPage(),
    persist: async (state, status) => saves.push({ state, status }),
  });
  await engine.tick();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].state.lastTickAt, iso(timestamp));
  assert.equal(saves[0].status.metrics.checks, 1);
  assert.equal(saves[0].status.nextCheckAt, iso(timestamp + 120000));
});

test('a notification keeps its pending commit before the send and its acknowledgment afterward', async () => {
  const timestamp = Date.now();
  const steps = [];
  const engine = createMonitorEngine({ env: environment([TARGET], { DISCORD_WEBHOOK: WEBHOOK }),
    state: cache(timestamp), now: () => timestamp,
    fetchImpl: async (url) => {
      if (url.startsWith('https://discord.com')) {
        steps.push('send');
        return new Response(null, { status: 204 });
      }
      return productPage();
    },
    persist: async (state) => {
      const entry = state.knownProducts[TARGET];
      steps.push(entry.lastStockKey === '27' ? 'acknowledged' : 'pending');
      assert.equal(Boolean(entry.pendingNotification), entry.lastStockKey !== '27');
    },
  });
  assert.equal((await engine.tick()).notified, true);
  assert.deepEqual(steps, ['pending', 'send', 'acknowledged']);
});

test('failed catalog rechecks return to the paused interval after three attempts across restarts', async () => {
  let timestamp = Date.now();
  const env = environment([TARGET], { DISCOVERY_INTERVAL_HOURS: '168' });
  let state = cache(timestamp, {
    lastStockKey: '27', pausedAt: iso(timestamp), pausedReason: 'unreachable',
    catalogPresent: true, catalogReprobePending: true, lastSeenAt: null,
  });
  let engine;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    engine = createMonitorEngine({ env, state, now: () => timestamp,
      fetchImpl: async () => new Response('Unavailable', { status: 503 }),
    });
    assert.equal((await engine.tick()).kind, 'check');
    state = engine.snapshot();
    assert.ok(state.knownProducts[TARGET].pausedAt);
    assert.equal(state.knownProducts[TARGET].lastStockKey, '27');
    if (attempt < 2) timestamp = engine.nextAlarmAt();
  }
  assert.equal(state.knownProducts[TARGET].catalogReprobePending, false);
  assert.equal(engine.nextAlarmAt(), timestamp + 24 * 3600000);
});

test('catalog rechecks tolerate transient failures and a successful retry resumes normal monitoring', async () => {
  let timestamp = Date.now();
  const env = environment();
  let state = cache(timestamp, {
    pausedAt: iso(timestamp), pausedReason: 'unreachable', catalogReprobePending: true,
  });
  let engine;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    engine = createMonitorEngine({ env, state, now: () => timestamp,
      fetchImpl: async () => attempt < 2 ? new Response('Unavailable', { status: 503 }) : productPage(),
    });
    await engine.tick();
    state = engine.snapshot();
    if (attempt < 2) timestamp = engine.nextAlarmAt();
  }
  assert.equal(state.knownProducts[TARGET].pausedAt, null);
  assert.equal(state.knownProducts[TARGET].catalogReprobePending, false);
  assert.equal(state.knownProducts[TARGET].catalogReprobeFailures, 0);
  assert.equal(engine.nextAlarmAt(), timestamp + 120000);
});

test('a new authoritative URL schedules a paused product once without blindly resuming it', async () => {
  const timestamp = Date.now();
  const updatedUrl = `https://www.nike.com/jp/t/mind-001-new-route/${TARGET}`;
  const state = cache(timestamp, {
    pausedAt: iso(timestamp), pausedReason: 'unreachable', lastSeenAt: iso(timestamp),
    lastStockKey: '27', catalogPresent: true,
  });
  delete state.lastDiscoveryAt;
  delete state.lastDiscoverySuccessAt;
  const engine = createMonitorEngine({ env: environment(), state, now: () => timestamp,
    fetchImpl: async () => new Response(`<a href="${updatedUrl}">Mind 001</a>`),
  });
  await engine.tick();
  const entry = engine.snapshot().knownProducts[TARGET];
  assert.equal(entry.url, updatedUrl);
  assert.equal(entry.catalogReprobePending, true);
  assert.equal(entry.lastSeenAt, null);
  assert.equal(entry.pausedAt, iso(timestamp));
  assert.equal(entry.lastStockKey, '27');

  const attempted = engine.snapshot();
  attempted.discoveryCycle = null;
  attempted.knownProducts[TARGET].catalogReprobePending = false;
  attempted.knownProducts[TARGET].catalogReprobeFailures = 3;
  attempted.knownProducts[TARGET].lastSeenAt = iso(timestamp);
  const unchanged = createMonitorEngine({ env: environment(), state: attempted, now: () => timestamp,
    fetchImpl: async () => new Response(`<a href="${updatedUrl}">Mind 001</a>`),
  });
  await unchanged.tick();
  assert.equal(unchanged.snapshot().knownProducts[TARGET].catalogReprobePending, false);
  assert.equal(unchanged.snapshot().knownProducts[TARGET].lastSeenAt, iso(timestamp));
});

test('a seeded Fragment must disappear and reappear according to the actual catalog', async () => {
  let timestamp = Date.now();
  let present = false;
  const fragment = DEFAULT_FRAGMENT_PRODUCTS[0];
  const env = environment([fragment.styleColor], { FRAGMENT_DISCOVERY_URLS: 'https://www.nike.com/jp/launch' });
  let state = { knownProducts: { [fragment.styleColor]: {
    ...fragment, pausedAt: iso(timestamp), pausedReason: 'delisted',
    lastSeenAt: iso(timestamp), catalogPresent: true, lastStockKey: '27',
  } } };
  const fetchImpl = async (url) => {
    if (!url.includes('/launch')) return new Response(`<a href="${urlFor(TARGET)}">Mind 001</a>`);
    const products = present ? { frag: { styleColor: fragment.styleColor, title: 'Mind 001 x Fragment', genders: ['MEN'] } } : {};
    const threads = present ? { frag: {
      seo: { slug: 'mind-001-fragment-black' }, coverCard: { subtitle: 'Mind 001 x Fragment' },
      cards: [{ actions: [{ product: { productId: 'frag', styleColor: fragment.styleColor } }] }],
    } } : {};
    return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: {
      initialState: { product: { products: { data: { items: products } }, threads: { data: { items: threads } } } },
    } } })}</script>`);
  };
  for (let index = 0; index < 2; index += 1) {
    const engine = createMonitorEngine({ env, state, now: () => timestamp, notify: false, fetchImpl });
    assert.equal((await engine.tick()).kind, 'discovery');
    state = engine.snapshot();
    if (index === 0) timestamp = engine.nextAlarmAt();
  }
  assert.equal(state.knownProducts[fragment.styleColor].catalogPresent, false);
  present = true;
  timestamp += 6 * 3600000;
  for (let index = 0; index < 2; index += 1) {
    const engine = createMonitorEngine({ env, state, now: () => timestamp, notify: false, fetchImpl });
    assert.equal((await engine.tick()).kind, 'discovery');
    state = engine.snapshot();
    if (index === 0) timestamp = engine.nextAlarmAt();
  }
  const entry = state.knownProducts[fragment.styleColor];
  assert.equal(entry.catalogPresent, true);
  assert.equal(entry.catalogReprobePending, true);
  assert.equal(entry.lastSeenAt, null);
  assert.equal(entry.lastStockKey, '27');
  assert.ok(entry.pausedAt);
});
