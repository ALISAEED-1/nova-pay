import { beforeEach, describe, expect, it } from 'vitest';

import { runBillingCycle } from '../src/billing.js';
import { loadConfig } from '../src/config.js';
import { createTestContext } from './helpers.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

// Each test gets its own database: the billing job acts on every subscription,
// so time travel in one test must not move another test's plans.
let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeEach(async () => {
  ctx = await createTestContext();
});

const cycle = (at: number) => runBillingCycle({ db: ctx.db, providers: ctx.providers }, new Date(at));
const account = async (token: string) => (await ctx.get('/v1/me', token)).body;
const periodEnd = async (token: string) => Date.parse((await account(token)).subscription.currentPeriodEnd);
const paymentCount = async () =>
  Number((await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM payments')).rows[0]!.n);
const eventTypes = async (token: string) =>
  ((await ctx.get('/v1/subscription/events', token)).body.events as { type: string }[]).map((e) => e.type);

describe('automatic renewal', () => {
  it('raises the invoice three days early and charges the saved card on the due date', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'standard');
    const me = await account(user.token);
    expect(me.subscription).toMatchObject({ renewal: 'automatic', paymentMethod: 'Visa •••• 4242', openInvoice: null });
    const end = await periodEnd(user.token);

    expect((await cycle(end - 4 * DAY)).invoiced).toBe(0);
    expect((await cycle(end - 2 * DAY)).invoiced).toBe(1);
    expect((await account(user.token)).subscription.openInvoice).toMatchObject({
      status: 'open',
      collection: 'automatic',
      amount: { amountMinor: 1499, currency: 'USD' },
      periodStart: new Date(end).toISOString(),
    });

    const before = await paymentCount();
    expect((await cycle(end + MINUTE)).renewed).toBe(1);
    const renewed = (await account(user.token)).subscription;
    expect(renewed).toMatchObject({ status: 'active', hasAccess: true, openInvoice: null });
    // The new period follows on from the old one, not from when the job ran.
    expect(renewed.currentPeriodStart).toBe(new Date(end).toISOString());
    const newEnd = Date.parse(renewed.currentPeriodEnd);
    expect((newEnd - end) / DAY).toBeGreaterThanOrEqual(28);
    expect((newEnd - end) / DAY).toBeLessThanOrEqual(31);
    expect(await paymentCount()).toBe(before + 1);

    // Running the job again at the same moment charges nothing more.
    expect(await cycle(end + MINUTE)).toEqual({ invoiced: 0, renewed: 0, failed: 0, ended: 0 });
    expect(await paymentCount()).toBe(before + 1);
    expect(await eventTypes(user.token)).toEqual(expect.arrayContaining(['subscribed', 'renewal_upcoming', 'renewed']));
  });
});

describe('failed payments (dunning)', () => {
  it('retries a declined card, keeps access through the grace period, then ends the plan', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'basic', 'pay-failing-card');
    const end = await periodEnd(user.token);

    expect((await cycle(end + MINUTE)).failed).toBe(1);
    let sub = (await account(user.token)).subscription;
    expect(sub).toMatchObject({ status: 'past_due', hasAccess: true, graceUntil: new Date(end + 7 * DAY).toISOString() });
    expect(sub.openInvoice).toMatchObject({
      attemptCount: 1,
      lastError: 'insufficient_funds',
      nextAttemptAt: new Date(end + DAY).toISOString(),
    });

    // Retries after 1, 3 and 5 days, then no more.
    for (const [day, next] of [[1, 3], [3, 5], [5, null]] as const) {
      expect((await cycle(end + day * DAY + MINUTE)).failed).toBe(1);
      sub = (await account(user.token)).subscription;
      expect(sub.openInvoice.nextAttemptAt).toBe(next === null ? null : new Date(end + next * DAY).toISOString());
    }
    expect(sub.openInvoice.attemptCount).toBe(4);

    expect((await cycle(end + 6 * DAY)).ended).toBe(0);
    expect((await account(user.token)).subscription.hasAccess).toBe(true);

    expect((await cycle(end + 7 * DAY + MINUTE)).ended).toBe(1);
    sub = (await account(user.token)).subscription;
    expect(sub).toMatchObject({ status: 'canceled', hasAccess: false, endedReason: 'payment_failed', openInvoice: null });
    const invoices = (await ctx.get('/v1/subscription/invoices', user.token)).body.invoices;
    expect(invoices[0]).toMatchObject({ status: 'uncollectible', attemptCount: 4 });
  });

  it('lets a past-due customer pay the invoice with a new card and carries on renewing', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'premium', 'pay-failing-card');
    const end = await periodEnd(user.token);
    await cycle(end + MINUTE);
    const invoice = (await account(user.token)).subscription.openInvoice;

    await ctx.payInvoice(user.token, invoice.id, 'pay');
    const sub = (await account(user.token)).subscription;
    expect(sub).toMatchObject({
      status: 'active',
      graceUntil: null,
      paymentMethod: 'Visa •••• 4242',
      renewal: 'automatic',
      currentPeriodEnd: invoice.periodEnd,
    });

    // The new card renews the following period by itself.
    expect((await cycle(Date.parse(invoice.periodEnd) + MINUTE)).renewed).toBe(1);
  });

  it('refuses to pay an invoice that is settled or belongs to someone else', async () => {
    const owner = await ctx.register('US');
    const stranger = await ctx.register('US');
    await ctx.subscribe(owner.token, 'basic');
    const end = await periodEnd(owner.token);
    await cycle(end - DAY);
    const invoice = (await account(owner.token)).subscription.openInvoice;

    expect((await ctx.payInvoice(stranger.token, invoice.id)).status).toBe(404);
    await cycle(end + MINUTE);
    expect((await ctx.payInvoice(owner.token, invoice.id)).status).toBe(409);
  });
});

