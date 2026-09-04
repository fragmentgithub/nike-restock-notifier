import { MonitorStorage } from './worker-storage.js';
import { createMonitorEngine } from './monitor-engine.js';
import { normalizeDiscordWebhook } from './discord.js';
import { MONITOR_MODES, scrubOutput, selectConfig, validateImport, validateMigrationTransfer } from './worker-admin.js';
import { boundedFetch } from './worker-network.js';
import { probeNike } from './worker-probe.js';
import { MonitorBackup } from './worker-backup.js';

const RECOVERY_DELAY_MS = 120000;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKUP_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const BACKUP_FAILURE_MESSAGE = 'Daily backup failed; automatic retry is scheduled.';
const BACKUP_GENERATION_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{8}T\d{9}-[0-9a-f-]{36}$/i;

/** One personal monitor fleet; static page requests never enter this object. */
export class MonitorController {
  constructor(ctx, env, { engineFactory = createMonitorEngine, probe = probeNike, now = Date.now } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.documents = new MonitorStorage(ctx.storage, { now });
    this.backup = env.BACKUPS
      ? new MonitorBackup(ctx.storage, env.BACKUPS.getByName('nike-jp-backups'), { now })
      : null;
    this.engineFactory = engineFactory;
    this.probeNike = probe;
    this.now = now;
    this.queue = Promise.resolve();
    this.running = false;
  }

  control() {
    const stored = this.documents.read('control', {});
    return { ...stored, mode: MONITOR_MODES.has(stored.mode) ? stored.mode : 'paused' };
  }

  secrets() {
    const webhook = String(this.env.DISCORD_WEBHOOK || '');
    const token = normalizeDiscordWebhook(webhook) ? new URL(webhook).pathname.split('/').filter(Boolean).at(-1) : '';
    return [webhook, this.env.ADMIN_TOKEN, token].filter(Boolean);
  }

  safe(value) { return scrubOutput(value, this.secrets()); }

  engine(control, state = this.documents.read('state', {})) {
    return this.engineFactory({
      state,
      env: { ...selectConfig(control.vars), ...selectConfig(this.env), DISCORD_WEBHOOK: this.env.DISCORD_WEBHOOK || '' },
      notify: control.mode === 'active', now: this.now, fetchImpl: boundedFetch,
      persist: async (nextState, status, metadata = {}) => {
        await this.documents.commit(
          { state: this.safe(nextState), status: this.safe(status) },
          { observation: this.safe(metadata.observation) },
        );
      },
    });
  }

  async getStatus() {
    const control = this.control();
    const status = this.documents.read('status') || this.engine(control).status();
    const alarm = await this.ctx.storage.getAlarm();
    return this.safe({
      ...status,
      nextCheckAt: control.mode === 'paused' ? null : alarm ? new Date(alarm).toISOString() : status.nextCheckAt,
      config: { ...status.config, runtime: 'cloudflare', discordWebhookSet: Boolean(normalizeDiscordWebhook(this.env.DISCORD_WEBHOOK)) },
      meta: {
        provider: 'cloudflare', mode: control.mode, running: this.running,
        importedAt: control.importedAt || null,
        lastTickAt: control.lastCompletedAt || null,
        lastError: control.lastError || null,
      },
    });
  }

  async getTrends(options = {}) {
    return this.exclusive(async () => this.safe(await this.documents.getTrends(options)));
  }

