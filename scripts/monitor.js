import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  discordAllowedMentions,
  normalizeDiscordWebhook,
  postDiscordWebhook,
  scrubDiscordWebhook,
} from '../src/discord.js';
import { checkNikeStock, parseNikeProductUrl } from '../src/nike.js';
import {
  DEFAULT_DISCOVERY_URL,
  DEFAULT_MIND_001_URLS,
  discoverNikeMind001Products,
} from '../src/discovery.js';
import {
  applyCheckState,
  collectMonitorErrors,
  millisecondsUntilFailureBackoff,
  nextFailureBackoffUntil,
  nextFailureWindowState,
  notificationDecision,
  shouldStopDuringSweep,
} from '../src/monitor-state.js';
import {
  applyRuntimeFailure,
  computeQualityMetrics,
  formatStockLabels,
  hasRecentSuccessForOtherProduct,
  isUpcomingPriority,
  millisecondsUntilProductDue,
  normalizeDiscordMention,
  parseProductConfigSafely,
  recordStockTransition,
  settingsForProduct,
  shouldChainNextRun,
  shouldCheckProductNow,
  updateDelistState,
  updateCatalogPresence,
  updateUpcomingState,
} from '../src/monitor-policy.js';

const STATE_DIR = '.monitor-state';
const STATE_PATH = `${STATE_DIR}/state.json`;
const STATUS_PATH = 'public/status.json';
const MAX_EVENTS = 80;
const MAX_HISTORY = 300;
const MAX_CHECK_SAMPLES = 10000;

const configuredProductUrls = splitUrls(process.env.PRODUCT_URLS);
if (process.env.PRODUCT_URL) configuredProductUrls.push(process.env.PRODUCT_URL);
const productConfigResult = parseProductConfigSafely(process.env.PRODUCT_CONFIG_JSON);
if (productConfigResult.error) {
  console.warn(`${productConfigResult.error}; monitoring and notifications are disabled.`);
}

const config = {
  productUrl:
    process.env.PRODUCT_URL ||
    DEFAULT_MIND_001_URLS.find((url) => url.endsWith('/HQ4307-005')) ||
    DEFAULT_MIND_001_URLS[0],
  seedUrls: unique([...DEFAULT_MIND_001_URLS, ...configuredProductUrls]),
  discoveryUrl: process.env.DISCOVERY_URL || DEFAULT_DISCOVERY_URL,
  discoveryIntervalHours: clampNumber(process.env.DISCOVERY_INTERVAL_HOURS, 6, 1, 168),
  discoveryRetryMinutes: clampNumber(process.env.DISCOVERY_RETRY_MINUTES, 30, 5, 360),
  sizeFilters: process.env.SIZE_FILTERS || '',
  intervalSeconds: clampNumber(process.env.INTERVAL_SECONDS, 120, 30, 1800),
  loopMinutes: clampNumber(process.env.LOOP_MINUTES, 25, 0, 340),
  productCheckDelayMs: clampNumber(process.env.PRODUCT_CHECK_DELAY_MS, 1500, 0, 30000),
  productConfig: productConfigResult.config,
  productConfigError: productConfigResult.error,
  delistFailureThreshold: clampNumber(process.env.DELIST_FAILURE_THRESHOLD, 12, 3, 100),
  pausedRecheckHours: clampNumber(process.env.PAUSED_RECHECK_HOURS, 24, 1, 168),
  upcomingIntervalSeconds: clampNumber(process.env.UPCOMING_INTERVAL_SECONDS, 30, 15, 600),
  upcomingWindowMinutes: clampNumber(process.env.UPCOMING_WINDOW_MINUTES, 180, 15, 1440),
  discordMention: configuredDiscordMention(process.env.DISCORD_MENTION),
  discordWebhook: configuredDiscordWebhook(process.env.DISCORD_WEBHOOK || ''),
};

await mkdir(STATE_DIR, { recursive: true });

const state = await readJson(STATE_PATH, {});
state.knownProducts = normalizeKnownProducts(state.knownProducts);
const events = Array.isArray(state.events) ? state.events.slice(0, MAX_EVENTS) : [];
const history = Array.isArray(state.history) ? state.history.slice(0, MAX_HISTORY) : [];
state.checkSamples = normalizeCheckSamples(state.checkSamples);

