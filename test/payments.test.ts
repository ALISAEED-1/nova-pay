import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { MOCK_SIGNATURE_HEADER, signMockPayload } from '../src/providers/mock/mock-provider.js';
import { PUBLIC_BASE_URL, WEBHOOK_SECRET, createTestContext } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeAll(async () => {
  ctx = await createTestContext();
});

const count = async (table: string) =>
  Number((await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);

describe('accounts', () => {
  it('registers, rejects a duplicate email and checks passwords', async () => {
    const { email } = await ctx.register('PK');

    const duplicate = await request(ctx.app)
      .post('/v1/auth/register')
      .send({ name: 'Again', email: email.toUpperCase(), password: 'secret123', country: 'PK' });
    expect(duplicate.status).toBe(409);

    const wrong = await request(ctx.app).post('/v1/auth/login').send({ email, password: 'nope-nope' });
    expect(wrong.status).toBe(401);

    const right = await request(ctx.app).post('/v1/auth/login').send({ email, password: 'secret123' });
    expect(right.status).toBe(200);
    expect(right.body.account.user).toMatchObject({ email, country: 'PK', currency: 'PKR' });
    expect(right.body.account.subscription).toBeNull();
  });

  it('rejects requests without a valid token', async () => {
    expect((await request(ctx.app).get('/v1/me')).status).toBe(401);
    expect((await ctx.get('/v1/me', 'not-a-token')).status).toBe(401);
  });
});

describe('plans', () => {
  it('prices plans in the currency of the billing country', async () => {
    const pk = await ctx.register('PK');
    const de = await ctx.register('DE');
    const us = await ctx.register('US');

    const prices = async (token: string) =>
      (await ctx.get('/v1/plans', token)).body.plans.map((p: { price: { formatted: string } }) => p.price.formatted);

    expect(await prices(pk.token)).toEqual(['Rs 599', 'Rs 899', 'Rs 1,199']);
    expect(await prices(de.token)).toEqual(['€8.99', '€13.99', '€17.99']);
    expect(await prices(us.token)).toEqual(['$9.99', '$14.99', '$19.99']);
  });

  it('follows a change of billing country', async () => {
    const user = await ctx.register('US');
    const patched = await request(ctx.app)
      .patch('/v1/me')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ country: 'in' });
    expect(patched.body.user).toMatchObject({ country: 'IN', currency: 'INR' });
    expect((await ctx.get('/v1/plans', user.token)).body.currency).toBe('INR');
  });
});

