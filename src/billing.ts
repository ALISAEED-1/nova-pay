import type { Db, Queryable } from './db/index.js';
import { HttpError } from './lib/errors.js';
import { newId } from './lib/ids.js';
import { type Currency, type Money, money } from './lib/money.js';
import type { ProviderId, ProviderRegistry, SavedPaymentMethod } from './providers/types.js';

/**
 * The renewal rules. A period's invoice is raised a few days before it ends;
 * on the due date a saved card is charged, a failed charge is retried a few
 * times, and access continues through a grace period before the plan ends.
 */
export const BILLING_RULES = {
  /** Raise the invoice (and remind the customer) this many days before renewal. */
  reminderDays: 3,
  /** Retry a failed automatic charge this many days after the due date. */
  retryDays: [1, 3, 5],
  /** Keep access this many days after the due date while payment is sorted out. */
  graceDays: 7,
} as const;

export interface BillingDeps {
  db: Db;
  providers: ProviderRegistry;
}

export interface CycleReport {
  invoiced: number;
  renewed: number;
  failed: number;
  ended: number;
}

const DAY_MS = 86_400_000;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'past_due' | 'canceled';
  amount_minor: number;
  currency: Currency;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  provider: ProviderId | null;
  provider_customer_ref: string | null;
  payment_method_ref: string | null;
}

export interface InvoiceRow {
  id: string;
  subscription_id: string;
  user_id: string;
  plan_id: string;
  period_start: Date;
  period_end: Date;
  amount_minor: number;
  currency: Currency;
  status: 'open' | 'paid' | 'void' | 'uncollectible';
  collection: 'automatic' | 'manual';
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  paid_at: Date | null;
}

/** A record of what happened, standing in for the email a customer would get. */
export async function logBillingEvent(
  q: Queryable,
  userId: string,
  subscriptionId: string | null,
  type: string,
  data: Record<string, unknown> = {},
  at = new Date(),
): Promise<void> {
  await q.query(
    'INSERT INTO billing_events (id, user_id, subscription_id, type, data, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [newId('bev'), userId, subscriptionId, type, JSON.stringify(data), at],
  );
}

/**
 * One pass of the billing job. Safe to run as often as you like and to run
 * again after a crash: every step only acts on rows still in the state it
 * expects, and invoices are unique per period.
 */
export async function runBillingCycle(deps: BillingDeps, now = new Date()): Promise<CycleReport> {
  const report: CycleReport = { invoiced: 0, renewed: 0, failed: 0, ended: 0 };
  report.ended += await endScheduledCancellations(deps.db, now);
  report.invoiced += await raiseUpcomingInvoices(deps, now);
  const collected = await collectDueInvoices(deps, now);
  report.renewed += collected.renewed;
  report.failed += collected.failed;
  report.ended += await endExpiredGracePeriods(deps.db, now);
  return report;
}

/** Plans the customer canceled end when the period they paid for ends. */
async function endScheduledCancellations(db: Db, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `UPDATE subscriptions SET status = 'canceled', ended_reason = 'canceled', updated_at = $1
       WHERE status IN ('active', 'past_due') AND cancel_at_period_end AND current_period_end <= $1
       RETURNING id, user_id`,
      [now],
    );
    for (const sub of rows) {
      await voidOpenInvoices(tx, sub.id);
      await logBillingEvent(tx, sub.user_id, sub.id, 'ended', { reason: 'canceled' }, now);
    }
    return rows.length;
  });
}