for (const url of config.seedUrls) addKnownProduct({ url }, 'initial');

// 旧バージョンの単一商品通知状態を引き継ぐ。
if (state.lastStockKey && state.knownProducts['HQ4307-005']?.lastStockKey === '') {
  state.knownProducts['HQ4307-005'].lastStockKey = state.lastStockKey;
}
delete state.lastStockKey;

const singleSweep = config.loopMinutes === 0;
const deadline = Date.now() + config.loopMinutes * 60 * 1000;
let cycles = 0;
let checks = 0;
let notifications = 0;
state.consecutiveFailedCycles = Math.max(0, Number(state.consecutiveFailedCycles) || 0);

if (!config.productConfigError) await discoverProductsIfDue();

for (;;) {
  cycles += 1;
  const activeFleet = monitorableProducts().filter((product) => !product.pausedAt);
  const products = productsDueForCheck();
  const cycleAttempts = [];

  for (let index = 0; index < products.length; index += 1) {
    const countedAsActive = !products[index].pausedAt;
    const attemptStartedAt = Date.now();
    checks += 1;
    try {
      const outcome = await runCheck(products[index]);
      if (outcome.notified) notifications += 1;
      if (countedAsActive) {
        cycleAttempts.push({ styleColor: products[index].styleColor, ok: outcome.ok });
      }
    } catch (error) {
      const checkedAt = new Date().toISOString();
      if (countedAsActive) {
        cycleAttempts.push({ styleColor: products[index].styleColor, ok: false });
      }
      const sample = applyRuntimeFailure(products[index], error, {
        checkedAt,
        durationMs: Date.now() - attemptStartedAt,
      });
      recordCheckSample(sample);
      pushEvent({
        id: `actions-error-${Date.now()}`,
        type: 'error',
        message: `${products[index].styleColor} の監視処理でエラー: ${error.message}`,
        at: checkedAt,
        result: null,
      });
      await persist(checkedAt);
    }

    // スイープ途中でも deadline を超えたら打ち切る。商品数が増えても最終スイープが
    // timeout-minutes を突き抜けてジョブが timeout/cancel されるのを防ぐ。
    if (shouldStopDuringSweep({ singleSweep, deadline })) {
      break;
    }

    if (index < products.length - 1 && config.productCheckDelayMs > 0) {
      await sleep(config.productCheckDelayMs);
    }
  }

  // due方式では1サイクルが部分巡回になるため、直近の時間窓で複数商品がすべて失敗した
  // 場合をフリート障害とみなす。単一商品の恒久失敗では全体を減速しない。
  const failureState = nextFailureWindowState(
    state.consecutiveFailedCycles,
    state.failureWindow,
    {
      attempts: cycleAttempts,
      activeProducts: activeFleet.map((product) => product.styleColor),
      totalProducts: activeFleet.length,
      windowMinutes: fleetFailureWindowMinutes(activeFleet.length),
    },
  );
  state.consecutiveFailedCycles = failureState.streak;
  state.failureWindow = failureState.window;
  const cycleCompletedAt = Date.now();
  state.failureBackoffUntil = nextFailureBackoffUntil(state.failureBackoffUntil, {
    attempted: cycleAttempts.length > 0,
    streak: state.consecutiveFailedCycles,
    intervalSeconds: config.intervalSeconds,
    now: cycleCompletedAt,
  });
  const scheduledWaitMs = nextScheduledWaitMs(cycleCompletedAt);
  const failureWaitMs = millisecondsUntilFailureBackoff(
    state.failureBackoffUntil,
    cycleCompletedAt,
  );
  const waitMs = Math.max(1000, scheduledWaitMs, failureWaitMs);
  await persist(new Date(cycleCompletedAt).toISOString());
  if (singleSweep || Date.now() + waitMs > deadline) break;
  await sleep(waitMs);
  if (!config.productConfigError) await discoverProductsIfDue();
}

const nextEffectiveWait = nextEffectiveWaitMs();
const nextDueMinutes = Number.isFinite(nextEffectiveWait)
  ? Math.max(0, Math.ceil(nextEffectiveWait / 60000))
  : null;
