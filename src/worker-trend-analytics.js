const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const RETENTION_MS = 730 * DAY_MS;
const STYLE_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/;
const MIN_COMPARISON_HOURS = 24;
const MIN_COMPARISON_EVENTS = 3;
const MAX_SELL_OUT_ROWS = 100000;
const STORAGE_CAPACITY = 1000000;

/** Coverage and stock episodes begin with this schema; legacy history is never
 *  converted into invented observation time or sell-out durations. */
export class TrendAnalytics {
  constructor(sql, { now = Date.now } = {}) {
    this.sql = sql;
    this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_product_coverage (
      style_color TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      PRIMARY KEY (style_color, start_at)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS monitor_product_coverage_end
      ON monitor_product_coverage (end_at, style_color)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_analysis_gaps (
      style_color TEXT NOT NULL, occurred_at INTEGER NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY (style_color, occurred_at)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS monitor_analysis_gaps_occurred
      ON monitor_analysis_gaps (occurred_at, style_color)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_sellout_episodes (
      style_color TEXT NOT NULL, started_at INTEGER NOT NULL, restock_lower_at INTEGER NOT NULL,
      last_in_stock_at INTEGER NOT NULL, ended_at INTEGER,
      min_duration_ms INTEGER, max_duration_ms INTEGER,
      censored INTEGER NOT NULL DEFAULT 0, censor_reason TEXT,
      PRIMARY KEY (style_color, started_at)
    ) WITHOUT ROWID`);
    sql.exec(`CREATE INDEX IF NOT EXISTS monitor_sellout_episodes_end
      ON monitor_sellout_episodes (ended_at, style_color)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS monitor_sellout_episodes_started
      ON monitor_sellout_episodes (started_at, style_color)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_analysis_cursors (
      style_color TEXT PRIMARY KEY, last_attempt_at INTEGER, last_reliable_at INTEGER,
      last_in_stock INTEGER, stock_state TEXT, open_started_at INTEGER,
      open_lower_at INTEGER, segment_start INTEGER
    ) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS monitor_analysis_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1), started_at INTEGER NOT NULL,
      last_pruned_day INTEGER, reliable_segments INTEGER NOT NULL DEFAULT 0,
      excluded_gaps INTEGER NOT NULL DEFAULT 0
    )`);
  }

  prepare({ observation = null, boundary = null } = {}) {
    const now = this.now();
    return { now, observation: normalizeObservation(observation, now), boundary: normalizeBoundary(boundary, now) };
  }

  apply(plan) {
    const { now, observation, boundary } = plan;
    this.sql.exec(`INSERT OR IGNORE INTO monitor_analysis_meta
      (id, started_at, reliable_segments, excluded_gaps) VALUES (1, ?, 0, 0)`, now);
    if (boundary) this.applyBoundary(boundary);
    if (observation) this.applyObservation(observation);
    const day = Math.floor((now + JST_OFFSET_MS) / DAY_MS);
    const meta = this.metadata();
    if (meta.last_pruned_day !== day) {
      const cutoff = now - RETENTION_MS;
      this.sql.exec('DELETE FROM monitor_product_coverage WHERE end_at < ?', cutoff);
      this.sql.exec('DELETE FROM monitor_analysis_gaps WHERE occurred_at < ?', cutoff);
      this.sql.exec('DELETE FROM monitor_sellout_episodes WHERE started_at < ?', cutoff);
      this.sql.exec(`DELETE FROM monitor_analysis_cursors
        WHERE last_attempt_at < ? AND open_started_at IS NULL`, cutoff);
      this.sql.exec(`DELETE FROM monitor_product_coverage WHERE (style_color, start_at) IN
        (SELECT style_color, start_at FROM monitor_product_coverage ORDER BY end_at, style_color
          LIMIT MAX((SELECT COUNT(*) FROM monitor_product_coverage) - ${STORAGE_CAPACITY}, 0))`);
      this.sql.exec(`DELETE FROM monitor_analysis_gaps WHERE (style_color, occurred_at) IN
        (SELECT style_color, occurred_at FROM monitor_analysis_gaps ORDER BY occurred_at, style_color
          LIMIT MAX((SELECT COUNT(*) FROM monitor_analysis_gaps) - ${STORAGE_CAPACITY}, 0))`);
      this.sql.exec(`DELETE FROM monitor_sellout_episodes WHERE (style_color, started_at) IN
        (SELECT style_color, started_at FROM monitor_sellout_episodes ORDER BY started_at, style_color
          LIMIT MAX((SELECT COUNT(*) FROM monitor_sellout_episodes) - ${STORAGE_CAPACITY}, 0))`);
      this.sql.exec('UPDATE monitor_analysis_meta SET last_pruned_day = ? WHERE id = 1', day);
    }
  }

  applyBoundary({ at, reason }) {
    this.sql.exec(`INSERT OR IGNORE INTO monitor_analysis_gaps (style_color, occurred_at, reason)
      SELECT style_color, ?, ? FROM monitor_analysis_cursors WHERE last_reliable_at IS NOT NULL`, at, reason);
    this.sql.exec(`UPDATE monitor_sellout_episodes SET ended_at = ?, censored = 1, censor_reason = ?
      WHERE ended_at IS NULL`, at, reason);
    this.sql.exec(`UPDATE monitor_analysis_cursors SET last_attempt_at = ?, last_reliable_at = NULL,
      last_in_stock = NULL, stock_state = NULL, open_started_at = NULL,
      open_lower_at = NULL, segment_start = NULL`, at);
  }

  applyObservation(observation) {
    const { styleColor, at, availability, expectedIntervalMs, restockDetected } = observation;
    let cursor = this.sql.exec('SELECT * FROM monitor_analysis_cursors WHERE style_color = ?', styleColor).toArray()[0];
    if (cursor?.last_attempt_at >= at) return;
    if (!cursor) cursor = { style_color: styleColor };
    const reliable = availability !== 'unavailable';
    const gapLimit = Math.max(expectedIntervalMs * 3, 5 * 60000);
    if (cursor.last_reliable_at !== null && cursor.last_reliable_at !== undefined &&
        at - cursor.last_reliable_at > gapLimit) {
      this.censorOpen(cursor, at, 'long_gap');
      cursor.last_reliable_at = null;
      cursor.last_in_stock = null;
      cursor.stock_state = null;
      cursor.open_started_at = null;
      cursor.open_lower_at = null;
      cursor.segment_start = null;
      this.recordGap(styleColor, at, 'long_gap');
      this.sql.exec('UPDATE monitor_analysis_meta SET excluded_gaps = excluded_gaps + 1 WHERE id = 1');
    }
    if (!reliable) {
      if (cursor.last_reliable_at !== null && cursor.last_reliable_at !== undefined) {
        this.recordGap(styleColor, at, 'unavailable');
        this.sql.exec('UPDATE monitor_analysis_meta SET excluded_gaps = excluded_gaps + 1 WHERE id = 1');
      }
      this.censorOpen(cursor, at, 'unavailable');
      Object.assign(cursor, {
        last_attempt_at: at, last_reliable_at: null, last_in_stock: null,
        stock_state: null, open_started_at: null, open_lower_at: null, segment_start: null,
      });
      this.saveCursor(cursor);
      return;
    }

    if (cursor.last_reliable_at !== null && cursor.last_reliable_at !== undefined) {
      if (cursor.segment_start !== null && cursor.segment_start !== undefined) {
        this.sql.exec(`UPDATE monitor_product_coverage SET end_at = ?
          WHERE style_color = ? AND start_at = ?`, at, styleColor, cursor.segment_start);
      } else {
        this.sql.exec(`INSERT OR IGNORE INTO monitor_product_coverage
          (style_color, start_at, end_at) VALUES (?, ?, ?)`, styleColor, cursor.last_reliable_at, at);
        cursor.segment_start = cursor.last_reliable_at;
        this.sql.exec(`UPDATE monitor_analysis_meta SET reliable_segments = reliable_segments + 1 WHERE id = 1`);
      }
    }

    if (availability === 'in_stock') {
      if (restockDetected && cursor.last_reliable_at !== null && cursor.last_reliable_at !== undefined &&
          cursor.stock_state !== null && cursor.stock_state !== undefined) {
        this.censorOpen(cursor, at, 'new_restock');
        this.sql.exec(`INSERT OR IGNORE INTO monitor_sellout_episodes
          (style_color, started_at, restock_lower_at, last_in_stock_at)
          VALUES (?, ?, ?, ?)`, styleColor, at, cursor.last_reliable_at, at);
        cursor.open_started_at = at;
        cursor.open_lower_at = cursor.last_reliable_at;
      }
      cursor.stock_state = 'in_stock';
      cursor.last_in_stock = at;
      if (cursor.open_started_at !== null && cursor.open_started_at !== undefined) {
        this.sql.exec(`UPDATE monitor_sellout_episodes SET last_in_stock_at = ?
          WHERE style_color = ? AND started_at = ? AND ended_at IS NULL`, at, styleColor, cursor.open_started_at);
      }
    } else if (availability === 'out_of_stock') {
      if (cursor.stock_state === 'in_stock' && cursor.open_started_at !== null && cursor.open_started_at !== undefined) {
        const minimum = Math.max(0, cursor.last_in_stock - cursor.open_started_at);
        const maximum = Math.max(minimum, at - cursor.open_lower_at);
        this.sql.exec(`UPDATE monitor_sellout_episodes SET ended_at = ?, min_duration_ms = ?,
          max_duration_ms = ?, censored = 0 WHERE style_color = ? AND started_at = ? AND ended_at IS NULL`,
        at, minimum, maximum, styleColor, cursor.open_started_at);
        cursor.open_started_at = null;
        cursor.open_lower_at = null;
      }
      cursor.stock_state = 'out_of_stock';
      cursor.last_in_stock = null;
    }
    // An indeterminate successful observation adds coverage but cannot start or
    // finish an episode, and does not overwrite the last confirmed stock state.
    cursor.last_attempt_at = at;
    cursor.last_reliable_at = at;
    this.saveCursor(cursor);
  }

  censorOpen(cursor, at, reason) {
    if (cursor.open_started_at === null || cursor.open_started_at === undefined) return;
    this.sql.exec(`UPDATE monitor_sellout_episodes SET ended_at = ?, censored = 1,
      censor_reason = ? WHERE style_color = ? AND started_at = ? AND ended_at IS NULL`,
    at, reason, cursor.style_color, cursor.open_started_at);
  }

  recordGap(styleColor, at, reason) {
    this.sql.exec(`INSERT OR IGNORE INTO monitor_analysis_gaps
      (style_color, occurred_at, reason) VALUES (?, ?, ?)`, styleColor, at, reason);
  }

  saveCursor(cursor) {
    this.sql.exec(`INSERT INTO monitor_analysis_cursors
      (style_color, last_attempt_at, last_reliable_at, last_in_stock, stock_state,
       open_started_at, open_lower_at, segment_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(style_color) DO UPDATE SET
       last_attempt_at=excluded.last_attempt_at, last_reliable_at=excluded.last_reliable_at,
       last_in_stock=excluded.last_in_stock, stock_state=excluded.stock_state,
       open_started_at=excluded.open_started_at, open_lower_at=excluded.open_lower_at,
       segment_start=excluded.segment_start`,
    cursor.style_color, cursor.last_attempt_at, cursor.last_reliable_at ?? null,
    cursor.last_in_stock ?? null, cursor.stock_state ?? null, cursor.open_started_at ?? null,
    cursor.open_lower_at ?? null, cursor.segment_start ?? null);
  }

  exists() { return Boolean(this.sql.exec('SELECT id FROM monitor_analysis_meta WHERE id = 1').toArray()[0]); }

  summarize({ styleColor = 'all', days = 'all' } = {}, internal = {}) {
    const now = this.now();
    const normalizedStyle = String(styleColor || 'all').trim().toUpperCase();
    const style = normalizedStyle === 'ALL' ? 'all' : normalizedStyle;
    const daysNumber = days === 'all' ? 730 : Number(days);
    const start = now - daysNumber * DAY_MS;
    const meta = this.metadata();
    const verifiedFrom = Number.isFinite(internal.verifiedFrom) && internal.verifiedFrom <= now
      ? internal.verifiedFrom : meta.started_at;
    const recordingStartedAt = Math.max(meta.started_at, verifiedFrom);
    const analysisStart = Math.max(start, recordingStartedAt);
    const selection = style === 'all' ? '' : ' AND style_color = ?';
    const bindings = style === 'all' ? [analysisStart, now] : [analysisStart, now, style];
    const segments = this.sql.exec(`SELECT style_color, start_at, end_at FROM monitor_product_coverage
      WHERE end_at >= ? AND start_at <= ?${selection} ORDER BY start_at LIMIT 200001`, ...bindings).toArray();
    const segmentsTruncated = segments.length > 200000;
    const cells = segmentsTruncated ? coverageCells([], analysisStart, now) : coverageCells(segments, analysisStart, now);
    const eventBindings = style === 'all' ? [analysisStart, now] : [analysisStart, now, style];
    // Episode starts are created only by a reliable monitor observation with
    // restockDetected=true. The general archive also contains imported legacy
    // history, which must remain visible without becoming an analytics numerator.
    const eventCells = this.sql.exec(`SELECT
      CAST(strftime('%w', started_at / 1000, 'unixepoch', '+9 hours') AS INTEGER) AS weekday,
      CAST(strftime('%H', started_at / 1000, 'unixepoch', '+9 hours') AS INTEGER) AS hour,
      COUNT(*) AS count FROM monitor_sellout_episodes WHERE started_at >= ? AND started_at <= ?${selection}
      GROUP BY weekday, hour`, ...eventBindings).toArray();
    for (const event of eventCells) cells[event.weekday * 24 + event.hour].restockEvents = event.count;
    const observedMs = cells.reduce((total, cell) => total + cell.observedMs, 0);
    const gapBindings = style === 'all' ? [analysisStart, now] : [analysisStart, now, style];
    const excludedGaps = this.sql.exec(`SELECT COUNT(*) AS count FROM monitor_analysis_gaps
      WHERE occurred_at >= ? AND occurred_at <= ?${selection}`, ...gapBindings).toArray()[0].count;
    const weekdayHours = { cells: cells.map(({ weekday, hour, restockEvents: events, observedMs: ms }) => ({
      weekday, hour, restockEvents: events,
      observedProductHours: ms > 0 ? round(ms / HOUR_MS, 3) : null,
      ratePer100ProductHours: ms > 0 ? round(events * 100 * HOUR_MS / ms, 3) : null,
    })) };
    const comparison = this.comparison(style, now, recordingStartedAt);
    return {
      coverage: {
        recordingStartedAt: new Date(recordingStartedAt).toISOString(),
        observedProductHours: observedMs > 0 ? round(observedMs / HOUR_MS, 3) : null,
        reliableSegments: Math.min(segments.length, 200000),
        excludedGaps,
        segmentsTruncated,
        notes: segmentsTruncated
          ? '監視区間が集計上限を超えたため、商品監視時間と補正率は未観測として扱います。'
          : '成功し在庫を判定できた連続観測の間だけを商品監視時間として数えます。過去の時間は補完しません。',
      },
      weekdayHours,
      sellout: this.sellout(style, analysisStart, now, verifiedFrom),
      comparison,
    };
  }

  comparison(style, now, recordingStartedAt) {
    const previousStart = now - 60 * DAY_MS;
    const currentStart = now - 30 * DAY_MS;
    const selected = style === 'all' ? '' : ' AND style_color = ?';
    const comparisonStart = Math.max(previousStart, recordingStartedAt);
    const bindings = style === 'all' ? [comparisonStart, now] : [comparisonStart, now, style];
    const segments = this.sql.exec(`SELECT start_at, end_at FROM monitor_product_coverage
      WHERE end_at >= ? AND start_at <= ?${selected} LIMIT 200001`, ...bindings).toArray();
    const previousEventStart = Math.max(previousStart, recordingStartedAt);
    const currentEventStart = Math.max(currentStart, recordingStartedAt);
    const eventBindings = style === 'all'
      ? [previousEventStart, currentStart, currentEventStart, now, previousEventStart, now]
      : [previousEventStart, currentStart, currentEventStart, now, previousEventStart, now, style];
    const counts = this.sql.exec(`SELECT
       SUM(CASE WHEN started_at >= ? AND started_at < ? THEN 1 ELSE 0 END) AS previous_events,
       SUM(CASE WHEN started_at >= ? AND started_at <= ? THEN 1 ELSE 0 END) AS current_events
       FROM monitor_sellout_episodes WHERE started_at >= ? AND started_at <= ?${selected}`,
    ...eventBindings).toArray()[0];
    const periods = segments.length > 200000 ? [
      emptyPeriod(counts.previous_events || 0), emptyPeriod(counts.current_events || 0),
    ] : [
      periodMetric(Math.max(previousStart, recordingStartedAt), currentStart, segments, counts.previous_events || 0),
      periodMetric(Math.max(currentStart, recordingStartedAt), now, segments, counts.current_events || 0),
    ];
    const [previous, current] = periods;
    const sufficient = periods.every((period) => period.observedProductHours >= MIN_COMPARISON_HOURS &&
      period.events >= MIN_COMPARISON_EVENTS);
    let status = 'insufficient';
    let changePercent = null;
    if (sufficient) {
      const previousRate = previous.events * 100 * HOUR_MS / previous._observedMs;
      const currentRate = current.events * 100 * HOUR_MS / current._observedMs;
      if (previousRate > 0) {
        changePercent = round((currentRate / previousRate - 1) * 100, 1);
      }
      status = currentRate > previousRate ? 'up' : currentRate < previousRate ? 'down' : 'flat';
    }
    delete current._observedMs;
    delete previous._observedMs;
    return {
      current, previous, changePercent, status,
      minSampleRequired: { eventsPerPeriod: MIN_COMPARISON_EVENTS, observedProductHoursPerPeriod: MIN_COMPARISON_HOURS },
      notes: sufficient ? '同じ30日間どうしを商品監視時間で補正して比較しています。'
        : '両期間に十分な入荷件数と商品監視時間がないため、増減を判定していません。',
    };
  }

  sellout(style, start, now, verifiedFrom) {
    const selected = style === 'all' ? '' : ' AND style_color = ?';
    const bindings = style === 'all' ? [start, now, verifiedFrom, MAX_SELL_OUT_ROWS + 1]
      : [start, now, verifiedFrom, style, MAX_SELL_OUT_ROWS + 1];
    const rows = this.sql.exec(`SELECT ended_at, min_duration_ms, max_duration_ms, censored
      FROM monitor_sellout_episodes WHERE started_at >= ? AND started_at <= ? AND restock_lower_at >= ?${selected}
      ORDER BY started_at LIMIT ?`, ...bindings).toArray();
    const completed = rows.filter((row) => !row.censored && row.ended_at !== null &&
      Number.isFinite(row.min_duration_ms) && Number.isFinite(row.max_duration_ms));
    const middles = completed.map((row) => (row.min_duration_ms + row.max_duration_ms) / 120000).sort((a, b) => a - b);
    const lowers = completed.map((row) => row.min_duration_ms / 60000).sort((a, b) => a - b);
    const uppers = completed.map((row) => row.max_duration_ms / 60000).sort((a, b) => a - b);
    return {
      sampleCount: completed.length,
      censoredCount: rows.filter((row) => row.censored || row.ended_at === null).length,
      medianMinutes: percentile(middles, 0.5), p25Minutes: percentile(middles, 0.25),
      p75Minutes: percentile(middles, 0.75), medianLowerMinutes: percentile(lowers, 0.5),
      medianUpperMinutes: percentile(uppers, 0.5), samplesTruncated: rows.length > MAX_SELL_OUT_ROWS,
      notes: '入荷と売切れは確認間隔の間に起きるため幅があります。途中の取得不能や長い空白は打切りとして所要時間から除外します。',
    };
  }

  metadata() {
    return this.sql.exec('SELECT * FROM monitor_analysis_meta WHERE id = 1').toArray()[0]
      || { started_at: this.now(), reliable_segments: 0, excluded_gaps: 0, last_pruned_day: null };
  }
}

function normalizeObservation(value, now) {
  if (!value || !STYLE_PATTERN.test(String(value.styleColor || '').trim().toUpperCase())) return null;
  const at = typeof value.observedAt === 'number' ? value.observedAt : Date.parse(value.observedAt || '');
  if (!Number.isFinite(at) || at > now + 60000 || at < now - RETENTION_MS) return null;
  if (!['in_stock', 'out_of_stock', 'indeterminate', 'unavailable'].includes(value.availability)) return null;
  const seconds = Number(value.expectedIntervalSeconds);
  return {
    styleColor: String(value.styleColor).trim().toUpperCase(), at, availability: value.availability,
    restockDetected: value.restockDetected === true,
    expectedIntervalMs: Math.min(3600000, Math.max(30000, Number.isFinite(seconds) ? seconds * 1000 : 120000)),
  };
}
function normalizeBoundary(value, now) {
  if (!value || !['paused', 'imported', 'disabled'].includes(value.reason)) return null;
  const at = typeof value.at === 'number' ? value.at : Date.parse(value.at || '');
  return Number.isFinite(at) && at <= now + 60000 ? { at, reason: value.reason } : null;
}
function coverageCells(segments, start, end) {
  const cells = Array.from({ length: 168 }, (_, index) => ({
    weekday: Math.floor(index / 24), hour: index % 24, observedMs: 0, restockEvents: 0,
  }));
  for (const segment of segments.slice(0, 200000)) {
    let cursor = Math.max(start, segment.start_at);
    const limit = Math.min(end, segment.end_at);
    if (cursor >= limit) continue;

    // Split only the two partial hours. Whole weeks contribute equally to all
    // 168 JST weekday/hour cells, so a multi-year segment remains bounded work.
    const nextHour = (Math.floor((cursor + JST_OFFSET_MS) / HOUR_MS) + 1) * HOUR_MS - JST_OFFSET_MS;
    const firstBoundary = Math.min(limit, nextHour);
    addCoverage(cells, cursor, firstBoundary - cursor);
    cursor = firstBoundary;
    if (cursor >= limit) continue;

    const completeHours = Math.floor((limit - cursor) / HOUR_MS);
    const completeWeeks = Math.floor(completeHours / 168);
    if (completeWeeks > 0) {
      const duration = completeWeeks * HOUR_MS;
      for (const cell of cells) cell.observedMs += duration;
      cursor += completeWeeks * 168 * HOUR_MS;
    }
    const remainingHours = Math.floor((limit - cursor) / HOUR_MS);
    for (let index = 0; index < remainingHours; index++) {
      addCoverage(cells, cursor, HOUR_MS);
      cursor += HOUR_MS;
    }
    if (cursor < limit) addCoverage(cells, cursor, limit - cursor);
  }
  return cells;
}
function addCoverage(cells, at, duration) {
  if (duration <= 0) return;
  const { weekday, hour } = jstCell(at);
  cells[weekday * 24 + hour].observedMs += duration;
}
function jstCell(at) {
  const date = new Date(at + JST_OFFSET_MS);
  return { weekday: date.getUTCDay(), hour: date.getUTCHours() };
}
function periodMetric(start, end, segments, eventCount) {
  const observedMs = segments.reduce((total, segment) =>
    total + Math.max(0, Math.min(end, segment.end_at) - Math.max(start, segment.start_at)), 0);
  const hours = observedMs / HOUR_MS;
  return {
    events: eventCount, observedProductHours: observedMs > 0 ? round(hours, 3) : null,
    ratePer100ProductHours: observedMs > 0 ? round(eventCount * 100 / hours, 3) : null,
    _observedMs: observedMs,
  };
}
function emptyPeriod(events) {
  return { events, observedProductHours: null, ratePer100ProductHours: null, _observedMs: 0 };
}
function percentile(sorted, point) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * point;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return round(sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction, 1);
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