describe('manual renewal (mobile wallets)', () => {
  it('waits for the customer to pay, and they can pay ahead of the due date', async () => {
    const user = await ctx.register('PK');
    await ctx.subscribe(user.token, 'standard', 'pay-wallet');
    expect((await account(user.token)).subscription).toMatchObject({ renewal: 'manual', paymentMethod: 'Mobile wallet' });
    const end = await periodEnd(user.token);

    await cycle(end - 2 * DAY);
    const invoice = (await account(user.token)).subscription.openInvoice;
    expect(invoice).toMatchObject({ collection: 'manual', amount: { formatted: 'Rs 899' } });

    await ctx.payInvoice(user.token, invoice.id, 'pay-wallet');
    expect((await account(user.token)).subscription).toMatchObject({
      status: 'active',
      currentPeriodEnd: invoice.periodEnd,
      openInvoice: null,
    });
    expect(await cycle(end + MINUTE)).toMatchObject({ renewed: 0, failed: 0 });
  });

  it('goes past due when the wallet payer does not renew', async () => {
    const user = await ctx.register('PK');
    await ctx.subscribe(user.token, 'basic', 'pay-wallet');
    const end = await periodEnd(user.token);

    expect((await cycle(end + MINUTE)).failed).toBe(1);
    const sub = (await account(user.token)).subscription;
    expect(sub).toMatchObject({ status: 'past_due', hasAccess: true });
    expect(sub.openInvoice).toMatchObject({ lastError: 'awaiting_payment', nextAttemptAt: null });
  });
});

describe('cancel and resume', () => {
  it('keeps access until the period ends, then stops without charging', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'standard');
    const end = await periodEnd(user.token);

    const canceled = await ctx.post('/v1/subscription/cancel', user.token);
    expect(canceled.body.subscription).toMatchObject({ status: 'active', hasAccess: true, cancelAtPeriodEnd: true });

    expect((await cycle(end - 2 * DAY)).invoiced).toBe(0);
    const before = await paymentCount();
    expect((await cycle(end + MINUTE)).ended).toBe(1);
    expect((await account(user.token)).subscription).toMatchObject({
      status: 'canceled',
      hasAccess: false,
      endedReason: 'canceled',
    });
    expect(await paymentCount()).toBe(before);
  });

  it('renews as normal when the cancellation is taken back in time', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'standard');
    const end = await periodEnd(user.token);
    await cycle(end - 2 * DAY);

    await ctx.post('/v1/subscription/cancel', user.token);
    expect((await account(user.token)).subscription.openInvoice).toBeNull();

    const resumed = await ctx.post('/v1/subscription/resume', user.token);
    expect(resumed.body.subscription).toMatchObject({ cancelAtPeriodEnd: false });
    expect(resumed.body.subscription.openInvoice).toMatchObject({ status: 'open' });
    expect((await cycle(end + MINUTE)).renewed).toBe(1);
  });

  it('ends a past-due plan straight away', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'basic', 'pay-failing-card');
    await cycle((await periodEnd(user.token)) + MINUTE);

    const canceled = await ctx.post('/v1/subscription/cancel', user.token);
    expect(canceled.body.subscription).toMatchObject({ status: 'canceled', hasAccess: false, openInvoice: null });
    expect((await ctx.post('/v1/subscription/resume', user.token)).status).toBe(409);
  });

  it('clears an overdue bill when the customer buys a plan afresh', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'basic', 'pay-failing-card');
    await cycle((await periodEnd(user.token)) + MINUTE);

    await ctx.subscribe(user.token, 'premium');
    const sub = (await account(user.token)).subscription;
    expect(sub).toMatchObject({ planId: 'premium', status: 'active', openInvoice: null, graceUntil: null });
    const invoices = (await ctx.get('/v1/subscription/invoices', user.token)).body.invoices;
    expect(invoices[0].status).toBe('void');
  });
});

describe('dev clock', () => {
  it('moves one user a month ahead so a demo can show a renewal', async () => {
    const user = await ctx.register('US');
    await ctx.subscribe(user.token, 'basic');
    const advanced = await ctx.post('/v1/dev/advance-clock', user.token, { days: 31 });
    expect(advanced.body.report.renewed).toBe(1);
    expect(advanced.body.account.subscription.status).toBe('active');
  });

  it('is off in production', () => {
    const production = { NODE_ENV: 'production', JWT_SECRET: 'x', MOCK_WEBHOOK_SECRET: 'y' };
    expect(loadConfig(production).devTools).toBe(false);
    expect(loadConfig({ ...production, DEV_TOOLS: 'true' }).devTools).toBe(false);
    expect(loadConfig({}).devTools).toBe(true);
  });
});