const shouldChain = shouldChainNextRun({
  singleSweep,
  monitorableProductCount: monitorableProducts().length,
  nextDueMinutes,
  loopMinutes: config.loopMinutes,
});
await writeActionOutput('next_due_minutes', nextDueMinutes ?? '');
await writeActionOutput('should_chain', shouldChain);

console.log(
  JSON.stringify(
    {
      cycles,
      checks,
      notifications,
      trackedProducts: trackedProducts().map((product) => product.styleColor),
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      lastDiscoveryAt: state.lastDiscoveryAt || null,
      consecutiveFailedCycles: state.consecutiveFailedCycles,
      nextDueMinutes,
      shouldChain,
    },
    null,
    2,
  ),
);

async function discoverProductsIfDue() {
  const lastAttemptAt = Date.parse(state.lastDiscoveryAttemptAt || state.lastDiscoveryAt || '');
  const lastSuccessAt = Date.parse(
    state.lastDiscoverySuccessAt || (state.lastDiscoveryError ? '' : state.lastDiscoveryAt) || '',
  );
  const retryWaitMs = config.discoveryRetryMinutes * 60 * 1000;
  const regularWaitMs = config.discoveryIntervalHours * 3600 * 1000;
  const requiredWaitMs = state.lastDiscoveryError ? retryWaitMs : regularWaitMs;
  const referenceTime = state.lastDiscoveryError ? lastAttemptAt : lastSuccessAt;

  if (Number.isFinite(referenceTime) && Date.now() - referenceTime < requiredWaitMs) {
    return;
  }

  const checkedAt = new Date().toISOString();
  const discovery = await discoverNikeMind001Products({
    catalogUrl: config.discoveryUrl,
    timeoutMs: 20000,
  });
  state.lastDiscoveryAt = checkedAt;
  state.lastDiscoveryAttemptAt = checkedAt;
  state.lastDiscoveryError = discovery.error;

  if (discovery.error) {
    pushEvent({
      id: `discovery-error-${Date.now()}`,
      type: 'error',
      message: `新カラー探索に失敗しました: ${discovery.error}`,
      at: checkedAt,
      result: null,
    });
  } else {
    state.lastDiscoverySuccessAt = checkedAt;
    const added = addKnownProducts(discovery.products, 'catalog');
    const reprobe = updateCatalogPresence(trackedProducts(), discovery.products, checkedAt);
    if (reprobe.length) {
      pushEvent({
        id: `catalog-reprobe-${Date.now()}`,
        type: 'lifecycle',
        message: `カタログへ再出現したため即時再確認: ${reprobe.join(', ')}`,
        at: checkedAt,
        result: null,
      });
    }
    pushEvent({
      id: `discovery-${Date.now()}`,
      type: 'discovery',
      message: added.length
        ? `新しいMind 001を検出: ${added.join(', ')}`
        : `新カラー探索完了: ${trackedProducts().length}商品を追跡中`,
      at: checkedAt,
      result: null,
    });
  }

  await persist(checkedAt);
}

