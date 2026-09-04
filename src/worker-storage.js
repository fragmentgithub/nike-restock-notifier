import { RestockArchive } from './worker-trend-storage.js';
import { TrendAnalytics } from './worker-trend-analytics.js';

const CHUNK_CHARACTERS = 128000;
const SAMPLE_TABLE_MARKER = 'cloudflare-samples-v1';

/** SQLite chunks keep the legacy 10,000-sample state clear of per-value limits. */
export class MonitorStorage {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS monitor_documents (
      name TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (name, part)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS monitor_sample_blocks (
      block INTEGER NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (block, part)
    )`);
    this.sampleRows = null;
    this.sampleBlocks = null;
    this.sampleGroups = null;
    this.documentChunks = new Map();
    this.trends = new RestockArchive(this.sql, { now });
    this.analytics = new TrendAnalytics(this.sql, { now });
    this.trendMetadata = undefined;
  }

  documentRows(name) {
    if (!this.documentChunks.has(name)) {
      const rows = this.sql.exec(
        'SELECT part, value FROM monitor_documents WHERE name = ? ORDER BY part', name,
      ).toArray();
      if (rows.some((row, index) => row.part !== index)) throw new Error('Incomplete monitor state');
      this.documentChunks.set(name, rows);
    }
    return this.documentChunks.get(name);
  }

  read(name, fallback = null) {
    const value = this.readDocument(name, fallback);
    if (name === 'state' && value?.checkSamples?.storage === SAMPLE_TABLE_MARKER) {
      value.checkSamples = [...this.samples().values()]
        .sort((left, right) => left.position - right.position)
        .map((row) => JSON.parse(row.value));
    }
    return value;
  }

  readDocument(name, fallback = null) {
    const rows = this.documentRows(name);
    if (!rows.length) return structuredClone(fallback);
    return JSON.parse(rows.map((row) => row.value).join(''));
  }

  archiveMetadata() {
    if (this.trendMetadata === undefined) this.trendMetadata = this.readDocument('trend-meta');
    return this.trendMetadata;
  }

  getTrends(options = {}) {
    const metadata = this.archiveMetadata();
    const day = Math.floor((this.trends.now() + 9 * 3600000) / 86400000);
    if (!metadata || metadata.lastPrunedDay !== day || !this.analytics.exists()) {
      this.write({}, { initializeTrends: true, initializeAnalytics: true });
    }
    const summary = this.trends.summarize(this.trendMetadata, options);
    summary.analytics = this.analytics.summarize(options);
    return summary;
  }

  samples() {
    // Fixed 128-position blocks bound cold reads to roughly 80 rows for a full
    // 10,000-sample ring. Warm alarm steps also reuse this reconstructed index.
    if (!this.sampleRows) {
      const chunks = this.sql.exec(
        'SELECT block, part, value FROM monitor_sample_blocks ORDER BY block, part',
      ).toArray();
      const sampleBlocks = new Map(chunks.map((row) => [`${row.block}:${row.part}`, row]));
      const blocks = new Map();
      for (const row of chunks) {
        const pieces = blocks.get(row.block) || [];
        if (row.part !== pieces.length) throw new Error('Incomplete monitor samples');
        pieces.push(row.value);
        blocks.set(row.block, pieces);
      }
      const sampleRows = new Map();
      for (const pieces of blocks.values()) {
        for (const [key, position, value] of JSON.parse(pieces.join(''))) {
          sampleRows.set(key, { sample_key: key, position, value });
        }
      }
      const sampleGroups = groupSamples(sampleRows);
      // A failed block must keep subsequent reads and writes from accepting the
      // successfully parsed prefix as the complete check history.
      this.sampleRows = sampleRows;
      this.sampleBlocks = sampleBlocks;
      this.sampleGroups = sampleGroups;
    }
    return this.sampleRows;
  }

  write(documents, {
    initializeTrends = false, initializeAnalytics = false,
    observation = null, analyticsBoundary = null,
  } = {}) {
    // Serialize first: a bad value must not leave a partially replaced document.
    let nextSamples;
    const serialized = Object.entries(documents).map(([name, value]) => {
      let storedValue = value;
      if (name === 'state') {
        nextSamples = this.prepareSamples(Array.isArray(value?.checkSamples) ? value.checkSamples : []);
        if (Array.isArray(value?.checkSamples)) {
          storedValue = { ...value, checkSamples: { storage: SAMPLE_TABLE_MARKER } };
        }
      }
      const text = JSON.stringify(storedValue);
      if (text === undefined) throw new TypeError('Monitor documents must be JSON values');
      return [name, text];
    });
    const prepared = nextSamples ? this.prepareSampleBlocks(nextSamples) : null;
    const nextBlocks = prepared?.blocks;
    const nextDocuments = new Map();
    const hasState = Object.hasOwn(documents, 'state');
    const metadata = hasState || initializeTrends ? this.archiveMetadata() : null;
    const archivePlan = hasState || initializeTrends ? this.trends.prepare(
      hasState ? documents.state : this.readDocument('state', {}),
      metadata, metadata ? null : this.readDocument('state', {}),
    ) : null;
    const analyticsPlan = hasState || initializeAnalytics || observation || analyticsBoundary
      ? this.analytics.prepare({ observation, boundary: analyticsBoundary }) : null;
    let nextMetadata;
    this.storage.transactionSync(() => {
      if (analyticsPlan) this.analytics.apply(analyticsPlan);
      if (archivePlan) {
        nextMetadata = this.trends.apply(archivePlan);
        serialized.push(['trend-meta', JSON.stringify(nextMetadata)]);
      }
      if (nextSamples) {
        for (const [key, row] of nextBlocks) {
          if (this.sampleBlocks.get(key)?.value !== row.value) {
            this.sql.exec(`INSERT INTO monitor_sample_blocks (block, part, value) VALUES (?, ?, ?)
              ON CONFLICT(block, part) DO UPDATE SET value = excluded.value`, row.block, row.part, row.value);
          }
        }
        for (const [key, row] of this.sampleBlocks) {
          if (!nextBlocks.has(key)) this.sql.exec(
            'DELETE FROM monitor_sample_blocks WHERE block = ? AND part = ?', row.block, row.part,
          );
        }
      }
      for (const [name, text] of serialized) {
        const previous = this.documentRows(name);
        const nextRows = [];
        let part = 0;
        for (const value of jsonChunks(text)) {
          if (previous[part]?.part !== part || previous[part]?.value !== value) {
            this.sql.exec(`INSERT INTO monitor_documents (name, part, value) VALUES (?, ?, ?)
              ON CONFLICT(name, part) DO UPDATE SET value = excluded.value`, name, part, value);
          }
          nextRows.push({ part, value });
          part += 1;
        }
        if (previous.length > part) {
          this.sql.exec('DELETE FROM monitor_documents WHERE name = ? AND part >= ?', name, part);
        }
        nextDocuments.set(name, nextRows);
      }
    });
    // Publish caches only after the whole transaction succeeds, including status.
    for (const [name, rows] of nextDocuments) this.documentChunks.set(name, rows);
    if (nextMetadata) this.trendMetadata = nextMetadata;
    if (nextSamples) {
      this.sampleRows = nextSamples;
      this.sampleBlocks = nextBlocks;
      this.sampleGroups = prepared.groups;
    }
  }

  prepareSamples(samples) {
    const previous = this.samples();
    let maximumPosition = -1;
    for (const row of previous.values()) maximumPosition = Math.max(maximumPosition, row.position);
    let position = -1;
    const occurrences = new Map();
    const next = new Map();
    for (const sample of samples) {
      const value = JSON.stringify(sample);
      const occurrence = occurrences.get(value) || 0;
      occurrences.set(value, occurrence + 1);
      const key = `${value}:${occurrence}`;
      const existing = previous.get(key);
      const existingPosition = existing?.position;
      // Normal ring-buffer shifts retain all existing positions. Reordered imports
      // receive new monotonic positions so exported order remains exactly faithful.
      position = existingPosition !== undefined && existingPosition > position
        ? existingPosition : ++maximumPosition;
      next.set(key, existing?.position === position ? existing : { sample_key: key, position, value });
    }
    return next;
  }

  prepareSampleBlocks(samples) {
    const grouped = groupSamples(samples);
    const next = new Map(this.sampleBlocks);
    for (const [key, row] of next) if (!grouped.has(row.block)) next.delete(key);
    for (const [block, entries] of grouped) {
      const previous = this.sampleGroups.get(block);
      if (previous?.length === entries.length && entries.every((entry, index) => entry === previous[index])) continue;
      // Most of the full history is unchanged: serialize only the blocks affected
      // by append/prune, retaining their already encoded neighbors verbatim.
      for (const [key, row] of next) if (row.block === block) next.delete(key);
      const records = entries.map((row) => [row.sample_key, row.position, row.value]);
      jsonChunks(JSON.stringify(records)).forEach((value, part) => {
        next.set(`${block}:${part}`, { block, part, value });
      });
    }
    return { blocks: next, groups: grouped };
  }

  async commit(documents, options = {}) {
    this.write(documents, options);
    // Explicitly commit before a subsequent Discord request is allowed to start.
    await this.storage.sync();
  }
}

function groupSamples(samples) {
  const grouped = new Map();
  for (const row of samples.values()) {
    const block = Math.floor(row.position / 128);
    const entries = grouped.get(block) || [];
    entries.push(row);
    grouped.set(block, entries);
  }
  return grouped;
}

function jsonChunks(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + CHUNK_CHARACTERS);
    // SQLite encodes each chunk as UTF-8; do not split an emoji's surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
