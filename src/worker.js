import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { MonitorController } from './worker-monitor.js';
import { handleWorkerRequest } from './worker-admin.js';
import { BackupArchive } from './worker-backup.js';

export class NikeMonitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.monitor = new MonitorController(ctx, env);
    });
  }

  getStatus() { return this.monitor.getStatus(); }
  getTrends(options) { return this.monitor.getTrends(options); }
  health() { return this.monitor.health(); }
  exportState() { return this.monitor.exportState(); }
  importState(payload) { return this.monitor.importState(payload); }
  acceptMigration(payload, identity) { return this.monitor.acceptMigration(payload, identity); }
  migrationCredential() { return this.monitor.migrationCredential(); }
  deleteMigrationCredential(migrationId) { return this.monitor.deleteMigrationCredential(migrationId); }
  setMode(mode) { return this.monitor.setMode(mode); }
  probe(target) { return this.monitor.probe(target); }
  alarm() { return this.monitor.alarm(); }
  ensureScheduled() { return this.monitor.ensureScheduled(); }
  ensureBackedUp() { return this.monitor.ensureBackedUp(); }
  backupNow() { return this.monitor.backupNow(); }
  listBackups() { return this.monitor.listBackups(); }
  restoreBackup(generation) { return this.monitor.restoreBackup(generation); }
}

// Backup data lives in a separate, private Durable Object. The public Worker
// never routes requests to it; only NikeMonitor can call these RPC methods.
export class NikeBackup extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.archive = new BackupArchive(ctx.storage); });
  }

  putChunk(generation, table, index, value) { return this.archive.putChunk(generation, table, index, value); }
  publish(value) { return this.archive.publish(value); }
  latest() { return this.archive.latest(); }
  list(limit) { return this.archive.list(limit); }
  getManifest(generation) { return this.archive.getManifest(generation); }
  getChunk(generation, table, index) { return this.archive.getChunk(generation, table, index); }
  delete(generation) { return this.archive.delete(generation); }
  prune() { return this.archive.prune(); }
}

// The separately authenticated viewer gets only read-only RPC methods. It never
// receives the admin token, notification webhook, or the control entrypoints.
export class MonitorViewer extends WorkerEntrypoint {
  getStatus() { return this.env.MONITOR.getByName('nike-jp').getStatus(); }
  getTrends(options) { return this.env.MONITOR.getByName('nike-jp').getTrends(options); }
}

export default {
  fetch: handleWorkerRequest,
  async scheduled(_event, env, ctx) {
    const monitor = env.MONITOR.getByName('nike-jp');
    // Keep alarm repair independent from backup health so either task can
    // succeed and report its own failure through Worker observability.
    ctx.waitUntil(monitor.ensureScheduled());
    ctx.waitUntil(monitor.ensureBackedUp());
  },
};
