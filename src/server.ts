import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { seedPlans } from './db/seed.js';
import { MockProvider } from './providers/mock/mock-provider.js';
import type { PaymentProvider, ProviderId } from './providers/types.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: every setting has a development default.
}
const config = loadConfig();
const db = await openDb(config);
await seedPlans(db);

// The mock provider calls our webhook endpoint over HTTP, exactly like a real
// provider would, so signature checks and retries are exercised for real.
const webhookUrl = `http://127.0.0.1:${config.port}/v1/webhooks/mock`;
const mockProvider = new MockProvider({
  db,
  publicBaseUrl: config.publicBaseUrl,
  webhookSecret: config.mockWebhookSecret,
  deliver: async (body, headers) => {
    const response = await fetch(webhookUrl, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`webhook endpoint answered ${response.status}`);
  },
});
const providers = new Map<ProviderId, PaymentProvider>([['mock', mockProvider]]);

const app = createApp({
  db,
  providers,
  mockProvider,
  jwtSecret: config.jwtSecret,
  publicBaseUrl: config.publicBaseUrl,
  logRequests: config.logRequests,
});

const server = app.listen(config.port, config.host, () => {
  const storage = config.databaseUrl ? 'Postgres' : `PGlite at ${config.pgliteDataDir}`;
  console.log(`nova-pay listening on http://${config.host}:${config.port} (public ${config.publicBaseUrl}, ${storage})`);
});

const shutdown = () => {
  server.close(async () => {
    await mockProvider.flush();
    await db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