async function runCheck(entry) {
  const settings = productSettings(entry);
  const startedAt = Date.now();
  const result = await checkNikeStock(entry.url, {
    sizeFilters: settings.sizeFilters,
    timeoutMs: 20000,
  });
  const durationMs = Date.now() - startedAt;
  const checkedAt = result.checkedAt || new Date().toISOString();
  const styleColor = result.product?.styleColor || entry.styleColor;
  updateUpcomingState(entry, result, { now: Date.parse(checkedAt) });
  const decision = notificationDecision(entry, result);
  const { nextStockKey, previousStockKey, addedSizes, shouldNotify } = decision;
  recordCheckSample({ at: checkedAt, styleColor, ok: result.ok, durationMs, inStock: result.inStock });
  const stockTransition = recordStockTransition(entry, result, { now: checkedAt });
  if (stockTransition) {
    history.unshift(stockTransition);
    history.splice(MAX_HISTORY);
    pushEvent({
      id: `stock-change-${Date.now()}-${styleColor}`,
      type: 'stock-change',
      message: stockTransition.message,
      at: checkedAt,
      result: null,
    });
  }
  const lifecycleTransition = updateDelistState(entry, result, {
    threshold: config.delistFailureThreshold,
    unreachableThreshold: config.delistFailureThreshold * 4,
    allowUnreachablePause: hasRecentSuccessForOtherProduct(state.checkSamples, styleColor, {
      now: Date.parse(checkedAt),
      windowMinutes: fleetFailureWindowMinutes(
        monitorableProducts().filter((product) => !product.pausedAt).length,
      ),
    }),
    now: checkedAt,
  });
  if (lifecycleTransition) {
    pushEvent({
      id: `lifecycle-${Date.now()}-${styleColor}`,
      type: 'lifecycle',
      message: lifecycleTransition === 'paused'
        ? entry.pausedReason === 'unreachable'
          ? `${styleColor}: 長時間確認できないため監視を自動休止しました`
          : `${styleColor}: 販売終了候補として監視を自動休止しました`
        : `${styleColor}: 商品を再確認できたため監視を再開しました`,
      at: checkedAt,
      result: null,
    });
  }
  const relatedAdded = addKnownProducts(result.relatedProducts || [], 'product-page');

  if (relatedAdded.length) {
    pushEvent({
      id: `related-${Date.now()}`,
      type: 'discovery',
      message: `商品ページから新カラーを検出: ${relatedAdded.join(', ')}`,
      at: checkedAt,
      result: null,
    });
  }

  const publicResult = withoutRelatedProducts(result);
  entry.lastResult = publicResult;
  entry.lastSeenAt = checkedAt;
  entry.lastRuntimeError = result.ok
    ? null
    : { message: `${styleColor} を確認できませんでした。`, at: checkedAt };
  if (result.product?.url) entry.url = result.product.url;

  pushEvent({
    id: `actions-${Date.now()}-${styleColor}`,
    type: result.ok ? 'check' : 'error',
    message: `${styleColor}: ${result.statusLabel}`,
    at: checkedAt,
    result: compactResult(publicResult),
  });

  let notified = false;
  const notificationEnabled = settings.notify && Boolean(config.discordWebhook);
  if (shouldNotify && notificationEnabled) {
    try {
      await sendDiscordNotification({
        webhook: config.discordWebhook,
        mention: settings.mention,
        title: `${result.product.title} (${styleColor}) が在庫あり`,
        message: addedSizes.length
          ? `新しく在庫になったサイズ: ${formatStockLabels(addedSizes)}`
          : '対象商品が購入できる可能性があります。',
        url: result.product.url,
        sizes: result.matchingSizes,
        newSizes: addedSizes,
        previousStockKey,
        price: result.product.price,
        checkedAt,
        imageUrl: result.product.imageUrl,
      });
      notified = true;
      pushEvent({
        id: `notify-${Date.now()}-${styleColor}`,
        type: 'notify',
        message: `Discordへ通知しました: ${styleColor} / ${result.statusLabel}`,
        at: new Date().toISOString(),
        result: null,
      });
    } catch (error) {
      pushEvent({
        id: `notify-error-${Date.now()}-${styleColor}`,
        type: 'error',
        message: `Discord通知に失敗しました (${styleColor}): ${scrubWebhook(error.message)}`,
        at: new Date().toISOString(),
        result: null,
      });
    }
  }

  applyCheckState(entry, result, {
    nextStockKey,
    shouldNotify,
    notified,
    webhookConfigured: notificationEnabled,
  });

  await persist(checkedAt);
  return { notified, ok: result.ok };
}

function addKnownProducts(products, source) {
  const added = [];
  for (const product of products) {
    const result = addKnownProduct(product, source);
    if (result.added) added.push(result.entry.styleColor);
  }
  return added;
}

