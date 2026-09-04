const DOCUMENT_NAMES = Object.freeze(['state', 'status', 'control', 'trend-meta']);
const TABLE_NAMES = Object.freeze([
  'monitor_documents', 'monitor_sample_blocks', 'monitor_restock_events',
  'monitor_product_coverage', 'monitor_sellout_episodes',
  'monitor_analysis_cursors', 'monitor_analysis_meta', 'monitor_analysis_gaps',
]);
const PREFIX = 'daily';
const MAX_ROWS_PER_PAGE = 1000;
const SINGLE_ROW_CHUNK_BYTES = 180_000;
const TARGET_CHUNK_BYTES = 960_000;
const MAX_OBJECT_BYTES = 990_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Caller must serialize this with monitor activity for a consistent snapshot. */
export class MonitorBackup {
  constructor(storage, archive, { now = Date.now } = {}) {
    if (!storage?.sql || !storage?.transactionSync) throw new TypeError('SQLite storage is required.');
    if (!archive?.putChunk || !archive?.publish || !archive?.delete) throw new TypeError('A backup Durable Object is required.');
    this.storage = storage;
    this.sql = storage.sql;
    this.archive = archive;
    this.now = now;
  }

  async createDaily() {
    const createdAt = new Date(this.now()).toISOString();
    const day = createdAt.slice(0, 10);
    const generation = `${day}/${createdAt.replace(/[-:.Z]/g, '')}-${crypto.randomUUID()}`;
    try {
      const tables = [];
      let totalRows = 0;
      for (const table of TABLE_NAMES) {
        const schema = tableSchema(this.sql, table);
        if (!schema) continue;
        const summary = await this.exportTable(generation, table, schema);
        tables.push(summary);
        totalRows += summary.rowCount;
      }
      const contentHash = await sha256(JSON.stringify(tables));
      const manifest = { version: 1, generation, createdAt, totalRows, contentHash, tables };
      // The target publishes only after independently checking every stored chunk.
      await this.archive.publish(encoder.encode(JSON.stringify(manifest)));
      return { generation, createdAt, tables: tables.length, rows: totalRows };
    } catch (error) {
      // Every attempt uses a unique generation. Remove its partial chunks now so
      // a persistent failure cannot accumulate a full upload every cron retry.
      try { await this.archive.delete(generation); } catch {}
      throw error;
    }
  }

  async latest() {
    const value = await this.archive.latest();
    return validGeneration(value?.generation) ? value : null;
  }

  async list(limit = 30) {
    const values = await this.archive.list(limit);
    return Array.isArray(values) ? values.filter((value) => validGeneration(value?.generation)) : [];
  }