/** Raises next period's invoice a few days ahead, at the price the customer locked in. */
async function raiseUpcomingInvoices(deps: BillingDeps, now: Date): Promise<number> {
  const { rows } = await deps.db.query<SubscriptionRow>(
    `SELECT s.* FROM subscriptions s
     WHERE s.status = 'active' AND NOT s.cancel_at_period_end
       AND s.current_period_end <= $1
       AND NOT EXISTS (
         SELECT 1 FROM invoices i WHERE i.subscription_id = s.id AND i.period_start = s.current_period_end
       )`,
    [addDays(now, BILLING_RULES.reminderDays)],
  );

  let raised = 0;
  for (const sub of rows) {
    const collection = canChargeAutomatically(deps.providers, sub) ? 'automatic' : 'manual';
    await deps.db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO invoices
           (id, subscription_id, user_id, plan_id, period_start, period_end, amount_minor, currency,
            status, collection, next_attempt_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '1 month', $6, $7, 'open', $8, $5, $9)
         ON CONFLICT (subscription_id, period_start) DO NOTHING
         RETURNING id`,
        [newId('inv'), sub.id, sub.user_id, sub.plan_id, sub.current_period_end, sub.amount_minor, sub.currency, collection, now],
      );
      if (!inserted.rows[0]) return;
      raised += 1;
      await logBillingEvent(
        tx,
        sub.user_id,
        sub.id,
        'renewal_upcoming',
        {
          invoiceId: inserted.rows[0].id,
          dueAt: sub.current_period_end.toISOString(),
          amount: money(Number(sub.amount_minor), sub.currency).formatted,
          collection,
        },
        now,
      );
    });
  }
  return raised;
}

const canChargeAutomatically = (providers: ProviderRegistry, sub: SubscriptionRow) => {
  const provider = sub.provider ? providers.get(sub.provider) : undefined;
  return Boolean(
    provider?.chargeSavedPaymentMethod && (sub.payment_method_ref || (sub.provider === 'stripe' && sub.provider_customer_ref)),
  );
};

/** Charges invoices that are due, or marks manual ones overdue. */
async function collectDueInvoices(deps: BillingDeps, now: Date): Promise<{ renewed: number; failed: number }> {
  const result = { renewed: 0, failed: 0 };
  const { rows: due } = await deps.db.query<{ id: string }>(
    `SELECT id FROM invoices WHERE status = 'open' AND next_attempt_at <= $1 ORDER BY next_attempt_at`,
    [now],
  );

  for (const { id } of due) {
    // Claim the attempt first: the attempt number goes into the provider's
    // idempotency key, so a crash after charging cannot charge twice.
    const claimed = await deps.db.query<InvoiceRow>(
      `UPDATE invoices SET attempt_count = attempt_count + 1, next_attempt_at = NULL
       WHERE id = $1 AND status = 'open' AND next_attempt_at <= $2
       RETURNING *`,
      [id, now],
    );
    const invoice = claimed.rows[0];
    if (!invoice) continue;

    const { rows: subs } = await deps.db.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [
      invoice.subscription_id,
    ]);
    const sub = subs[0]!;
    if (sub.status === 'canceled') {
      await deps.db.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [invoice.id]);
      continue;
    }

    const provider = sub.provider ? deps.providers.get(sub.provider) : undefined;
    let outcome: { ok: true; paymentId: string } | { ok: false; reason: string };
    if (invoice.collection === 'manual' || !provider?.chargeSavedPaymentMethod) {
      outcome = { ok: false, reason: 'awaiting_payment' };
    } else {
      try {
        const charge = await provider.chargeSavedPaymentMethod(
          {
            customerRef: sub.provider_customer_ref,
            paymentMethodRef: sub.payment_method_ref,
            amountMinor: Number(invoice.amount_minor),
            currency: invoice.currency,
            reference: invoice.id,
            description: `Nova Cinema ${invoice.plan_id} plan renewal`,
          },
          `${invoice.id}-attempt-${invoice.attempt_count}`,
        );
        outcome = charge.status === 'succeeded' ? { ok: true, paymentId: charge.providerPaymentId } : { ok: false, reason: charge.reason };
      } catch (err) {
        console.warn(`renewal charge for ${invoice.id} errored:`, (err as Error).message);
        outcome = { ok: false, reason: 'provider_error' };
      }
    }

    await deps.db.transaction(async (tx) => {
      if (outcome.ok) {
        await settleInvoice(tx, invoice.id, { provider: sub.provider!, providerPaymentId: outcome.paymentId }, now);
        result.renewed += 1;
      } else {
        await recordFailedAttempt(tx, invoice, outcome.reason, now);
        result.failed += 1;
      }
    });
  }
  return result;
}

/**
 * A failed attempt: schedule the next retry (automatic invoices only), move
 * the subscription to past_due and start the grace period.
 */
async function recordFailedAttempt(tx: Queryable, invoice: InvoiceRow, reason: string, now: Date) {
  const retryIndex = invoice.attempt_count - 1;
  const nextAttempt =
    invoice.collection === 'automatic' && retryIndex < BILLING_RULES.retryDays.length
      ? addDays(invoice.period_start, BILLING_RULES.retryDays[retryIndex]!)
      : null;
  await tx.query('UPDATE invoices SET last_error = $2, next_attempt_at = $3 WHERE id = $1', [invoice.id, reason, nextAttempt]);

  const graceUntil = addDays(invoice.period_start, BILLING_RULES.graceDays);
  await tx.query(
    `UPDATE subscriptions SET status = 'past_due', grace_until = COALESCE(grace_until, $2), updated_at = $3
     WHERE id = $1 AND status IN ('active', 'past_due')`,
    [invoice.subscription_id, graceUntil, now],
  );
  await logBillingEvent(
    tx,
    invoice.user_id,
    invoice.subscription_id,
    'payment_failed',
    {
      invoiceId: invoice.id,
      attempt: invoice.attempt_count,
      reason,
      nextAttemptAt: nextAttempt?.toISOString() ?? null,
      graceUntil: graceUntil.toISOString(),
    },
    now,
  );
}

/**
 * Marks an invoice paid and moves the subscription on to the period it pays
 * for. Used by the billing job and by "Pay now" checkouts. Returns false if
 * the invoice was no longer open (already paid some other way).
 */
export async function settleInvoice(
  tx: Queryable,
  invoiceId: string,
  payment: { provider: ProviderId; providerPaymentId: string; checkoutSessionId?: string },
  now: Date,
  savedPaymentMethod?: SavedPaymentMethod,
): Promise<boolean> {
  const { rows } = await tx.query<InvoiceRow>(
    `UPDATE invoices SET status = 'paid', paid_at = $2, next_attempt_at = NULL, last_error = NULL
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [invoiceId, now],
  );
  const invoice = rows[0];
  if (!invoice) return false;

  await tx.query(
    `INSERT INTO payments
       (id, user_id, checkout_session_id, invoice_id, amount_minor, currency, provider, provider_payment_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', $9)`,
    [
      newId('pay'),
      invoice.user_id,
      payment.checkoutSessionId ?? null,
      invoice.id,
      invoice.amount_minor,
      invoice.currency,
      payment.provider,
      payment.providerPaymentId,
      now,
    ],
  );
  await tx.query(
    `UPDATE subscriptions SET status = 'active', current_period_start = $2, current_period_end = $3,
       grace_until = NULL, updated_at = $4
     WHERE id = $1 AND status IN ('active', 'past_due')`,
    [invoice.subscription_id, invoice.period_start, invoice.period_end, now],
  );
  if (savedPaymentMethod) await saveSubscriptionPaymentMethod(tx, invoice.subscription_id, payment.provider, savedPaymentMethod);
  await logBillingEvent(
    tx,
    invoice.user_id,
    invoice.subscription_id,
    'renewed',
    { invoiceId: invoice.id, periodEnd: invoice.period_end.toISOString() },
    now,
  );
  return true;
}