  async health() {
    const control = this.control();
    const alarm = await this.ctx.storage.getAlarm();
    const now = this.now();
    const schedulingHealthy = this.running || (Number.isFinite(alarm) && alarm >= now - RECOVERY_DELAY_MS);
    const monitorHealthy = control.mode === 'paused' || (schedulingHealthy && !control.lastError);
    let lastBackupAt = validBackupDate(control.lastBackupAt);
    let backupFailureStreak = failureStreak(control.backupFailureStreak);
    let lastBackupError = typeof control.lastBackupError === 'string' ? control.lastBackupError : null;

    // Existing deployments have no backup fields until their first scheduled run.
    // Read the latest private generation during that rolling-upgrade window.
    if (!lastBackupAt && backupFailureStreak === 0 && this.backup) {
      try {
        lastBackupAt = validBackupDate((await this.backup.latest())?.createdAt);
      } catch {
        backupFailureStreak = 1;
        lastBackupError = BACKUP_FAILURE_MESSAGE;
      }
    }
    const backupTimestamp = Date.parse(lastBackupAt || '');
    const backupHealthy = Boolean(this.backup) && backupFailureStreak === 0 &&
      Number.isFinite(backupTimestamp) && backupTimestamp <= now + BACKUP_FUTURE_TOLERANCE_MS &&
      now - backupTimestamp <= BACKUP_MAX_AGE_MS;
    return {
      healthy: monitorHealthy && backupHealthy,
      monitorHealthy,
      backupHealthy,
      mode: control.mode, running: this.running,
      webhookConfigured: Boolean(normalizeDiscordWebhook(this.env.DISCORD_WEBHOOK)),
      lastStartedAt: control.lastStartedAt || null,
      lastCompletedAt: control.lastCompletedAt || null,
      nextAlarmAt: alarm ? new Date(alarm).toISOString() : null,
      lastError: control.lastError || null,
      lastBackupAt,
      backupFailureStreak,
      lastBackupError,
    };
  }

  async exportState() {
    return this.exclusive(async () => {
      const control = this.control();
      return this.safe({
        state: this.documents.read('state', {}), vars: selectConfig(control.vars),
        mode: control.mode, importedAt: control.importedAt || null,
        migrationId: control.migrationId || null,
      });
    });
  }

  async importState(payload) {
    return this.exclusive(() => this.applyImport(payload));
  }

  async acceptMigration(payload, identity) {
    return this.exclusive(async () => {
      const error = validateMigrationTransfer(payload, identity);
      if (error) return failure(400, error);
      const { encryptedWebhook, ...importPayload } = payload;
      return this.applyImport(importPayload, {
        sourceRun: { runId: identity.runId, runAttempt: identity.runAttempt },
        credential: { migrationId: identity.migrationId, encryptedWebhook },
      });
    });
  }

  async migrationCredential() {
    return this.exclusive(async () => {
      const credential = this.documents.read('migration-credential');
      return credential
        ? { migrationId: credential.migrationId, encryptedWebhook: credential.encryptedWebhook }
        : failure(404, 'No migration credential is stored.');
    });
  }

  async deleteMigrationCredential(migrationId) {
    return this.exclusive(async () => {
      if (typeof migrationId !== 'string' || !migrationId) return failure(400, 'migrationId is required.');
      const credential = this.documents.read('migration-credential');
      if (credential && credential.migrationId !== migrationId) return failure(409, 'Migration identity does not match.');
      await this.documents.commit({ 'migration-credential': null });
      return { ok: true, deleted: Boolean(credential) };
    });
  }

