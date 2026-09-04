const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STYLE_COLOR_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/;

/**
 * Aggregate retained stock transitions without changing monitoring state.
 * `days` is a rolling 7/30-day window, inclusive of its start and `now`.
 * Retained bounds describe the selected product's available transition records
 * before the day filter; they do not establish continuous monitoring coverage.
 */
export function aggregateRestockTrends(status, {
  styleColor = 'all', days = 'all', now = Date.now(),
} = {}) {
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new RangeError('now must be a valid timestamp in milliseconds.');
  }
  const selectedStyle = String(styleColor || 'all').trim().toUpperCase();
  const selectedDays = days === 7 || days === '7' ? 7 : days === 30 || days === '30' ? 30 : 'all';
  const windowStart = selectedDays === 'all' ? null : nowMs - selectedDays * DAY_MS;
  const source = status && typeof status === 'object' ? status : {};
  const productRecords = Array.isArray(source.products) ? source.products : [];
  const products = new Set();
  const transitions = new Map();

  function addTransition(entry, productStyle = '') {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.added)) return;
    const entryStyle = normalizeStyle(entry.styleColor || productStyle);
    const timestamp = parseTimestamp(entry.at);
    if (!entryStyle || !Number.isFinite(timestamp) || timestamp > nowMs) return;
    products.add(entryStyle);
    // Different timezone spellings of the same instant are the same observation.
    const key = `${entryStyle}|${timestamp}`;
    const previous = transitions.get(key);
    const stockIncreased = entry.added.some((size) =>
      (typeof size === 'string' && size.trim() !== '') ||
      (typeof size === 'number' && Number.isFinite(size)));
    transitions.set(key, {
      styleColor: entryStyle, timestamp,
      stockIncreased: stockIncreased || previous?.stockIncreased === true,
    });
  }

  for (const entry of Array.isArray(source.history) ? source.history : []) addTransition(entry);
  for (const product of productRecords) {
    const productStyle = normalizeStyle(product?.styleColor);
    if (productStyle) products.add(productStyle);
    for (const entry of Array.isArray(product?.stockHistory) ? product.stockHistory : []) {
      addTransition(entry, productStyle);
    }
  }

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const countedProducts = new Set();
  let totalEvents = 0;
  let retainedTransitionCount = 0;
  let retainedFrom = null;
  let retainedTo = null;
  let firstEventAt = null;
  let lastEventAt = null;

  for (const entry of transitions.values()) {
    if (selectedStyle !== 'ALL' && selectedStyle !== entry.styleColor) continue;
    const timestamp = entry.timestamp;
    retainedTransitionCount += 1;
    retainedFrom = retainedFrom === null ? timestamp : Math.min(retainedFrom, timestamp);
    retainedTo = retainedTo === null ? timestamp : Math.max(retainedTo, timestamp);
    if (!entry.stockIncreased || (windowStart !== null && timestamp < windowStart)) continue;
    const hour = new Date(timestamp + JST_OFFSET_MS).getUTCHours();
    hours[hour].count += 1;
    totalEvents += 1;
    countedProducts.add(entry.styleColor);
    firstEventAt = firstEventAt === null ? timestamp : Math.min(firstEventAt, timestamp);
    lastEventAt = lastEventAt === null ? timestamp : Math.max(lastEventAt, timestamp);
  }

  return {
    timezone: 'Asia/Tokyo',
    styleColor: selectedStyle === 'ALL' ? 'all' : selectedStyle,
    hours,
    totalEvents,
    distinctProducts: countedProducts.size,
    products: [...products].sort(),
    period: {
      days: selectedDays,
      windowStart: isoOrNull(windowStart),
      windowEnd: isoOrNull(nowMs),
      retainedFrom: isoOrNull(retainedFrom),
      retainedTo: isoOrNull(retainedTo),
      retainedTransitionCount,
      firstEventAt: isoOrNull(firstEventAt),
      lastEventAt: isoOrNull(lastEventAt),
    },
    notes: {
      timestampBasis: 'detected',
      retentionLimited: true,
      sourceLimits: { globalHistory: 300, perProductHistory: 60 },
      timestampLabel: '監視が入荷を検出した時刻を日本時間で集計しています。実際の補充時刻とはずれることがあります。',
      retentionLabel: '保持されている履歴のみの集計です（全体最大300件・商品別最大60件）。期間全体を記録できているとは限りません。',
      countingLabel: 'サイズ数にかかわらず、同一商品・同一時刻の入荷検出を1件とします。',
    },
  };
}

function normalizeStyle(value) {
  const styleColor = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return STYLE_COLOR_PATTERN.test(styleColor) ? styleColor : '';
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return Number.NaN;
  // Records need an explicit timezone to make aggregation independent of the
  // browser's local timezone. Validate the calendar too: Date.parse rolls Feb 30.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function isoOrNull(timestamp) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}