export async function saveSubscriptionPaymentMethod(
  tx: Queryable,
  subscriptionId: string,
  provider: ProviderId,
  method: SavedPaymentMethod,
): Promise<void> {
  await tx.query(
    `UPDATE subscriptions SET provider = $2, provider_customer_ref = $3, payment_method_ref = $4, payment_method_label = $5
     WHERE id = $1`,
    [subscriptionId, provider, method.customerRef, method.paymentMethodRef, method.label],
  );
  // A new way of paying changes how the next invoice is collected.
  await tx.query(
    `UPDATE invoices SET collection = $2 WHERE subscription_id = $1 AND status = 'open'`,
    [subscriptionId, method.paymentMethodRef || (provider === 'stripe' && method.customerRef) ? 'automatic' : 'manual'],
  );
}

/** Past-due plans whose grace period ran out end, and their invoice is written off. */
async function endExpiredGracePeriods(db: Db, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `UPDATE subscriptions SET status = 'canceled', ended_reason = 'payment_failed', canceled_at = $1, updated_at = $1
       WHERE status = 'past_due' AND grace_until <= $1
       RETURNING id, user_id`,
      [now],
    );
    for (const sub of rows) {
      await tx.query(
        `UPDATE invoices SET status = 'uncollectible', next_attempt_at = NULL WHERE subscription_id = $1 AND status = 'open'`,
        [sub.id],
      );
      await logBillingEvent(tx, sub.user_id, sub.id, 'ended', { reason: 'payment_failed' }, now);
    }
    return rows.length;
  });
}

async function voidOpenInvoices(tx: Queryable, subscriptionId: string) {
  await tx.query(`UPDATE invoices SET status = 'void', next_attempt_at = NULL WHERE subscription_id = $1 AND status = 'open'`, [
    subscriptionId,
  ]);
}

/**
 * Cancels the user's plan. An active plan keeps working until the end of the
 * period already paid for; a past-due one ends straight away, since nothing
 * was paid for the time after its due date.
 */