  async applyImport(payload, { credential, sourceRun } = {}) {
      const error = validateImport(payload);
      if (error) return failure(400, error);
      const control = this.control();
      if (control.mode !== 'paused') return failure(409, 'Pause the monitor before importing state.');
      if (sourceRun && control.lastMigrationRun) {
        const difference = compareRuns(sourceRun, control.lastMigrationRun);
        if (difference < 0) return failure(409, 'A newer migration has already been accepted.');
        if (difference === 0) return { ok: true, mode: 'paused', imported: false, migrationId: payload.migrationId };
      }
      if (payload.migrationId && payload.migrationId === control.migrationId) {
        return { ok: true, mode: control.mode, imported: false, migrationId: control.migrationId };
      }
      const nextControl = {
        ...control, vars: selectConfig(payload.vars ?? payload.config ?? control.vars),
        importedAt: new Date(this.now()).toISOString(), migrationId: payload.migrationId || null,
        lastError: null,
        ...(sourceRun ? { lastMigrationRun: sourceRun } : {}),
      };
      const importedState = this.safe(payload.state);
      if (sourceRun) {
        // Resolve canonical product URLs immediately after a new legacy transfer.
        // Notification keys and all observation/history records stay intact.
        delete importedState.discoveryCycle;
        delete importedState.lastDiscoveryAt;
        delete importedState.lastDiscoverySuccessAt;
        delete importedState.lastDiscoveryAttemptAt;
      }
      const engine = this.engine(nextControl, importedState);
      const status = engine.status();
      const state = engine.snapshot();
      await this.documents.commit({
        control: nextControl, state, status: this.safe(status),
        ...(credential ? { 'migration-credential': credential } : {}),
      }, { analyticsBoundary: { at: new Date(this.now()).toISOString(), reason: 'imported' } });
      await this.ctx.storage.deleteAlarm();
      return {
        ok: true, mode: 'paused', imported: true, migrationId: nextControl.migrationId,
        products: Object.keys(state.knownProducts || {}).length,
        checkSamples: state.checkSamples?.length || 0,
        history: state.history?.length || 0, events: state.events?.length || 0,
      };
  }

  async setMode(mode) {
    // This queued operation resolves only after any in-flight notification has ended.
    return this.exclusive(async () => {
      if (!MONITOR_MODES.has(mode)) return failure(400, 'Invalid monitor mode.');
      if (mode === 'active' && !normalizeDiscordWebhook(this.env.DISCORD_WEBHOOK)) {
        return failure(409, 'Configure a valid DISCORD_WEBHOOK secret before activating notifications.');
      }
      const control = { ...this.control(), mode, lastError: null, modeChangedAt: new Date(this.now()).toISOString() };
      const engine = this.engine(control);
      const status = engine.status();
      if (mode !== 'paused' && status.config?.productConfigError) {
        return failure(409, 'Correct the product configuration before starting monitoring.');
      }
      await this.documents.commit(
        { control, state: engine.snapshot(), status: this.safe(status) },
        mode === 'paused'
          ? { analyticsBoundary: { at: new Date(this.now()).toISOString(), reason: 'paused' } }
          : {},
      );
      if (mode === 'paused') await this.ctx.storage.deleteAlarm();
      else await this.scheduleNext(engine);
      return { ok: true, ...(await this.health()) };
    });
  }

  async probe(target) {
    return this.exclusive(async () => {
      if (!['mind', 'fragment', 'catalog'].includes(target)) return failure(400, 'Invalid probe target.');
      try { return this.safe(await this.probeNike(target)); }
      catch { return failure(502, 'Nike probe failed.'); }
    });
  }

  async alarm() {
    if (this.running) {
      // A slow check can outlive the recovery interval. Consuming this alarm
      // must not leave that still-running check without a future recovery attempt.
      await this.ctx.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      return;
    }
    return this.exclusive(async () => {
      let control = this.control();
      if (control.mode === 'paused') { await this.ctx.storage.deleteAlarm(); return; }
      this.running = true;
      try {
        // A recovery alarm exists before any external request. Crashes cannot silently
        // stop the monitor, and the cron watchdog repairs a missing/overdue alarm.
        await this.ctx.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
        control = { ...control, lastStartedAt: new Date(this.now()).toISOString() };
        const engine = this.engine(control);
        // The engine starts from committed state and persists every completed step
        // (and before Discord). Do not reaggregate and rewrite the old history here.
        await this.documents.commit({ control });
        await engine.tick();
        control = { ...control, lastCompletedAt: new Date(this.now()).toISOString(), lastError: null };
        await this.documents.commit({ control });
        await this.scheduleNext(engine);
      } catch {
        await this.documents.commit({
          control: { ...control, lastError: 'Monitoring step failed; a retry is scheduled.' },
        });
        await this.ctx.storage.setAlarm(this.now() + RECOVERY_DELAY_MS);
      } finally { this.running = false; }
    });
  }

