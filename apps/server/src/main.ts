// Kaveyl Wiki server entry point.
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
// After a database came back in the setup (AD-075): end cleanly, Docker (restart: unless-stopped) starts the container again.
const restart = () => {
  app.server.log.info('restarting to take over the database from the backup');
  void app.close().then(() => process.exit(0));
};
const app = await buildApp(config, { requireSetupCode: true, restart });
await app.manager.start();
await app.server.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.server.log.info({ signal }, 'shutting down (flushing pending commits)');
    void app.close().then(() => process.exit(0));
  });
}