export async function cancelSubscription(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const sub = rows[0];
    if (!sub || sub.status === 'canceled') {
      throw new HttpError(409, 'no_active_subscription', 'There is no plan to cancel.');
    }
    if (sub.status === 'past_due') {
      await tx.query(
        `UPDATE subscriptions SET status = 'canceled', ended_reason = 'canceled', canceled_at = $2, updated_at = $2
         WHERE id = $1`,
        [sub.id, now],
      );
      await voidOpenInvoices(tx, sub.id);
      await logBillingEvent(tx, userId, sub.id, 'ended', { reason: 'canceled' }, now);
      return;
    }
    if (sub.cancel_at_period_end) return;
    await tx.query(
      `UPDATE subscriptions SET cancel_at_period_end = true, canceled_at = $2, updated_at = $2 WHERE id = $1`,
      [sub.id, now],
    );
    await voidOpenInvoices(tx, sub.id);
    await logBillingEvent(tx, userId, sub.id, 'cancel_scheduled', { endsAt: sub.current_period_end.toISOString() }, now);
  });
}

/** Takes back a cancellation before the period ends; renewal carries on as before. */
export async function resumeSubscription(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const sub = rows[0];
    if (sub?.status === 'active' && !sub.cancel_at_period_end) return;
    if (!sub || sub.status !== 'active' || sub.current_period_end <= now) {
      throw new HttpError(409, 'cannot_resume', 'This plan has already ended. Choose a plan to start again.');
    }
    await tx.query(
      `UPDATE subscriptions SET cancel_at_period_end = false, canceled_at = NULL, updated_at = $2 WHERE id = $1`,
      [sub.id, now],
    );
    // Bring back the renewal invoice the cancellation voided.
    await tx.query(
      `UPDATE invoices SET status = 'open', attempt_count = 0, next_attempt_at = period_start, last_error = NULL
       WHERE subscription_id = $1 AND period_start = $2 AND status = 'void'`,
      [sub.id, sub.current_period_end],
    );
    await logBillingEvent(tx, userId, sub.id, 'resumed', {}, now);
  });
}

export interface InvoiceView {
  id: string;
  status: InvoiceRow['status'];
  collection: InvoiceRow['collection'];
  amount: Money;
  periodStart: string;
  periodEnd: string;
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  paidAt: string | null;
}

export const toInvoiceView = (row: InvoiceRow): InvoiceView => ({
  id: row.id,
  status: row.status,
  collection: row.collection,
  amount: money(Number(row.amount_minor), row.currency),
  periodStart: row.period_start.toISOString(),
  periodEnd: row.period_end.toISOString(),
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
  paidAt: row.paid_at?.toISOString() ?? null,
});

export async function listInvoices(db: Queryable, userId: string): Promise<InvoiceView[]> {
  const { rows } = await db.query<InvoiceRow>(
    'SELECT * FROM invoices WHERE user_id = $1 ORDER BY period_start DESC LIMIT 24',
    [userId],
  );
  return rows.map(toInvoiceView);
}

export async function findOpenInvoice(db: Queryable, userId: string, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await db.query<InvoiceRow>(
    `SELECT * FROM invoices WHERE id = $1 AND user_id = $2`,
    [invoiceId, userId],
  );
  const invoice = rows[0];
  if (!invoice) throw new HttpError(404, 'not_found', 'Invoice not found');
  if (invoice.status !== 'open') throw new HttpError(409, 'invoice_not_open', `This invoice is ${invoice.status}.`);
  return invoice;
}

export async function listBillingEvents(db: Queryable, userId: string) {
  const { rows } = await db.query<{ type: string; data: Record<string, unknown>; created_at: Date }>(
    'SELECT type, data, created_at FROM billing_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [userId],
  );
  return rows.map((r) => ({ type: r.type, data: r.data, at: r.created_at.toISOString() }));
}

/**
 * Development only: moves one user's billing dates back by `days`, as if that
 * much time had passed, then runs the billing job. Lets a demo show a renewal
 * or a failed payment without waiting a month.
 */
export async function advanceClockForUser(deps: BillingDeps, userId: string, days: number): Promise<CycleReport> {
  await deps.db.transaction(async (tx) => {
    const shift = [userId, days];
    await tx.query(
      `UPDATE subscriptions SET
         current_period_start = current_period_start - make_interval(days => $2),
         current_period_end = current_period_end - make_interval(days => $2),
         grace_until = grace_until - make_interval(days => $2),
         canceled_at = canceled_at - make_interval(days => $2)
       WHERE user_id = $1`,
      shift,
    );
    await tx.query(
      `UPDATE invoices SET
         period_start = period_start - make_interval(days => $2),
         period_end = period_end - make_interval(days => $2),
         next_attempt_at = next_attempt_at - make_interval(days => $2),
         paid_at = paid_at - make_interval(days => $2)
       WHERE user_id = $1`,
      shift,
    );
    await tx.query(
      `UPDATE rentals SET starts_at = starts_at - make_interval(days => $2), expires_at = expires_at - make_interval(days => $2)
       WHERE user_id = $1`,
      shift,
    );
  });
  return runBillingCycle(deps);
}