  async ensureScheduled() {
    if (this.running) return { repaired: false, running: true };
    return this.exclusive(async () => {
      const control = this.control();
      if (control.mode === 'paused') {
        await this.ctx.storage.deleteAlarm();
        return { repaired: false, mode: 'paused' };
      }
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm !== null && alarm >= this.now() - RECOVERY_DELAY_MS) return { repaired: false };
      const engine = this.engine(control);
      await this.scheduleNext(engine);
      return { repaired: true };
    });
  }

  async ensureBackedUp() {
    return this.exclusive(async () => {
      try {
        if (!this.backup) throw new Error(BACKUP_FAILURE_MESSAGE);
        const latest = await this.backup.latest();
        const today = new Date(this.now()).toISOString().slice(0, 10);
        if (latest?.createdAt?.slice(0, 10) === today) {
          await this.recordBackupSuccess(latest);
          return { ok: true, created: false, latest };
        }
        const created = await this.backup.createDaily();
        await this.recordBackupSuccess(created);
        return { ok: true, created: true, latest: created };
      } catch {
        await this.recordBackupFailure();
        throw new Error(BACKUP_FAILURE_MESSAGE);
      }
    });
  }

  async backupNow() {
    if (!this.backup) return failure(503, 'Backup storage is not configured.');
    return this.exclusive(async () => {
      try {
        const created = await this.backup.createDaily();
        await this.recordBackupSuccess(created);
        return { ok: true, ...created };
      } catch {
        await this.recordBackupFailure();
        throw new Error(BACKUP_FAILURE_MESSAGE);
      }
    });
  }

  async recordBackupSuccess(result) {
    const lastBackupAt = validBackupDate(result?.createdAt);
    if (!lastBackupAt) throw new Error(BACKUP_FAILURE_MESSAGE);
    const control = this.control();
    if (control.lastBackupAt === lastBackupAt && failureStreak(control.backupFailureStreak) === 0 &&
        !control.lastBackupError) return;
    await this.documents.commit({
      control: { ...control, lastBackupAt, backupFailureStreak: 0, lastBackupError: null },
    });
  }

  async recordBackupFailure() {
    const control = this.control();
    try {
      await this.documents.commit({
        control: {
          ...control,
          backupFailureStreak: Math.min(failureStreak(control.backupFailureStreak) + 1, 1000000),
          lastBackupError: BACKUP_FAILURE_MESSAGE,
        },
      });
    } catch {
      // The original failure remains generic even if Durable Object storage is unavailable.
    }
  }

  async listBackups() {
    if (!this.backup) return failure(503, 'Backup storage is not configured.');
    return this.exclusive(async () => ({ ok: true, generations: await this.backup.list(30) }));
  }

  async restoreBackup(generation) {
    if (!this.backup) return failure(503, 'Backup storage is not configured.');
    if (typeof generation !== 'string' || !BACKUP_GENERATION_PATTERN.test(generation)) {
      return failure(400, 'A valid backup generation is required.');
    }
    return this.exclusive(async () => {
      if (this.control().mode !== 'paused') return failure(409, 'Pause the monitor before restoring a backup.');
      const restored = await this.backup.restore(generation);
      // Restore replaces SQLite rows under the storage wrapper, so discard its
      // cached documents before any subsequent request reads state.
      this.documents = new MonitorStorage(this.ctx.storage, { now: this.now });
      await this.ctx.storage.deleteAlarm();
      return { ok: true, ...restored };
    });
  }

  async scheduleNext(engine) {
    const next = engine.nextAlarmAt();
    if (next === null || !Number.isFinite(next)) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(this.now() + 1000, next));
  }

  exclusive(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
}

function failure(status, error) { return { ok: false, status, error }; }
function validBackupDate(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function failureStreak(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function compareRuns(left, right) {
  const runDifference = BigInt(left.runId) - BigInt(right.runId);
  const difference = runDifference || BigInt(left.runAttempt) - BigInt(right.runAttempt);
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}
