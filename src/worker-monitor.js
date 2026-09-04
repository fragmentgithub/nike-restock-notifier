import { MonitorStorage } from './worker-storage.js';
import { createMonitorEngine } from './monitor-engine.js';
import { normalizeDiscordWebhook } from './discord.js';
import { MONITOR_MODES, scrubOutput, selectConfig, validateImport, validateMigrationTransfer } from './worker-admin.js';
import { boundedFetch } from './worker-network.js';
import { probeNike } from './worker-probe.js';

const RECOVERY_DELAY_MS = 120000;

/** One personal monitor fleet; static page requests never enter this object. */
export class MonitorController {
  constructor(ctx, env, { engineFactory = createMonitorEngine, probe = probeNike, now = Date.now } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.documents = new MonitorStorage(ctx.storage);
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
      persist: async (nextState, status) => {
        await this.documents.commit({ state: this.safe(nextState), status: this.safe(status) });
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

  async health() {
    const control = this.control();
    const alarm = await this.ctx.storage.getAlarm();
    const now = this.now();
    const schedulingHealthy = this.running || (Number.isFinite(alarm) && alarm >= now - RECOVERY_DELAY_MS);
    return {
      healthy: control.mode === 'paused' || (schedulingHealthy && !control.lastError),
      mode: control.mode, running: this.running,
      webhookConfigured: Boolean(normalizeDiscordWebhook(this.env.DISCORD_WEBHOOK)),
      lastStartedAt: control.lastStartedAt || null,
      lastCompletedAt: control.lastCompletedAt || null,
      nextAlarmAt: alarm ? new Date(alarm).toISOString() : null,
      lastError: control.lastError || null,
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
      });
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
      await this.documents.commit({ control, state: engine.snapshot(), status: this.safe(status) });
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
function compareRuns(left, right) {
  const runDifference = BigInt(left.runId) - BigInt(right.runId);
  const difference = runDifference || BigInt(left.runAttempt) - BigInt(right.runAttempt);
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
}