function addKnownProduct(product, source) {
  let parsed;
  try {
    parsed = parseNikeProductUrl(product.url);
  } catch {
    return { added: false, entry: null };
  }

  const styleColor = String(product.styleColor || parsed.styleColor).toUpperCase();
  const existing = state.knownProducts[styleColor];
  if (existing) {
    if (product.url) existing.url = product.url;
    return { added: false, entry: existing };
  }

  const now = new Date().toISOString();
  const entry = {
    styleColor,
    url: product.url || parsed.url,
    source,
    discoveredAt: now,
    lastSeenAt: null,
    lastStockKey: '',
    lastObservedStockKey: undefined,
    observedOosStreak: 0,
    missingStreak: 0,
    unresolvedStreak: 0,
    pausedAt: null,
    pausedReason: '',
    catalogPresent: undefined,
    lastCatalogSeenAt: null,
    catalogReprobePending: false,
    upcomingReleaseAt: null,
    stockHistory: [],
    lastResult: null,
  };
  state.knownProducts[styleColor] = entry;
  return { added: true, entry };
}

function normalizeKnownProducts(value) {
  const normalized = {};
  if (!value || typeof value !== 'object') return normalized;

  for (const [key, product] of Object.entries(value)) {
    if (!product?.url) continue;
    try {
      const parsed = parseNikeProductUrl(product.url);
      const styleColor = String(product.styleColor || key || parsed.styleColor).toUpperCase();
      normalized[styleColor] = {
        styleColor,
        url: product.url,
        source: product.source || 'state',
        discoveredAt: product.discoveredAt || new Date().toISOString(),
        lastSeenAt: product.lastSeenAt || null,
        lastStockKey: product.lastStockKey || '',
        lastObservedStockKey: product.lastObservedStockKey,
        oosStreak: Number(product.oosStreak) || 0,
        observedOosStreak: Number(product.observedOosStreak) || 0,
        missingStreak: Number(product.missingStreak) || 0,
        unresolvedStreak: Number(product.unresolvedStreak) || 0,
        pausedAt: product.pausedAt || null,
        pausedReason: product.pausedReason || '',
        catalogPresent: typeof product.catalogPresent === 'boolean' ? product.catalogPresent : undefined,
        lastCatalogSeenAt: product.lastCatalogSeenAt || null,
        catalogReprobePending: product.catalogReprobePending === true,
        upcomingReleaseAt: product.upcomingReleaseAt || null,
        stockHistory: Array.isArray(product.stockHistory) ? product.stockHistory.slice(0, 60) : [],
        lastResult: product.lastResult || null,
        lastRuntimeError: product.lastRuntimeError || null,
      };
    } catch {
      // 壊れたキャッシュ項目は無視する。
    }
  }
  return normalized;
}

function trackedProducts() {
  return Object.values(state.knownProducts).sort((a, b) => a.styleColor.localeCompare(b.styleColor));
}

function monitorableProducts() {
  if (config.productConfigError) return [];
  return trackedProducts().filter((entry) => productSettings(entry).enabled);
}

function productsDueForCheck(now = Date.now()) {
  if (!singleSweep && millisecondsUntilFailureBackoff(state.failureBackoffUntil, now) > 0) {
    return [];
  }
  return monitorableProducts()
    .filter((entry) => shouldCheckProductNow(entry, {
      singleSweep,
      ...schedulingOptions(now),
    }))
    .sort((a, b) => {
      const priority = Number(isUpcomingPriority(b, now, config.upcomingWindowMinutes))
        - Number(isUpcomingPriority(a, now, config.upcomingWindowMinutes));
      return priority || a.styleColor.localeCompare(b.styleColor);
    });
}

function nextScheduledWaitMs(now = Date.now()) {
  const products = monitorableProducts();
  if (!products.length) return Number.POSITIVE_INFINITY;
  return Math.min(...products.map((entry) => millisecondsUntilProductDue(entry, schedulingOptions(now))));
}

function nextEffectiveWaitMs(now = Date.now()) {
  return Math.max(
    nextScheduledWaitMs(now),
    millisecondsUntilFailureBackoff(state.failureBackoffUntil, now),
  );
}

function schedulingOptions(now) {
  return {
    now,
    normalIntervalSeconds: config.intervalSeconds,
    upcomingIntervalSeconds: config.upcomingIntervalSeconds,
    upcomingWindowMinutes: config.upcomingWindowMinutes,
    pausedRecheckHours: config.pausedRecheckHours,
  };
}