  async restore(generation) {
    if (!validGeneration(generation)) throw new RangeError('Invalid backup generation.');
    assertPaused(this.sql);
    const manifestBytes = await this.archive.getManifest(generation);
    if (!manifestBytes) throw new Error('Backup manifest was not found.');
    const manifest = validateManifest(JSON.parse(decodeBytes(manifestBytes)), generation);
    if (await sha256(JSON.stringify(manifest.tables)) !== manifest.contentHash) {
      throw new Error('Backup manifest integrity check failed.');
    }

    const staging = [];
    try {
      // A Worker termination during an earlier verification may have left only
      // isolated staging tables; they never contain live state and are safe to reset.
      this.storage.transactionSync(() => { for (const name of TABLE_NAMES) dropTable(this.sql, stageName(name)); });
      for (const table of manifest.tables) {
        const current = tableSchema(this.sql, table.name);
        if (!current || JSON.stringify(current) !== JSON.stringify(table.schema)) {
          throw new Error(`Backup schema does not match ${table.name}.`);
        }
        const stage = stageName(table.name);
        dropTable(this.sql, stage);
        this.sql.exec(`CREATE TABLE ${quote(stage)} AS SELECT ${current.columns.map(quote).join(',')} FROM ${quote(table.name)} WHERE 0`);
        staging.push(stage);
        let rows = 0;
        let contentHash = '';
        for (let index = 0; index < table.chunkCount; index += 1) {
          const bytes = await this.archive.getChunk(generation, table.name, index);
          if (!bytes) throw new Error(`Backup chunk is missing for ${table.name}.`);
          const text = decodeBytes(bytes);
          contentHash = await chainHash(contentHash, text);
          const chunk = JSON.parse(text);
          const values = chunk?.rows;
          if (chunk?.index !== index || !Array.isArray(values) ||
              values.some((row) => !Array.isArray(row) || row.length !== current.columns.length)) {
            throw new Error(`Backup chunk row count failed for ${table.name}.`);
          }
          this.storage.transactionSync(() => insertRows(this.sql, stage, current.columns, values));
          rows += values.length;
        }
        if (rows !== table.rowCount || contentHash !== table.contentHash) throw new Error(`Backup table integrity check failed for ${table.name}.`);
      }
      if (manifest.tables.reduce((sum, table) => sum + table.rowCount, 0) !== manifest.totalRows) {
        throw new Error('Backup total row count failed.');
      }

      this.storage.transactionSync(() => {
        // Recheck immediately before replacing any live rows.
        assertPaused(this.sql);
        const backedUp = new Map(manifest.tables.map((table) => [table.name, table]));
        for (const name of TABLE_NAMES) {
          const current = tableSchema(this.sql, name);
          if (!current) continue;
          if (name === 'monitor_documents') {
            this.sql.exec(`DELETE FROM ${quote(name)} WHERE name IN (${DOCUMENT_NAMES.map(() => '?').join(',')})`, ...DOCUMENT_NAMES);
          } else {
            this.sql.exec(`DELETE FROM ${quote(name)}`);
          }
          const table = backedUp.get(name);
          if (table) this.sql.exec(`INSERT INTO ${quote(name)} (${table.schema.columns.map(quote).join(',')}) SELECT ${table.schema.columns.map(quote).join(',')} FROM ${quote(stageName(name))}`);
        }
        applyRestoreBoundary(this.sql, this.now());
        forcePausedDocument(this.sql, 'control', (value) => ({ ...value, mode: 'paused' }));
        forcePausedDocument(this.sql, 'status', (value) => ({ ...value, nextCheckAt: null, meta: { ...value?.meta, mode: 'paused', running: false } }));
        for (const stage of staging) dropTable(this.sql, stage);
      });
      await this.storage.sync?.();
      return { generation, createdAt: manifest.createdAt, tables: manifest.tables.length, rows: manifest.totalRows, mode: 'paused' };
    } catch (error) {
      this.storage.transactionSync(() => { for (const stage of staging) dropTable(this.sql, stage); });
      throw error;
    }
  }

  async exportTable(generation, name, schema) {
    let chunkCount = 0;
    let contentHash = '';
    let rowCount = 0;
    let after = null;
    let pending = [];
    let pendingBytes = 2;
    const writeChunk = async () => {
      if (!pending.length) return;
      const text = JSON.stringify({ index: chunkCount, rows: pending });
      const bytes = encoder.encode(text).byteLength;
      if (bytes > MAX_OBJECT_BYTES) throw new Error(`A ${name} backup chunk is too large.`);
      await this.archive.putChunk(generation, name, chunkCount, encoder.encode(text));
      contentHash = await chainHash(contentHash, text);
      chunkCount += 1;
      pending = [];
      pendingBytes = 2;
    };
    while (true) {
      const page = selectPage(this.sql, name, schema, after);
      if (!page.length) break;
      for (const record of page) {
        const row = schema.columns.map((column) => record[column]);
        const bytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
        if (bytes > MAX_OBJECT_BYTES - 64) throw new Error(`A ${name} row exceeds the backup chunk limit.`);
        if (bytes > SINGLE_ROW_CHUNK_BYTES) {
          await writeChunk();
          pending.push(row);
          pendingBytes += bytes;
          rowCount += 1;
          await writeChunk();
          continue;
        }
        if (pending.length && pendingBytes + bytes > TARGET_CHUNK_BYTES) await writeChunk();
        pending.push(row);
        pendingBytes += bytes;
        rowCount += 1;
      }
      after = schema.primaryKey.map((column) => page.at(-1)[column]);
      if (page.length < MAX_ROWS_PER_PAGE) break;
    }
    await writeChunk();
    return { name, schema, rowCount, chunkCount, contentHash };
  }
}

