const CHUNK_CHARACTERS = 128000;
const SAMPLE_TABLE_MARKER = 'cloudflare-samples-v1';

/** SQLite chunks keep the legacy 10,000-sample state clear of per-value limits. */
export class MonitorStorage {
  constructor(storage) {
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
  }

  read(name, fallback = null) {
    const rows = this.sql.exec(
      'SELECT part, value FROM monitor_documents WHERE name = ? ORDER BY part', name,
    ).toArray();
    if (!rows.length) return structuredClone(fallback);
    if (rows.some((row, index) => row.part !== index)) throw new Error('Incomplete monitor state');
    const value = JSON.parse(rows.map((row) => row.value).join(''));
    if (name === 'state' && value?.checkSamples?.storage === SAMPLE_TABLE_MARKER) {
      value.checkSamples = [...this.samples().values()]
        .sort((left, right) => left.position - right.position)
        .map((row) => JSON.parse(row.value));
    }
    return value;
  }

  samples() {
    // Fixed 128-position blocks bound cold reads to roughly 80 rows for a full
    // 10,000-sample ring. Warm alarm steps also reuse this reconstructed index.
    if (!this.sampleRows) {
      const chunks = this.sql.exec(
        'SELECT block, part, value FROM monitor_sample_blocks ORDER BY block, part',
      ).toArray();
      this.sampleBlocks = new Map(chunks.map((row) => [`${row.block}:${row.part}`, row]));
      const blocks = new Map();
      for (const row of chunks) {
        const pieces = blocks.get(row.block) || [];
        if (row.part !== pieces.length) throw new Error('Incomplete monitor samples');
        pieces.push(row.value);
        blocks.set(row.block, pieces);
      }
      this.sampleRows = new Map();
      for (const pieces of blocks.values()) {
        for (const [key, position, value] of JSON.parse(pieces.join(''))) {
          this.sampleRows.set(key, { sample_key: key, position, value });
        }
      }
    }
    return this.sampleRows;
  }

  write(documents) {
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
    const nextBlocks = nextSamples ? this.prepareSampleBlocks(nextSamples) : null;
    this.storage.transactionSync(() => {
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
        const previous = this.sql.exec(
          'SELECT part, value FROM monitor_documents WHERE name = ? ORDER BY part', name,
        ).toArray();
        let part = 0;
        for (const value of jsonChunks(text)) {
          if (previous[part]?.part !== part || previous[part]?.value !== value) {
            this.sql.exec(`INSERT INTO monitor_documents (name, part, value) VALUES (?, ?, ?)
              ON CONFLICT(name, part) DO UPDATE SET value = excluded.value`, name, part, value);
          }
          part += 1;
        }
        this.sql.exec('DELETE FROM monitor_documents WHERE name = ? AND part >= ?', name, part);
      }
    });
    if (nextSamples) { this.sampleRows = nextSamples; this.sampleBlocks = nextBlocks; }
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
      const existingPosition = previous.get(key)?.position;
      // Normal ring-buffer shifts retain all existing positions. Reordered imports
      // receive new monotonic positions so exported order remains exactly faithful.
      position = existingPosition !== undefined && existingPosition > position
        ? existingPosition : ++maximumPosition;
      next.set(key, { sample_key: key, position, value });
    }
    return next;
  }

  prepareSampleBlocks(samples) {
    const grouped = new Map();
    for (const row of samples.values()) {
      const block = Math.floor(row.position / 128);
      const entries = grouped.get(block) || [];
      entries.push([row.sample_key, row.position, row.value]);
      grouped.set(block, entries);
    }
    const next = new Map();
    for (const [block, entries] of grouped) {
      jsonChunks(JSON.stringify(entries)).forEach((value, part) => {
        next.set(`${block}:${part}`, { block, part, value });
      });
    }
    return next;
  }

  async commit(documents) {
    this.write(documents);
    // Explicitly commit before a subsequent Discord request is allowed to start.
    await this.storage.sync();
  }
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
