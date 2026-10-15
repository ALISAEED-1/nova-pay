import request from 'supertest';

import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { seedPlans } from '../src/db/seed.js';
import { MockProvider } from '../src/providers/mock/mock-provider.js';
import type { PaymentProvider, ProviderId } from '../src/providers/types.js';

export const PUBLIC_BASE_URL = 'http://pay.test';
export const WEBHOOK_SECRET = 'whsec_test';

/**
 * A fresh in-memory database and app per test file. Extra providers (a Stripe
 * adapter with a fake network layer) can be registered beside the mock one.
 */
export async function createTestContext(options: { providers?: PaymentProvider[] } = {}) {
  const db = await openDb({});
  await seedPlans(db);

  // Webhooks travel through the real HTTP stack via supertest.
  let app: ReturnType<typeof createApp>;
  const mockProvider = new MockProvider({
    db,
    publicBaseUrl: PUBLIC_BASE_URL,
    webhookSecret: WEBHOOK_SECRET,
    deliver: async (body, headers) => {
      const response = await request(app).post('/v1/webhooks/mock').set(headers).send(body);
      if (response.status !== 200) throw new Error(`webhook answered ${response.status}`);
    },
  });
  const providers = new Map<ProviderId, PaymentProvider>([['mock', mockProvider]]);
  for (const provider of options.providers ?? []) providers.set(provider.id, provider);
  app = createApp({
    db,
    providers,
    mockProvider,
    jwtSecret: 'test-secret',
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  let users = 0;
  const register = async (country = 'US') => {
    users += 1;
    const response = await request(app)
      .post('/v1/auth/register')
      .send({ name: `User ${users}`, email: `user${users}@example.com`, password: 'secret123', country });
    if (response.status !== 201) throw new Error(`register failed: ${JSON.stringify(response.body)}`);
    return { token: response.body.token as string, email: `user${users}@example.com` };
  };

  const checkout = (token: string, body: object, key = `key-${Math.random()}`) =>
    request(app)
      .post('/v1/checkout/sessions')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);

  const startCheckout = (token: string, planId: string, key?: string) => checkout(token, { planId }, key);

  const startRental = (token: string, movieId: string, title = movieId, key?: string) =>
    checkout(token, { movieId, title }, key);

  /** Presses a button on the hosted checkout page, the way the customer would. */
  const pressCheckoutButton = (checkoutUrl: string, action: 'pay' | 'decline' | 'cancel') =>
    request(app).post(`${new URL(checkoutUrl).pathname}/${action}`);

  const get = (path: string, token: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);

  return { db, app, mockProvider, register, startCheckout, startRental, pressCheckoutButton, get };
}