describe('checkout', () => {
  it('pays for a plan end to end: checkout page, webhook, active subscription', async () => {
    const user = await ctx.register('PK');
    const created = await ctx.startCheckout(user.token, 'premium');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'open',
      planId: 'premium',
      amount: { amountMinor: 119900, currency: 'PKR', formatted: 'Rs 1,199' },
    });
    expect(created.body.checkoutUrl).toMatch(`${PUBLIC_BASE_URL}/mock-provider/checkout/`);

    const page = await request(ctx.app).get(new URL(created.body.checkoutUrl).pathname);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Rs 1,199');

    const paid = await ctx.pressCheckoutButton(created.body.checkoutUrl, 'pay');
    expect(paid.status).toBe(303);
    expect(paid.headers.location).toBe(created.body.returnUrl);

    await ctx.mockProvider.flush();
    const session = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(session.body.status).toBe('paid');

    const me = await ctx.get('/v1/me', user.token);
    expect(me.body.subscription).toMatchObject({
      planId: 'premium',
      planName: 'Premium',
      status: 'active',
      price: { amountMinor: 119900, currency: 'PKR' },
    });
    const days = (Date.parse(me.body.subscription.currentPeriodEnd) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('returns the same session for a repeated idempotency key', async () => {
    const user = await ctx.register('US');
    const first = await ctx.startCheckout(user.token, 'basic', 'same-key');
    const second = await ctx.startCheckout(user.token, 'basic', 'same-key');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.checkoutUrl).toBe(first.body.checkoutUrl);

    const otherPlan = await ctx.startCheckout(user.token, 'premium', 'same-key');
    expect(otherPlan.status).toBe(409);

    const noKey = await request(ctx.app)
      .post('/v1/checkout/sessions')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ planId: 'basic' });
    expect(noKey.status).toBe(400);
  });

  it('rejects an unknown plan', async () => {
    const user = await ctx.register('US');
    expect((await ctx.startCheckout(user.token, 'platinum')).status).toBe(404);
  });

  it('marks a declined card as failed and grants nothing', async () => {
    const user = await ctx.register('DE');
    const created = await ctx.startCheckout(user.token, 'standard');
    await ctx.pressCheckoutButton(created.body.checkoutUrl, 'decline');
    await ctx.mockProvider.flush();

    const session = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(session.body).toMatchObject({ status: 'failed', failureReason: 'card_declined' });
    expect((await ctx.get('/v1/me', user.token)).body.subscription).toBeNull();
  });

  it('leaves a canceled checkout open and sends no webhook', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'basic');
    const canceled = await ctx.pressCheckoutButton(created.body.checkoutUrl, 'cancel');
    expect(canceled.headers.location).toContain('canceled=1');
    await ctx.mockProvider.flush();
    expect((await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token)).body.status).toBe('open');
  });

  it('charges once when Pay is tapped twice', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'basic');
    const before = await count('payments');
    await ctx.pressCheckoutButton(created.body.checkoutUrl, 'pay');
    await ctx.pressCheckoutButton(created.body.checkoutUrl, 'pay');
    await ctx.mockProvider.flush();
    expect(await count('payments')).toBe(before + 1);
  });

  it("hides another user's checkout session", async () => {
    const owner = await ctx.register('US');
    const stranger = await ctx.register('US');
    const created = await ctx.startCheckout(owner.token, 'basic');
    expect((await ctx.get(`/v1/checkout/sessions/${created.body.id}`, stranger.token)).status).toBe(404);
  });
});

describe('webhooks', () => {
  /** Builds a mock-provider event for a session, signed with `secret`. */
  const eventFor = async (sessionId: string, overrides: { amount?: number; id?: string } = {}) => {
    const { rows } = await ctx.db.query<{ provider_session_id: string; amount_minor: number; currency: string }>(
      'SELECT provider_session_id, amount_minor, currency FROM checkout_sessions WHERE id = $1',
      [sessionId],
    );
    const session = rows[0]!;
    return JSON.stringify({
      id: overrides.id ?? `evt_${Math.random()}`,
      type: 'payment.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          session: session.provider_session_id,
          payment: `mpay_${Math.random()}`,
          reference: sessionId,
          amount: overrides.amount ?? Number(session.amount_minor),
          currency: session.currency,
          failure_code: null,
        },
      },
    });
  };
  const send = (body: string, secret = WEBHOOK_SECRET) =>
    request(ctx.app)
      .post('/v1/webhooks/mock')
      .set('content-type', 'application/json')
      .set(MOCK_SIGNATURE_HEADER, signMockPayload(body, secret))
      .send(body);

  it('rejects a forged signature and changes nothing', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'premium');
    const forged = await send(await eventFor(created.body.id), 'wrong-secret');
    expect(forged.status).toBe(400);
    expect((await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token)).body.status).toBe('open');
  });

  it('rejects an unsigned request', async () => {
    const response = await request(ctx.app).post('/v1/webhooks/mock').send({ hello: 'world' });
    expect(response.status).toBe(400);
  });

  it('applies a redelivered event only once', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'standard');
    const body = await eventFor(created.body.id, { id: 'evt_redelivered' });
    const before = await count('payments');

    expect((await send(body)).body.outcome).toBe('processed');
    expect((await send(body)).body.outcome).toBe('duplicate');
    expect(await count('payments')).toBe(before + 1);
  });

  it('refuses access when the paid amount does not match the price', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'premium');
    await send(await eventFor(created.body.id, { amount: 1 }));

    const session = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(session.body).toMatchObject({ status: 'failed', failureReason: 'amount_mismatch' });
    expect((await ctx.get('/v1/me', user.token)).body.subscription).toBeNull();
  });
});