function fleetFailureWindowMinutes(activeProductCount) {
  const fullCadenceMs =
    config.intervalSeconds * 1000 +
    Math.max(0, Number(activeProductCount) || 0) * config.productCheckDelayMs;
  // 最大10分のバックオフ中にも同じ障害窓を維持できる余裕を持たせる。
  return Math.max(15, Math.ceil(fullCadenceMs / 60000));
}

function productSettings(entry) {
  return settingsForProduct(
    config.productConfig,
    entry.styleColor,
    config.sizeFilters,
    config.discordMention,
  );
}

async function persist(updatedAt) {
  state.events = events;
  state.history = history;
  const monitorErrors = collectMonitorErrors(
    monitorableProducts().filter((product) => !product.pausedAt),
    state.lastDiscoveryError,
  );
  if (config.productConfigError) {
    monitorErrors.unshift(`商品別設定: ${config.productConfigError}`);
  }
  state.lastErrors = monitorErrors;
  state.lastError = monitorErrors[0] || null;

  const checkSamplesByProduct = groupCheckSamplesByProduct(state.checkSamples);
  const products = trackedProducts().map((entry) => {
    const settings = productSettings(entry);
    return {
      styleColor: entry.styleColor,
      url: entry.url,
      source: entry.source,
      discoveredAt: entry.discoveredAt,
      lastSeenAt: entry.lastSeenAt,
      pausedAt: entry.pausedAt,
      pausedReason: entry.pausedReason,
      missingStreak: entry.missingStreak,
      unresolvedStreak: entry.unresolvedStreak,
      catalogReprobePending: entry.catalogReprobePending === true,
      settings: {
        sizeFilters: settings.sizeFilters,
        notify: settings.notify,
        enabled: !config.productConfigError && settings.enabled,
      },
      stockHistory: entry.stockHistory || [],
      metrics: computeQualityMetrics(checkSamplesByProduct.get(entry.styleColor) || []),
      lastResult: entry.lastResult,
      lastError:
        entry.lastRuntimeError?.message ||
        (entry.lastResult?.ok === false ? entry.lastResult.statusLabel : null),
    };
  });
  const lastResult = products
    .map((product) => product.lastResult)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.checkedAt || '') - Date.parse(a.checkedAt || ''))[0] || null;

  const quality = computeQualityMetrics(state.checkSamples);
  const statusUpdatedAt = Date.parse(updatedAt);
  const nextWaitMs = nextEffectiveWaitMs(Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : Date.now());
  const publicStatus = {
    schemaVersion: 3,
    updatedAt,
    nextCheckAt: Number.isFinite(nextWaitMs)
      ? new Date((Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : Date.now()) + nextWaitMs).toISOString()
      : null,
    config: {
      productUrl: config.productUrl,
      productUrls: products.map((product) => product.url),
      productCount: products.length,
      discoveryUrl: config.discoveryUrl,
      discoveryIntervalHours: config.discoveryIntervalHours,
      discoveryRetryMinutes: config.discoveryRetryMinutes,
      sizeFilters: config.sizeFilters,
      intervalSeconds: config.intervalSeconds,
      loopMinutes: config.loopMinutes,
      productCheckDelayMs: config.productCheckDelayMs,
      delistFailureThreshold: config.delistFailureThreshold,
      pausedRecheckHours: config.pausedRecheckHours,
      upcomingIntervalSeconds: config.upcomingIntervalSeconds,
      upcomingWindowMinutes: config.upcomingWindowMinutes,
      productOverrides: publicProductOverrides(),
      productConfigError: config.productConfigError,
      discordWebhookSet: Boolean(config.discordWebhook),
    },
    discovery: {
      lastCheckedAt: state.lastDiscoveryAt || null,
      lastSuccessAt: state.lastDiscoverySuccessAt || null,
      lastError: state.lastDiscoveryError || null,
    },
    products,
    metrics: {
      ...quality,
      activeProducts: products.filter((product) => product.settings.enabled && !product.pausedAt).length,
      pausedProducts: products.filter((product) => product.pausedAt).length,
      disabledProducts: products.filter((product) => !product.settings.enabled).length,
      consecutiveFailedCycles: state.consecutiveFailedCycles,
    },
    history,
    lastResult,
    errors: monitorErrors,
    lastError: state.lastError,
    events,
  };

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  await writeFile(STATUS_PATH, JSON.stringify(publicStatus, null, 2), 'utf8');
}