/** Storage implementation for the singleton NikeBackup Durable Object. */
export class BackupArchive {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.sql = storage.sql;
    this.now = now;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS backup_chunks (
      generation TEXT NOT NULL, table_name TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      value BLOB NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(generation, table_name, chunk_index)
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS backup_generations (
      generation TEXT PRIMARY KEY, created_at INTEGER NOT NULL, total_rows INTEGER NOT NULL,
      table_count INTEGER NOT NULL, manifest BLOB NOT NULL
    ) WITHOUT ROWID`);
  }

  putChunk(generation, table, index, value) {
    if (!validGeneration(generation) || !TABLE_NAMES.includes(table) || !Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid backup chunk.');
    const bytes = normalizeBytes(value);
    if (!bytes.byteLength || bytes.byteLength > MAX_OBJECT_BYTES) throw new RangeError('Invalid backup chunk size.');
    this.sql.exec(`INSERT INTO backup_chunks (generation,table_name,chunk_index,value,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(generation,table_name,chunk_index) DO UPDATE SET value=excluded.value,created_at=excluded.created_at`,
    generation, table, index, bytes, this.now());
  }

  async publish(value) {
    const bytes = normalizeBytes(value);
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new RangeError('Backup manifest is too large.');
    const manifest = validateManifest(JSON.parse(decoder.decode(bytes)));
    if (await sha256(JSON.stringify(manifest.tables)) !== manifest.contentHash) throw new Error('Backup manifest integrity check failed.');
    let totalRows = 0;
    for (const table of manifest.tables) {
      let contentHash = '';
      let rows = 0;
      for (let index = 0; index < table.chunkCount; index += 1) {
        const record = this.sql.exec('SELECT value FROM backup_chunks WHERE generation=? AND table_name=? AND chunk_index=?', manifest.generation, table.name, index).toArray()[0];
        if (!record) throw new Error(`Backup chunk is missing for ${table.name}.`);
        const text = decodeBytes(record.value);
        const chunk = JSON.parse(text);
        if (chunk?.index !== index || !Array.isArray(chunk.rows)) throw new Error(`Invalid backup chunk for ${table.name}.`);
        rows += chunk.rows.length;
        contentHash = await chainHash(contentHash, text);
      }
      if (rows !== table.rowCount || contentHash !== table.contentHash) throw new Error(`Backup table integrity check failed for ${table.name}.`);
      totalRows += rows;
    }
    if (totalRows !== manifest.totalRows) throw new Error('Backup total row count failed.');
    this.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO backup_generations VALUES (?,?,?,?,?)
        ON CONFLICT(generation) DO UPDATE SET created_at=excluded.created_at,total_rows=excluded.total_rows,table_count=excluded.table_count,manifest=excluded.manifest`,
      manifest.generation, Date.parse(manifest.createdAt), manifest.totalRows, manifest.tables.length, bytes);
      this.pruneSync();
    });
    await this.storage.sync?.();
    return { generation: manifest.generation, createdAt: manifest.createdAt, rows: totalRows };
  }

  latest() { return this.list(1)[0] || null; }
  list(limit = 30) {
    const count = Math.max(1, Math.min(30, Number(limit) || 30));
    return this.sql.exec(`SELECT generation,created_at,total_rows,table_count FROM backup_generations
      ORDER BY created_at DESC,generation DESC LIMIT ?`, count).toArray().map((row) => ({
      generation: row.generation, createdAt: new Date(row.created_at).toISOString(), rows: row.total_rows, tables: row.table_count,
    }));
  }
  getManifest(generation) {
    if (!validGeneration(generation)) return null;
    return this.sql.exec('SELECT manifest FROM backup_generations WHERE generation=?', generation).toArray()[0]?.manifest || null;
  }
  getChunk(generation, table, index) {
    if (!validGeneration(generation) || !TABLE_NAMES.includes(table) || !Number.isSafeInteger(index) || index < 0) return null;
    return this.sql.exec(`SELECT value FROM backup_chunks WHERE generation=? AND table_name=? AND chunk_index=?
      AND EXISTS (SELECT 1 FROM backup_generations WHERE generation=?)`, generation, table, index, generation).toArray()[0]?.value || null;
  }
  async delete(generation) {
    if (!validGeneration(generation)) throw new RangeError('Invalid backup generation.');
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM backup_chunks WHERE generation=?', generation);
      this.sql.exec('DELETE FROM backup_generations WHERE generation=?', generation);
    });
    await this.storage.sync?.();
  }
  async prune() { this.storage.transactionSync(() => this.pruneSync()); await this.storage.sync?.(); }
  pruneSync() {
    this.sql.exec(`DELETE FROM backup_chunks WHERE generation IN (
      SELECT generation FROM backup_generations ORDER BY created_at DESC,generation DESC LIMIT -1 OFFSET 30)`);
    this.sql.exec(`DELETE FROM backup_generations WHERE generation IN (
      SELECT generation FROM backup_generations ORDER BY created_at DESC,generation DESC LIMIT -1 OFFSET 30)`);
    this.sql.exec(`DELETE FROM backup_chunks WHERE generation NOT IN (SELECT generation FROM backup_generations)
      AND created_at < ?`, this.now() - 86400000);
  }
}

