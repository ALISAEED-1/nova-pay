import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { runBillingCycle } from '../src/billing.js';
import { FakeStripeApi, signedStripeEvent } from './fake-stripe.js';
import { createTestContext } from './helpers.js';

const MINUTE = 60_000;

let fakeApi: FakeStripeApi;
let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeEach(async () => {
  fakeApi = new FakeStripeApi();
  ctx = await createTestContext({ providers: [fakeApi.provider()] });
});

/** Buys a plan on (fake) Stripe and delivers the signed completion webhook. */
const subscribeOnStripe = async (token: string, planId: string) => {
  const created = await ctx.startCheckout(token, planId);
  const { rows } = await ctx.db.query<{ provider_session_id: string }>(
    'SELECT provider_session_id FROM checkout_sessions WHERE id = $1',
    [created.body.id],
  );
  const stripeSession = rows[0]!.provider_session_id;
  fakeApi.pay(stripeSession);
  const { payload, signature } = signedStripeEvent(
    'checkout.session.completed',
    fakeApi.sessions.get(stripeSession),
    `evt_${stripeSession}`,
  );
  await request(ctx.app)
    .post('/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', signature)
    .send(payload);
  return stripeSession;
};

const subscriptionOf = async (token: string) => (await ctx.get('/v1/me', token)).body.subscription;
const cycle = (at: number) => runBillingCycle({ db: ctx.db, providers: ctx.providers }, new Date(at));

describe('Stripe renewals', () => {
  it('saves the Stripe customer and charges the card off-session at renewal', async () => {
    const user = await ctx.register('US');
    const stripeSession = await subscribeOnStripe(user.token, 'premium');
    expect(fakeApi.created[0]!.params.get('customer_creation')).toBe('always');

    const sub = await subscriptionOf(user.token);
    expect(sub).toMatchObject({ renewal: 'automatic', paymentMethod: 'Card (Stripe)' });

    expect((await cycle(Date.parse(sub.currentPeriodEnd) + MINUTE)).renewed).toBe(1);
    const charge = fakeApi.charges[0]!;
    expect(charge.params.get('customer')).toBe(`cus_${stripeSession}`);
    expect(charge.params.get('payment_method')).toBe(`pm_for_cus_${stripeSession}`);
    expect(charge.params.get('off_session')).toBe('true');
    expect(charge.params.get('amount')).toBe('1999');
    expect(charge.idempotencyKey).toMatch(/^charge-inv_.+-attempt-1$/);
    expect((await subscriptionOf(user.token)).status).toBe('active');
  });

  it('treats a Stripe decline as a failed attempt and starts dunning', async () => {
    const user = await ctx.register('DE');
    await subscribeOnStripe(user.token, 'basic');
    const end = Date.parse((await subscriptionOf(user.token)).currentPeriodEnd);

    fakeApi.declineCharges = true;
    expect((await cycle(end + MINUTE)).failed).toBe(1);
    const sub = await subscriptionOf(user.token);
    expect(sub).toMatchObject({ status: 'past_due', hasAccess: true });
    expect(sub.openInvoice).toMatchObject({ lastError: 'insufficient_funds', attemptCount: 1 });

    // The next retry goes through once the card has funds again.
    fakeApi.declineCharges = false;
    expect((await cycle(Date.parse(sub.openInvoice.nextAttemptAt) + MINUTE)).renewed).toBe(1);
    expect((await subscriptionOf(user.token)).status).toBe('active');
  });
});