function pushEvent(event) {
  events.unshift(event);
  events.splice(MAX_EVENTS);
}

function recordCheckSample(sample) {
  state.checkSamples.push(sample);
  state.checkSamples = normalizeCheckSamples(state.checkSamples);
}

function normalizeCheckSamples(value) {
  const cutoff = Date.now() - 25 * 3600 * 1000;
  const recent = [];
  for (const sample of Array.isArray(value) ? value : []) {
    const timestamp = Date.parse(sample?.at || '');
    if (Number.isFinite(timestamp) && timestamp >= cutoff) recent.push(sample);
  }
  return recent.slice(-MAX_CHECK_SAMPLES);
}

function groupCheckSamplesByProduct(samples) {
  const grouped = new Map();
  for (const sample of samples || []) {
    const styleColor = String(sample?.styleColor || '').toUpperCase();
    if (!styleColor) continue;
    const productSamples = grouped.get(styleColor) || [];
    productSamples.push(sample);
    grouped.set(styleColor, productSamples);
  }
  return grouped;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeActionOutput(name, value) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) return;
  await appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

function configuredDiscordWebhook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeDiscordWebhook(raw);
  if (normalized) return normalized;
  // 不正な値は通知を無効化する。生の値はログにも出さない(トークン漏洩防止)。
  console.warn('DISCORD_WEBHOOK is not a valid Discord webhook; Discord notifications are disabled.');
  return '';
}

function configuredDiscordMention(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeDiscordMention(raw);
  if (!normalized) {
    console.warn('DISCORD_MENTION is invalid; global mentions are disabled.');
  }
  return normalized;
}

function publicProductOverrides() {
  return Object.fromEntries(Object.entries(config.productConfig).map(([styleColor, settings]) => [
    styleColor,
    {
      sizeFilters: settings.sizeFilters,
      notify: settings.notify,
      enabled: settings.enabled,
    },
  ]));
}

// webhook URL(トークン)が公開 events / status.json 経由で GitHub Pages に漏れないよう、
// 通知失敗メッセージから webhook 文字列を伏せる。
function scrubWebhook(text) {
  return scrubDiscordWebhook(text, config.discordWebhook);
}

function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function splitUrls(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function withoutRelatedProducts(result) {
  const { relatedProducts: _relatedProducts, ...publicResult } = result;
  return publicResult;
}

function compactResult(result) {
  return {
    ok: result.ok,
    product: result.product,
    source: result.source,
    statusLabel: result.statusLabel,
    inStock: result.inStock,
    matchingSizes: result.matchingSizes,
    availabilityState: result.availabilityState,
    releaseAt: result.releaseAt,
    checkedAt: result.checkedAt,
  };
}

async function sendDiscordNotification({
  webhook,
  mention,
  title,
  message,
  url,
  sizes,
  newSizes,
  previousStockKey,
  price,
  checkedAt,
  imageUrl,
}) {
  const fields = [];
  if (newSizes?.length) {
    fields.push({ name: '新規サイズ', value: formatStockLabels(newSizes), inline: false });
  }
  if (sizes?.length) {
    fields.push({
      name: '現在の対象サイズ',
      value: sizes.map((size) => size.label).join(', '),
      inline: false,
    });
  }
  fields.push({
    name: '前回在庫',
    value: formatPreviousStock(previousStockKey),
    inline: true,
  });
  if (price) fields.push({ name: '価格', value: price, inline: true });
  fields.push({ name: '確認時刻', value: formatDiscordDate(checkedAt), inline: false });

  const allowedMentions = discordAllowedMentions(mention);

  await postDiscordWebhook(webhook, {
    content: mention || null,
    allowed_mentions: allowedMentions,
    embeds: [
      {
        title,
        description: message,
        url,
        color: 0x2f7d4a,
        fields,
        image: imageUrl ? { url: imageUrl } : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

function formatPreviousStock(value) {
  if (!value) return '在庫なし';
  if (value === '__product__') return '商品レベルで在庫あり';
  return value.split('|').filter(Boolean).join(', ') || '在庫なし';
}

function formatDiscordDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:F>` : '不明';
}
