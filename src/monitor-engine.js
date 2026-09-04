import {
  discordAllowedMentions,
  normalizeDiscordWebhook,
  postDiscordWebhook,
  scrubDiscordWebhook,
} from './discord.js';
import { checkNikeStock, parseNikeProductUrl } from './nike.js';
import {
  DEFAULT_DISCOVERY_URL,
  DEFAULT_FRAGMENT_DISCOVERY_URLS,
  DEFAULT_FRAGMENT_PRODUCTS,
  DEFAULT_MIND_001_URLS,
  discoverNikeFragmentProducts,
  discoverNikeMind001Products,
  isWomensNikeProduct,
  normalizeNikeProductUrl,
} from './discovery.js';
import {
  applyCheckState,
  collectMonitorErrors,
  millisecondsUntilFailureBackoff,
  nextFailureBackoffUntil,
  nextFailureWindowState,
  notificationDecision,
} from './monitor-state.js';
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
  shouldCheckProductNow,
  updateDelistState,
  updateCatalogPresence,
  updateUpcomingState,
} from './monitor-policy.js';

const MAX_EVENTS = 80;
const MAX_HISTORY = 300;
const MAX_CHECK_SAMPLES = 10000;
const MAX_CATALOG_REPROBE_FAILURES = 3;

/** One persisted alarm step. The caller owns alarm registration and enable/stop controls. */
export function createMonitorEngine({
  env = {}, state: initialState = {}, persist: save = async () => {},
  notify = true, now = () => Date.now(), fetchImpl = fetch,
} = {}) {
  const state = structuredClone(initialState && typeof initialState === 'object' ? initialState : {});
  const clock = () => Number(now());
  const boundedFetch = createBoundedFetch(fetchImpl, {
    maxBytes: clampNumber(env.MAX_NIKE_RESPONSE_BYTES, 4 * 1024 * 1024, 65536, 8 * 1024 * 1024),
  });
  const configuredProductUrls = splitUrls(env.PRODUCT_URLS);
  if (env.PRODUCT_URL) configuredProductUrls.push(env.PRODUCT_URL);
  const acceptedConfiguredProductUrls = configuredProductUrls.filter(
    (url) => !isWomensNikeProduct({ url }),
  );
  const configuredPrimaryProductUrl = env.PRODUCT_URL &&
    !isWomensNikeProduct({ url: env.PRODUCT_URL })
    ? env.PRODUCT_URL
    : '';
  const productConfigResult = parseProductConfigSafely(env.PRODUCT_CONFIG_JSON);
  if (productConfigResult.error) {
    console.warn(`${productConfigResult.error}; monitoring and notifications are disabled.`);
  }

  const config = {
    productUrl:
      configuredPrimaryProductUrl ||
      DEFAULT_MIND_001_URLS.find((url) => url.endsWith('/HQ4307-005')) ||
      DEFAULT_MIND_001_URLS[0],
    seedProducts: [
      ...DEFAULT_MIND_001_URLS.map((url) => ({ url })),
      ...DEFAULT_FRAGMENT_PRODUCTS,
      ...acceptedConfiguredProductUrls.map((url) => ({ url })),
    ],
    discoveryUrl: env.DISCOVERY_URL || DEFAULT_DISCOVERY_URL,
    fragmentDiscoveryUrls:
      splitUrls(env.FRAGMENT_DISCOVERY_URLS).length > 0
        ? splitUrls(env.FRAGMENT_DISCOVERY_URLS)
        : DEFAULT_FRAGMENT_DISCOVERY_URLS,
    discoveryIntervalHours: clampNumber(env.DISCOVERY_INTERVAL_HOURS, 6, 1, 168),
    discoveryRetryMinutes: clampNumber(env.DISCOVERY_RETRY_MINUTES, 30, 5, 360),
    sizeFilters: env.SIZE_FILTERS || '',
    intervalSeconds: clampNumber(env.INTERVAL_SECONDS, 120, 30, 1800),
    loopMinutes: clampNumber(env.LOOP_MINUTES, 25, 0, 340),
    productCheckDelayMs: clampNumber(env.PRODUCT_CHECK_DELAY_MS, 1500, 0, 30000),
    productConfig: productConfigResult.config,
    productConfigError: productConfigResult.error,
    delistFailureThreshold: clampNumber(env.DELIST_FAILURE_THRESHOLD, 12, 3, 100),
    pausedRecheckHours: clampNumber(env.PAUSED_RECHECK_HOURS, 24, 1, 168),
    upcomingIntervalSeconds: clampNumber(env.UPCOMING_INTERVAL_SECONDS, 30, 15, 600),
    upcomingWindowMinutes: clampNumber(env.UPCOMING_WINDOW_MINUTES, 180, 15, 1440),
    discordMention: configuredDiscordMention(env.DISCORD_MENTION),
    discordWebhook: configuredDiscordWebhook(env.DISCORD_WEBHOOK || ''),
  };

  state.knownProducts = normalizeKnownProducts(state.knownProducts);
  const events = Array.isArray(state.events)
    ? state.events.filter((event) => !isWomensStateRecord(event)).slice(0, MAX_EVENTS)
    : [];
  const history = Array.isArray(state.history)
    ? state.history.filter((entry) => !isWomensStateRecord(entry)).slice(0, MAX_HISTORY)
    : [];
  state.checkSamples = normalizeCheckSamples(state.checkSamples)
    .filter((sample) => !isWomensStateRecord(sample));

  for (const product of config.seedProducts) {
    addKnownProduct(product, product.styleColor ? 'fragment-initial' : 'initial');
  }

  // 旧バージョンの単一商品通知状態を引き継ぐ。
  if (state.lastStockKey && state.knownProducts['HQ4307-005']?.lastStockKey === '') {
    state.knownProducts['HQ4307-005'].lastStockKey = state.lastStockKey;
  }
  delete state.lastStockKey;

  state.consecutiveFailedCycles = Math.max(0, Number(state.consecutiveFailedCycles) || 0);
  return {
    tick,
    snapshot: () => structuredClone(state),
    status: () => buildStatus(state.updatedAt || new Date(clock()).toISOString()),
    nextAlarmAt,
  };

  async function tick() {
    const startedAt = clock();
    if (config.productConfigError) {
      await persist();
      return { kind: 'idle', nextAlarmAt: null };
    }
    const products = productsDueForCheck(startedAt);
    const discoveryDue = millisecondsUntilDiscoveryDue(startedAt) === 0;
    // Interleave discovery pages with due checks so a catalog cycle cannot starve launches.
    if (discoveryDue && (!products.length || state.lastOperationKind !== 'discovery')) {
      const discovery = await discoverOneCatalog();
      state.lastOperationKind = 'discovery';
      state.lastTickAt = new Date(clock()).toISOString();
      await persist();
      return { kind: 'discovery', ...discovery, nextAlarmAt: nextAlarmAt() };
    }
    const entry = products[0];
    if (!entry) {
      await persist();
      return { kind: 'idle', nextAlarmAt: nextAlarmAt() };
    }

    const activeProducts = monitorableProducts().filter((product) => !product.pausedAt);
    const countedAsActive = !entry.pausedAt;
    let outcome;
    try {
      outcome = await runCheck(entry);
    } catch (error) {
      // Persistence errors must escape: retrying the alarm is safer than sending after an
      // uncommitted observation. Only unexpected processing errors become check failures.
      if (error?.monitorPersistenceFailure) throw error;
      const checkedAt = new Date(clock()).toISOString();
      const safeError = new Error(scrubWebhook(error?.message || '監視処理でエラーが発生しました。'));
      recordCatalogReprobeOutcome(entry, false);
      recordCheckSample(applyRuntimeFailure(entry, safeError, {
        checkedAt, durationMs: clock() - startedAt,
      }));
      pushEvent({
        id: `worker-error-${clock()}-${entry.styleColor}`, type: 'error',
        message: `${entry.styleColor} の監視処理でエラー: ${safeError.message}`,
        at: checkedAt, result: null,
      });
      outcome = { ok: false, notified: false };
    }
    const attempts = countedAsActive ? [{ styleColor: entry.styleColor, ok: outcome.ok }] : [];
    const failure = nextFailureWindowState(state.consecutiveFailedCycles, state.failureWindow, {
      attempts,
      activeProducts: activeProducts.map((product) => product.styleColor),
      totalProducts: activeProducts.length,
      windowMinutes: fleetFailureWindowMinutes(activeProducts.length),
      now: clock(),
    });
    state.consecutiveFailedCycles = failure.streak;
    state.failureWindow = failure.window;
    state.failureBackoffUntil = nextFailureBackoffUntil(state.failureBackoffUntil, {
      attempted: attempts.length > 0, streak: failure.streak,
      intervalSeconds: config.intervalSeconds, now: clock(),
    });
    state.lastOperationKind = 'check';
    state.lastTickAt = new Date(clock()).toISOString();
    await persist();
    return { kind: 'check', styleColor: entry.styleColor, ...outcome, nextAlarmAt: nextAlarmAt() };
  }

  function nextAlarmAt() {
    if (config.productConfigError) return null;
    const timestamp = clock();
    const wait = Math.min(nextEffectiveWaitMs(timestamp), millisecondsUntilDiscoveryDue(timestamp));
    if (!Number.isFinite(wait)) return null;
    const lastTickAt = Date.parse(state.lastTickAt || '');
    return Math.max(
      timestamp + Math.max(1000, wait),
      Number.isFinite(lastTickAt) ? lastTickAt + config.productCheckDelayMs : 0,
    );
  }

  function millisecondsUntilDiscoveryDue(timestamp = clock()) {
    if (config.productConfigError) return Number.POSITIVE_INFINITY;
    if (state.discoveryCycle) return 0;
    const reference = Date.parse(state.lastDiscoveryError
      ? state.lastDiscoveryAttemptAt || state.lastDiscoveryAt || ''
      : state.lastDiscoverySuccessAt || state.lastDiscoveryAt || '');
    const interval = state.lastDiscoveryError
      ? config.discoveryRetryMinutes * 60_000
      : config.discoveryIntervalHours * 3_600_000;
    return Number.isFinite(reference) ? Math.max(0, reference + interval - timestamp) : 0;
  }

  async function discoverOneCatalog() {
    let cycle = state.discoveryCycle;
    if (!cycle || !Array.isArray(cycle.sources) || !Array.isArray(cycle.results) ||
        !Number.isInteger(cycle.index) || cycle.index < 0 || cycle.index >= cycle.sources.length) {
      cycle = state.discoveryCycle = {
        startedAt: new Date(clock()).toISOString(), index: 0, results: [],
        sources: [
          { family: 'mind', url: config.discoveryUrl },
          ...config.fragmentDiscoveryUrls.map((url) => ({ family: 'fragment', url })),
        ],
      };
    }
    const source = cycle.sources[cycle.index];
    const result = source.family === 'mind'
      ? await discoverNikeMind001Products({ catalogUrl: source.url, timeoutMs: 20000, fetchImpl: boundedFetch })
      : await discoverNikeFragmentProducts({ catalogUrls: [source.url], timeoutMs: 20000, fetchImpl: boundedFetch });
    const checkedAt = new Date(clock()).toISOString();
    cycle.results.push({ family: source.family, products: result.products, error: result.error });
    cycle.index += 1;
    const added = result.error ? [] : addKnownProducts(result.products,
      source.family === 'mind' ? 'catalog' : 'fragment-catalog');
    const observed = cycle.results.filter((item) => !item.error).flatMap((item) => item.products);
    const completed = cycle.index >= cycle.sources.length;
    const errors = cycle.results.filter((item) => item.error).map((item) =>
      `${item.family === 'mind' ? 'Mind 001' : 'Fragment'}: ${item.error}`);
    // Every configured page must succeed before absence is evidence of delisting.
    const completeDiscovery = completed && errors.length === 0;
    const reprobe = updateCatalogPresence(trackedProducts(), observed,
      checkedAt, { markAbsent: completeDiscovery });
    for (const styleColor of reprobe) state.knownProducts[styleColor].catalogReprobeFailures = 0;
    if (reprobe.length) {
      pushEvent({
        id: `catalog-reprobe-${clock()}`, type: 'lifecycle',
        message: `カタログへ再出現したため即時再確認: ${reprobe.join(', ')}`,
        at: checkedAt, result: null,
      });
    }
    if (added.length) {
      pushEvent({
        id: `discovery-added-${clock()}`, type: 'discovery',
        message: `新しい監視対象を検出: ${added.join(', ')}`, at: checkedAt, result: null,
      });
    }
    if (completed) {
      state.lastDiscoveryAt = checkedAt;
      state.lastDiscoveryAttemptAt = checkedAt;
      state.lastDiscoveryError = errors.join(' / ') || null;
      if (completeDiscovery) state.lastDiscoverySuccessAt = checkedAt;
      pushEvent({
        id: `discovery-${clock()}`, type: errors.length ? 'error' : 'discovery',
        message: errors.length
          ? `商品探索の一部または全部に失敗しました: ${state.lastDiscoveryError}`
          : `商品探索完了: ${trackedProducts().length}商品を追跡中`,
        at: checkedAt, result: null,
      });
      state.discoveryCycle = null;
    }
    return { ok: !result.error, completed, sourceUrl: source.url };
  }

  async function runCheck(entry) {
    const settings = productSettings(entry);
    const startedAt = clock();
    const result = await checkNikeStock(entry.url, {
      styleColor: entry.styleColor,
      sizeFilters: settings.sizeFilters,
      timeoutMs: 20000,
      fetchImpl: boundedFetch,
    });
    result.checkedAt = new Date(clock()).toISOString();
    const durationMs = clock() - startedAt;
    const checkedAt = result.checkedAt || new Date(clock()).toISOString();
    if (result.ok && isWomensNikeProduct(result.product)) {
      delete state.knownProducts[entry.styleColor];
      state.checkSamples = state.checkSamples.filter(
        (sample) => sample?.styleColor !== entry.styleColor,
      );
      return { notified: false, ok: true };
    }
    const styleColor = result.product?.styleColor || entry.styleColor;
    updateUpcomingState(entry, result, { now: Date.parse(checkedAt) });
    // During shadow mode retain the imported acknowledgement unchanged, while a
    // separate observation baseline remembers confirmed OOS/restock transitions.
    // Activate that baseline only when notifications are enabled again.
    if (notify && entry.shadowNotificationState) {
      entry.lastStockKey = entry.shadowNotificationState.lastStockKey;
      entry.oosStreak = entry.shadowNotificationState.oosStreak;
      entry.shadowNotificationState = null;
    }
    const notificationEntry = notify ? entry : { ...entry, ...entry.shadowNotificationState };
    const decision = notificationDecision(notificationEntry, result);
    const { nextStockKey, previousStockKey, addedSizes, shouldNotify } = decision;
    recordCheckSample({ at: checkedAt, styleColor, ok: result.ok, durationMs, inStock: result.inStock });
    const stockTransition = recordStockTransition(entry, result, { now: checkedAt });
    if (stockTransition) {
      history.unshift(stockTransition);
      history.splice(MAX_HISTORY);
      pushEvent({
        id: `stock-change-${clock()}-${styleColor}`,
        type: 'stock-change',
        message: stockTransition.message,
        at: checkedAt,
        result: null,
      });
    }
    recordCatalogReprobeOutcome(entry, result.ok);
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
        id: `lifecycle-${clock()}-${styleColor}`,
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
        id: `related-${clock()}`,
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
      id: `actions-${clock()}-${styleColor}`,
      type: result.ok ? 'check' : 'error',
      message: `${styleColor}: ${result.statusLabel}`,
      at: checkedAt,
      result: compactResult(publicResult),
    });

    let notified = false;
    const notificationEnabled = notify && settings.notify && Boolean(config.discordWebhook);
    if (shouldNotify && settings.notify) {
      entry.pendingNotification = { stockKey: nextStockKey, detectedAt: checkedAt };
    }
    if (shouldNotify && notificationEnabled) {
      // Sending requires an observation checkpoint. Ordinary checks need only the
      // final tick commit, which also saves failure state and the next schedule.
      await persist(checkedAt);
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
        entry.pendingNotification = null;
        pushEvent({
          id: `notify-${clock()}-${styleColor}`,
          type: 'notify',
          message: `Discordへ通知しました: ${styleColor} / ${result.statusLabel}`,
          at: new Date(clock()).toISOString(),
          result: null,
        });
      } catch (error) {
        pushEvent({
          id: `notify-error-${clock()}-${styleColor}`,
          type: 'error',
          message: `Discord通知に失敗しました (${styleColor}): ${scrubWebhook(error.message)}`,
          at: new Date(clock()).toISOString(),
          result: null,
        });
      }
    }

    // Shadow checks must not consume any notification transition from the imported cache.
    if (notify) {
      applyCheckState(entry, result, {
        nextStockKey,
        shouldNotify,
        notified,
        webhookConfigured: notificationEnabled,
      });
      if (result.ok && result.availabilityState !== 'unknown' && !result.inStock && entry.oosStreak >= 2) {
        entry.pendingNotification = null;
      }
    } else {
      applyCheckState(notificationEntry, result, {
        nextStockKey, shouldNotify, notified: false, webhookConfigured: true,
      });
      entry.shadowNotificationState = {
        lastStockKey: notificationEntry.lastStockKey || '',
        oosStreak: Number(notificationEntry.oosStreak) || 0,
      };
    }

    return { notified, ok: result.ok };
  }

  function recordCatalogReprobeOutcome(entry, ok) {
    if (ok) {
      entry.catalogReprobeFailures = 0;
      return;
    }
    if (!entry.pausedAt || !entry.catalogReprobePending) return;
    entry.catalogReprobeFailures = (Number(entry.catalogReprobeFailures) || 0) + 1;
    // A stale catalog entry must not bypass the paused interval indefinitely.
    // Keep a short retry window for transient failures, then return to daily probes.
    if (entry.catalogReprobeFailures >= MAX_CATALOG_REPROBE_FAILURES) {
      entry.catalogReprobePending = false;
    }
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
      parsed = parseNikeProductUrl(product.url, { styleColor: product.styleColor });
    } catch {
      return { added: false, entry: null };
    }

    const styleColor = String(product.styleColor || parsed.styleColor).toUpperCase();
    if (isWomensNikeProduct({ ...product, styleColor, url: product.url || parsed.url })) {
      return { added: false, entry: null };
    }
    const existing = state.knownProducts[styleColor];
    if (existing) {
      const initialSeed = source === 'initial' || source === 'fragment-initial';
      const urlChanged = existing.url !== parsed.url;
      if (product.url && (!initialSeed || !normalizeNikeProductUrl(existing.url, { styleColor }))) {
        existing.url = parsed.url;
      }
      if ((existing.urlRepairPending || (existing.pausedAt && urlChanged)) &&
          (source === 'catalog' || source === 'fragment-catalog')) {
        // A recovered path alone does not prove that a paused product is present.
        // Authoritative catalog rediscovery schedules a probe; only a successful
        // product check is allowed to clear the existing lifecycle pause.
        existing.catalogReprobePending = true;
        existing.catalogReprobeFailures = 0;
        existing.lastSeenAt = null;
        existing.urlRepairPending = false;
      }
      return { added: false, entry: existing };
    }

    const now = new Date(clock()).toISOString();
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
        const repair = repairLegacyProductUrl(product.url, product.styleColor || key);
        const productUrl = repair.url || product.url;
        const parsed = parseNikeProductUrl(productUrl, { styleColor: product.styleColor || key });
        const styleColor = String(product.styleColor || key || parsed.styleColor).toUpperCase();
        if (isWomensNikeProduct({
          ...product,
          ...product.lastResult?.product,
          styleColor,
          url: productUrl,
        })) continue;
        normalized[styleColor] = {
          styleColor,
          url: productUrl,
          source: product.source || 'state',
          discoveredAt: product.discoveredAt || new Date(clock()).toISOString(),
          lastSeenAt: product.lastSeenAt || null,
          lastStockKey: product.lastStockKey || '',
          lastObservedStockKey: product.lastObservedStockKey,
          pendingNotification: product.pendingNotification || null,
          shadowNotificationState: product.shadowNotificationState || null,
          oosStreak: Number(product.oosStreak) || 0,
          observedOosStreak: Number(product.observedOosStreak) || 0,
          missingStreak: Number(product.missingStreak) || 0,
          unresolvedStreak: Number(product.unresolvedStreak) || 0,
          pausedAt: product.pausedAt || null,
          pausedReason: product.pausedReason || '',
          catalogPresent: typeof product.catalogPresent === 'boolean' ? product.catalogPresent : undefined,
          lastCatalogSeenAt: product.lastCatalogSeenAt || null,
          catalogReprobePending: product.catalogReprobePending === true,
          catalogReprobeFailures: Math.max(0, Number(product.catalogReprobeFailures) || 0),
          urlRepairPending: product.urlRepairPending === true || repair.detected,
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

  function repairLegacyProductUrl(value, styleColor) {
    try {
      const url = new URL(value);
      let detected = false;
      const segments = url.pathname.split('/').filter((segment) => {
        if (decodeURIComponent(segment) !== '[object Object]') return true;
        detected = true;
        return false;
      });
      if (!detected) return { detected: false, url: '' };
      url.pathname = segments.join('/');
      return { detected: true, url: normalizeNikeProductUrl(url.toString(), { styleColor }) };
    } catch {
      return { detected: false, url: '' };
    }
  }

  function trackedProducts() {
    return Object.values(state.knownProducts).sort((a, b) => a.styleColor.localeCompare(b.styleColor));
  }

  function monitorableProducts() {
    if (config.productConfigError) return [];
    return trackedProducts().filter((entry) => productSettings(entry).enabled);
  }

  function productsDueForCheck(now = clock()) {
    if (millisecondsUntilFailureBackoff(state.failureBackoffUntil, now) > 0) {
      return [];
    }
    return monitorableProducts()
      .filter((entry) => shouldCheckProductNow(entry, {
        ...schedulingOptions(now),
      }))
      .map((entry) => ({ entry, dueAt: productDueAt(entry, now) }))
      .sort((a, b) => {
        const overdue = a.dueAt - b.dueAt;
        const priority = Number(isUpcomingPriority(b.entry, now, config.upcomingWindowMinutes))
          - Number(isUpcomingPriority(a.entry, now, config.upcomingWindowMinutes));
        return overdue || priority || a.entry.styleColor.localeCompare(b.entry.styleColor);
      })
      .map(({ entry }) => entry);
  }

  function productDueAt(entry, now) {
    const lastChecked = Date.parse(entry.lastSeenAt || '');
    if (!Number.isFinite(lastChecked)) return Number.NEGATIVE_INFINITY;
    // Read the current policy interval from a fresh observation, before its overdue
    // result is clamped to zero. Ordering absolute deadlines prevents frequently due
    // launches from starving older normal checks in this one-product alarm model.
    const interval = millisecondsUntilProductDue({
      ...entry, lastSeenAt: new Date(now).toISOString(),
    }, schedulingOptions(now));
    return lastChecked + interval;
  }

  function nextScheduledWaitMs(now = clock()) {
    const products = monitorableProducts();
    if (!products.length) return Number.POSITIVE_INFINITY;
    return Math.min(...products.map((entry) => millisecondsUntilProductDue(entry, schedulingOptions(now))));
  }

  function nextEffectiveWaitMs(now = clock()) {
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

  function buildStatus(updatedAt) {
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
        metrics: computeQualityMetrics(checkSamplesByProduct.get(entry.styleColor) || [], { now: clock() }),
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

    const quality = computeQualityMetrics(state.checkSamples, { now: clock() });
    const statusUpdatedAt = Date.parse(updatedAt);
    const nextWaitMs = nextEffectiveWaitMs(Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : clock());
    return {
      schemaVersion: 3,
      updatedAt,
      nextCheckAt: Number.isFinite(nextWaitMs)
        ? new Date((Number.isFinite(statusUpdatedAt) ? statusUpdatedAt : clock()) + nextWaitMs).toISOString()
        : null,
      config: {
        productUrl: config.productUrl,
        productUrls: products.map((product) => product.url),
        productCount: products.length,
        discoveryUrl: config.discoveryUrl,
        fragmentDiscoveryUrls: config.fragmentDiscoveryUrls,
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
  }

  async function persist(updatedAt = new Date(clock()).toISOString()) {
    state.updatedAt = updatedAt;
    const status = buildStatus(updatedAt);
    try {
      await save(structuredClone(state), status);
    } catch (error) {
      const failure = new Error('監視状態の保存に失敗しました。', { cause: error });
      failure.monitorPersistenceFailure = true;
      throw failure;
    }
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
    const cutoff = clock() - 25 * 3600 * 1000;
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
    return Object.fromEntries(
      Object.entries(config.productConfig)
        .filter(([styleColor]) => !isWomensNikeProduct({ styleColor }))
        .map(([styleColor, settings]) => [
          styleColor,
          {
            sizeFilters: settings.sizeFilters,
            notify: settings.notify,
            enabled: settings.enabled,
          },
        ]),
    );
  }

  function isWomensStateRecord(record) {
    return isWomensNikeProduct({
      styleColor: record?.styleColor || record?.result?.product?.styleColor,
      url: record?.url || record?.result?.product?.url,
      contextText: JSON.stringify(record || {}),
    });
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
          timestamp: new Date(clock()).toISOString(),
        },
      ],
    }, { fetchImpl: boundedFetch });
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

}

function createBoundedFetch(fetchImpl, { maxBytes }) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let reader;
    try {
      const response = await fetchImpl(url, { ...options, signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return response;
      }
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        await response.body.cancel();
        throw new Error('Nike response exceeded the maximum allowed size.');
      }
      reader = response.body.getReader();
      const chunks = [];
      let byteLength = 0;
      for (;;) {
        if (signal.aborted) throw new Error('Nike response timed out.');
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxBytes) throw new Error('Nike response exceeded the maximum allowed size.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const buffered = new Response(bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
      Object.defineProperty(buffered, 'url', { value: response.url });
      return buffered;
    } catch (error) {
      controller.abort();
      await reader?.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
    }
  };
}
