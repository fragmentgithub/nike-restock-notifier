import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { MonitorController } from './worker-monitor.js';
import { handleWorkerRequest } from './worker-admin.js';

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
    ctx.waitUntil(env.MONITOR.getByName('nike-jp').ensureScheduled());
  },
};
