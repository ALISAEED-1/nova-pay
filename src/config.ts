export interface Config {
  port: number;
  host: string;
  /** Address phones and browsers use to reach this server. */
  publicBaseUrl: string;
  jwtSecret: string;
  mockWebhookSecret: string;
  /** Real Postgres connection string. When absent, embedded PGlite is used. */
  databaseUrl?: string;
  /** PGlite data directory. When absent, the database lives in memory. */
  pgliteDataDir?: string;
  /** Stripe test-mode secret key. When absent, US/EU checkouts use the mock provider. */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  logRequests: boolean;
}

const DEV_JWT_SECRET = 'dev-only-jwt-secret';
const DEV_WEBHOOK_SECRET = 'whsec_mock_dev_only';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 4000);

  const jwtSecret = env.JWT_SECRET || DEV_JWT_SECRET;
  const mockWebhookSecret = env.MOCK_WEBHOOK_SECRET || DEV_WEBHOOK_SECRET;
  if (production && (jwtSecret === DEV_JWT_SECRET || mockWebhookSecret === DEV_WEBHOOK_SECRET)) {
    throw new Error('JWT_SECRET and MOCK_WEBHOOK_SECRET must be set in production');
  }

  const stripeSecretKey = env.STRIPE_SECRET_KEY || undefined;
  // This project only ever handles test money. Refuse a live key outright
  // rather than risk charging a real card from a portfolio demo.
  if (stripeSecretKey && !/^(sk|rk)_test_/.test(stripeSecretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_… or rk_test_…)');
  }

  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    jwtSecret,
    mockWebhookSecret,
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDataDir: env.PGLITE_DATA_DIR || './data/pglite',
    stripeSecretKey,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    logRequests: env.LOG_REQUESTS !== 'false',
  };
}