function tableSchema(sql, name) {
  if (!TABLE_NAMES.includes(name)) return null;
  const rows = sql.exec(`PRAGMA table_info(${quote(name)})`).toArray();
  if (!rows.length) return null;
  const columns = rows.sort((a, b) => a.cid - b.cid).map((row) => row.name);
  const primaryKey = rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  if (!primaryKey.length) throw new Error(`${name} requires a primary key for bounded backup paging.`);
  return { columns, primaryKey };
}

function selectPage(sql, name, schema, after) {
  const filters = [];
  const args = [];
  if (name === 'monitor_documents') {
    filters.push(`name IN (${DOCUMENT_NAMES.map(() => '?').join(',')})`);
    args.push(...DOCUMENT_NAMES);
  }
  if (after) {
    filters.push(`(${schema.primaryKey.map(quote).join(',')}) > (${schema.primaryKey.map(() => '?').join(',')})`);
    args.push(...after);
  }
  return sql.exec(`SELECT ${schema.columns.map(quote).join(',')} FROM ${quote(name)} ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY ${schema.primaryKey.map(quote).join(',')} LIMIT ?`, ...args, MAX_ROWS_PER_PAGE).toArray();
}

function insertRows(sql, table, columns, rows) {
  const statement = `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  for (const row of rows) sql.exec(statement, ...row);
}

function assertPaused(sql) {
  const rows = sql.exec(`SELECT value FROM monitor_documents WHERE name = 'control' ORDER BY part`).toArray();
  let control = {};
  try { control = rows.length ? JSON.parse(rows.map((row) => row.value).join('')) : {}; } catch {}
  if (control.mode !== 'paused') throw new Error('Pause the monitor before restoring a backup.');
}

function forcePausedDocument(sql, name, update) {
  const rows = sql.exec('SELECT value FROM monitor_documents WHERE name = ? ORDER BY part', name).toArray();
  let value = {};
  try { value = rows.length ? JSON.parse(rows.map((row) => row.value).join('')) : {}; } catch {}
  const text = JSON.stringify(update(value));
  sql.exec('DELETE FROM monitor_documents WHERE name = ?', name);
  for (let offset = 0, part = 0; offset < text.length; part += 1) {
    let end = Math.min(text.length, offset + 128000);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    sql.exec('INSERT INTO monitor_documents (name, part, value) VALUES (?, ?, ?)', name, part, text.slice(offset, end));
    offset = end;
  }
}

function applyRestoreBoundary(sql, at) {
  if (!tableSchema(sql, 'monitor_analysis_cursors') || !tableSchema(sql, 'monitor_analysis_gaps') ||
      !tableSchema(sql, 'monitor_sellout_episodes')) return;
  sql.exec(`INSERT INTO monitor_analysis_gaps (style_color, occurred_at, reason)
    SELECT style_color, ?, 'restored' FROM monitor_analysis_cursors WHERE last_reliable_at IS NOT NULL
    ON CONFLICT(style_color, occurred_at) DO UPDATE SET reason=excluded.reason`, at);
  sql.exec(`UPDATE monitor_sellout_episodes SET ended_at=?, censored=1, censor_reason='restored'
    WHERE ended_at IS NULL`, at);
  sql.exec(`UPDATE monitor_analysis_cursors SET last_attempt_at=?, last_reliable_at=NULL,
    last_in_stock=NULL, stock_state=NULL, open_started_at=NULL, open_lower_at=NULL, segment_start=NULL`, at);
}

function validateManifest(value, generation) {
  if (!value || value.version !== 1 || !validGeneration(value.generation) ||
      (generation !== undefined && value.generation !== generation) || !Array.isArray(value.tables) ||
      !Number.isFinite(Date.parse(value.createdAt || '')) || !Number.isSafeInteger(value.totalRows) || value.totalRows < 0 ||
      typeof value.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.contentHash)) {
    throw new Error('Invalid backup manifest.');
  }
  const names = new Set();
  for (const table of value.tables) {
    if (!TABLE_NAMES.includes(table?.name) || names.has(table.name) ||
        !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 ||
        !Number.isSafeInteger(table.chunkCount) || table.chunkCount < 0 || typeof table.contentHash !== 'string' ||
        (table.chunkCount === 0 ? table.contentHash !== '' || table.rowCount !== 0 : !/^[0-9a-f]{64}$/.test(table.contentHash)) ||
        !Array.isArray(table.schema?.columns) || !Array.isArray(table.schema?.primaryKey)) throw new Error('Invalid backup table manifest.');
    const currentNames = [...table.schema.columns, ...table.schema.primaryKey];
    if (!table.schema.columns.length || !table.schema.primaryKey.length ||
        new Set(table.schema.columns).size !== table.schema.columns.length ||
        table.schema.primaryKey.some((name) => !table.schema.columns.includes(name)) ||
        currentNames.some((name) => typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(name))) throw new Error('Invalid backup schema.');
    names.add(table.name);
  }
  return value;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function chainHash(previous, text) { return sha256(`${previous}:${await sha256(text)}`); }
function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Backup payload must be bytes.');
}
function decodeBytes(value) {
  const bytes = normalizeBytes(value);
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error('Backup object is too large.');
  return decoder.decode(bytes);
}

function validGeneration(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\/\d{8}T\d{9}-[0-9a-f-]{36}$/i.test(value); }
function stageName(name) { return `backup_stage_${name}`; }
function dropTable(sql, name) { sql.exec(`DROP TABLE IF EXISTS ${quote(name)}`); }
function quote(value) { return `"${String(value).replaceAll('"', '""')}"`; }

export const BACKUP_POLICY = Object.freeze({ prefix: PREFIX, retainedGenerations: 30, maxRpcBytes: MAX_OBJECT_BYTES, documentNames: DOCUMENT_NAMES, tableNames: TABLE_NAMES });
