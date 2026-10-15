import { createApp } from './app.js';
import { runBillingCycle } from './billing.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { seedPlans } from './db/seed.js';
import { MockProvider } from './providers/mock/mock-provider.js';
import { StripeProvider } from './providers/stripe/stripe-provider.js';
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
if (config.stripeSecretKey) {
  providers.set(
    'stripe',
    new StripeProvider({ secretKey: config.stripeSecretKey, webhookSecret: config.stripeWebhookSecret }),
  );
}

const app = createApp({
  db,
  providers,
  mockProvider,
  jwtSecret: config.jwtSecret,
  publicBaseUrl: config.publicBaseUrl,
  logRequests: config.logRequests,
  devTools: config.devTools,
});

// The renewal job. A single in-process timer is enough for one server; with
// several instances, run it from one scheduler (cron, a queue) instead. Every
// step is idempotent, so an overlapping or repeated run does no harm.
let billingRun: Promise<void> | null = null;
const runBilling = () => {
  billingRun ??= runBillingCycle({ db, providers })
    .then((report) => {
      if (Object.values(report).some((n) => n > 0)) console.log('billing cycle:', report);
    })
    .catch((err) => console.error('billing cycle failed:', err))
    .finally(() => {
      billingRun = null;
    });
  return billingRun;
};
const billingTimer = setInterval(runBilling, config.billingIntervalMs);

const server = app.listen(config.port, config.host, () => {
  const storage = config.databaseUrl ? 'Postgres' : `PGlite at ${config.pgliteDataDir}`;
  console.log(`nova-pay listening on http://${config.host}:${config.port} (public ${config.publicBaseUrl}, ${storage})`);
  console.log(`payment providers: ${[...providers.keys()].join(', ')}`);
  console.log(`billing job every ${config.billingIntervalMs / 1000}s${config.devTools ? ', dev tools on' : ''}`);
  if (config.stripeSecretKey && !config.stripeWebhookSecret) {
    console.warn('STRIPE_WEBHOOK_SECRET is not set: Stripe payments are confirmed by status checks only');
  }
  void runBilling();
});

const shutdown = () => {
  clearInterval(billingTimer);
  server.close(async () => {
    await billingRun;
    await mockProvider.flush();
    await db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
