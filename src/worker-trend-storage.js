const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 3600000;
const RETENTION_DAYS = 730;
const CAPACITY = 1000000;
const PRODUCT_LIMIT = 1000;
const STYLE_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/;
const PERIODS = new Set([7, 30, 90, 365, 730]);

/** Compact event archive: it stores detection identities, never notification data. */
export class RestockArchive {
  constructor(sql, { now = Date.now } = {}) {
    this.sql = sql;
    this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_restock_events (
      style_color TEXT NOT NULL, detected_at INTEGER NOT NULL,
      PRIMARY KEY (style_color, detected_at)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS monitor_restock_events_time
      ON monitor_restock_events (detected_at, style_color)`);
  }

  prepare(state, metadata, legacyState = null) {
    const now = this.now();
    const current = collectEvents(state, now);
    const previousKeys = new Set(metadata?.recentKeys || []);
    const candidates = new Map();
    // Backfill the old document even when the first new operation replaces it.
    if (!metadata) for (const [key, event] of collectEvents(legacyState, now).events) candidates.set(key, event);
    for (const [key, event] of current.events) if (!previousKeys.has(key)) candidates.set(key, event);
    return {
      now, candidates,
      metadata: {
        archiveStartedAt: metadata?.archiveStartedAt || new Date(now).toISOString(),
        eventCount: metadata?.eventCount || 0,
        lastPrunedDay: metadata?.lastPrunedDay ?? null,
        capacityLimited: metadata?.capacityLimited === true,
        recentKeys: [...current.events.keys()].sort(),
        products: [...current.products].sort().slice(0, PRODUCT_LIMIT),
        productsTruncated: current.products.size > PRODUCT_LIMIT,
      },
    };
  }

  // Called inside the transaction that saves state/status; publish metadata only
  // after that whole transaction succeeds. No archive scan is needed per tick.
  apply(plan) {
    const { now, candidates } = plan;
    const metadata = { ...plan.metadata };
    for (const { styleColor, timestamp } of candidates.values()) {
      const inserted = this.sql.exec(`INSERT OR IGNORE INTO monitor_restock_events
        (style_color, detected_at) VALUES (?, ?) RETURNING detected_at`, styleColor, timestamp).toArray();
      metadata.eventCount += inserted.length;
    }
    const day = Math.floor((now + JST_OFFSET_MS) / DAY_MS);
    if (metadata.lastPrunedDay !== day) {
      this.sql.exec('DELETE FROM monitor_restock_events WHERE detected_at < ?', now - RETENTION_DAYS * DAY_MS);
      metadata.eventCount -= this.sql.exec('SELECT changes() AS count').toArray()[0].count;
      metadata.lastPrunedDay = day;
    }
    if (metadata.eventCount > CAPACITY) {
      this.sql.exec(`DELETE FROM monitor_restock_events WHERE (style_color, detected_at) IN
        (SELECT style_color, detected_at FROM monitor_restock_events
          ORDER BY detected_at, style_color LIMIT ?)`, metadata.eventCount - CAPACITY);
      metadata.eventCount -= this.sql.exec('SELECT changes() AS count').toArray()[0].count;
      metadata.capacityLimited = true;
    }
    return metadata;
  }

  summarize(metadata, { styleColor = 'all', days = 'all' } = {}) {
    const style = String(styleColor || 'all').trim().toUpperCase();
    if (style !== 'ALL' && !STYLE_PATTERN.test(style)) throw new RangeError('Invalid trend product.');
    const selectedDays = days === 'all' ? 'all' : Number(days);
    if (selectedDays !== 'all' && !PERIODS.has(selectedDays)) throw new RangeError('Invalid trend period.');
    const now = this.now();
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const windowStart = selectedDays === 'all' ? cutoff : now - selectedDays * DAY_MS;
    const selected = style === 'ALL' ? '' : ' AND style_color = ?';
    const args = [windowStart, cutoff, now, ...(style === 'ALL' ? [] : [style])];
    // One indexed scan, one bounded result row. SQL computes all 24 bins without
    // materializing event history in the Worker or sending it to the browser.
    const bins = Array.from({ length: 24 }, (_, hour) =>
      `SUM(CASE WHEN detected_at >= window.start AND (CAST(detected_at / 3600000 AS INTEGER) + 9) % 24 = ${hour} THEN 1 ELSE 0 END) AS hour_${hour}`);
    const result = this.sql.exec(`WITH window(start) AS (VALUES (?)) SELECT
      COUNT(*) AS retained_count, MIN(detected_at) AS retained_from, MAX(detected_at) AS retained_to,
      SUM(CASE WHEN detected_at >= window.start THEN 1 ELSE 0 END) AS total,
      COUNT(DISTINCT CASE WHEN detected_at >= window.start THEN style_color END) AS distinct_products,
      MIN(CASE WHEN detected_at >= window.start THEN detected_at END) AS first_event,
      MAX(CASE WHEN detected_at >= window.start THEN detected_at END) AS last_event,
      ${bins.join(', ')}
      FROM monitor_restock_events, window WHERE detected_at >= ? AND detected_at <= ?${selected}`, ...args).toArray()[0];
    const archivedProducts = this.sql.exec(`SELECT DISTINCT style_color FROM monitor_restock_events
      WHERE detected_at >= ? AND detected_at <= ? ORDER BY style_color LIMIT ?`, cutoff, now, PRODUCT_LIMIT + 1).toArray();
    const products = [...new Set([...metadata.products, ...archivedProducts.map((row) => row.style_color)])].sort();
    const started = metadata.archiveStartedAt;
    const startLabel = new Date(Date.parse(started) + JST_OFFSET_MS).toISOString().slice(0, 10);
    return {
      timezone: 'Asia/Tokyo', styleColor: style === 'ALL' ? 'all' : style,
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: result[`hour_${hour}`] || 0 })),
      totalEvents: result.total || 0, distinctProducts: result.distinct_products,
      products: products.slice(0, PRODUCT_LIMIT),
      period: {
        days: selectedDays, windowStart: selectedDays === 'all' ? null : iso(windowStart), windowEnd: iso(now),
        retainedFrom: iso(result.retained_from), retainedTo: iso(result.retained_to),
        retainedTransitionCount: result.retained_count,
        firstEventAt: iso(result.first_event), lastEventAt: iso(result.last_event),
        archiveStartedAt: started,
      },
      notes: {
        timestampBasis: 'detected', retentionLimited: true, retentionDays: RETENTION_DAYS,
        archiveStartedAt: started, legacyHistoryPartial: true,
        capacityLimit: CAPACITY, capacityLimited: metadata.capacityLimited,
        productsTruncated: metadata.productsTruncated || products.length > PRODUCT_LIMIT,
        sourceLimits: { legacyGlobalHistory: 300, legacyPerProductHistory: 60 },
        timestampLabel: '監視が入荷を検出した時刻を日本時間で集計しています。実際の補充時刻とはずれることがあります。',
        retentionLabel: `${startLabel}（日本時間）から長期保存しています。最大730日分を保持し、保存開始前は短期履歴から引き継げた一部の記録のみです。監視の中断中の入荷は含まれません。${metadata.capacityLimited ? '保存件数の上限に達したため、古い記録の一部を削除しています。' : ''}`,
        countingLabel: 'サイズ数にかかわらず、同一商品・同一時刻の入荷検出を1件とします。',
      },
    };
  }
}

function collectEvents(state, now) {
  const events = new Map();
  const products = new Set();
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  function add(entry, fallbackStyle = '') {
    if (!entry || !Array.isArray(entry.added)) return;
    const styleColor = normalizeStyle(entry.styleColor || fallbackStyle);
    const timestamp = parseTimestamp(entry.at);
    if (!styleColor || !Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now) return;
    products.add(styleColor);
    if (!entry.added.some((size) => (typeof size === 'string' && size.trim()) ||
      (typeof size === 'number' && Number.isFinite(size)))) return;
    events.set(`${styleColor}|${timestamp}`, { styleColor, timestamp });
  }
  for (const entry of Array.isArray(state?.history) ? state.history : []) add(entry);
  const known = state?.knownProducts && typeof state.knownProducts === 'object' ? state.knownProducts : {};
  for (const [key, product] of Object.entries(known)) {
    const styleColor = normalizeStyle(product?.styleColor || key);
    if (styleColor) products.add(styleColor);
    for (const entry of Array.isArray(product?.stockHistory) ? product.stockHistory : []) add(entry, styleColor);
  }
  return { events, products };
}

function normalizeStyle(value) {
  const style = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return STYLE_PATTERN.test(style) ? style : '';
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59 ||
    (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return NaN;
  return Date.parse(value);
}

function iso(value) { return value === null ? null : new Date(value).toISOString(); }
