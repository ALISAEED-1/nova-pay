import type { IncomingHttpHeaders } from 'node:http';

import Stripe from 'stripe';

import {
  type ChargeResult,
  type CheckoutOutcome,
  type CreateCheckoutInput,
  type NormalizedEvent,
  type OffSessionCharge,
  type PaymentProvider,
  type ProviderCheckout,
  WebhookSignatureError,
} from '../types.js';

/** How long a Stripe Checkout page stays payable. Stripe's minimum is 30 minutes. */
const CHECKOUT_LIFETIME_SECONDS = 60 * 60;

export interface StripeProviderOptions {
  secretKey: string;
  /** `whsec_…` from the Stripe dashboard or `stripe listen`. */
  webhookSecret?: string;
  /** Replaces the network layer in tests. */
  httpClient?: Stripe.HttpClient;
}

/**
 * Stripe Checkout in payment mode. Stripe hosts the card form (and 3-D Secure),
 * we create the session with our own price and read the result from signed
 * webhooks, or by asking Stripe when a webhook is late.
 */
export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeProviderOptions) {
    this.stripe = new Stripe(options.secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      appInfo: { name: 'nova-pay' },
      ...(options.httpClient ? { httpClient: options.httpClient } : {}),
    });
  }

  async createCheckout(input: CreateCheckoutInput, idempotencyKey: string): Promise<ProviderCheckout> {
    const cancelUrl = new URL(input.returnUrl);
    cancelUrl.searchParams.set('canceled', '1');

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: input.description },
            },
          },
        ],
        customer_email: input.customerEmail,
        client_reference_id: input.reference,
        metadata: { reference: input.reference },
        payment_intent_data: {
          metadata: { reference: input.reference },
          // Keeps the card on a Stripe customer for off-session renewals.
          ...(input.savePaymentMethod ? { setup_future_usage: 'off_session' as const } : {}),
        },
        ...(input.savePaymentMethod ? { customer_creation: 'always' as const } : {}),
        success_url: input.returnUrl,
        cancel_url: cancelUrl.toString(),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
      },
      // Stripe stores idempotency keys for 24 hours: a retry gets the same session.
      { idempotencyKey: `checkout-${idempotencyKey}` },
    );
    if (!session.url) throw new Error(`Stripe returned checkout session ${session.id} without a URL`);
    return { providerSessionId: session.id, url: session.url };
  }

  parseWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): NormalizedEvent {
    const secret = this.options.webhookSecret;
    if (!secret) throw new WebhookSignatureError('STRIPE_WEBHOOK_SECRET is not set');
    const signature = headers['stripe-signature'];
    if (typeof signature !== 'string') throw new WebhookSignatureError('missing Stripe-Signature header');

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw new WebhookSignatureError((err as Error).message);
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        // A completed session can still be unpaid (bank debits settle later);
        // async_payment_succeeded follows once the money arrives.
        return this.toOutcome(event.data.object, event.id) ?? ignored(event);
      case 'checkout.session.async_payment_failed':
        return {
          id: event.id,
          type: 'checkout.failed',
          providerSessionId: event.data.object.id,
          reason: 'async_payment_failed',
        };
      case 'checkout.session.expired':
        return { id: event.id, type: 'checkout.failed', providerSessionId: event.data.object.id, reason: 'expired' };
      default:
        return ignored(event);
    }
  }

  async fetchCheckoutOutcome(providerSessionId: string): Promise<CheckoutOutcome | null> {
    const session = await this.stripe.checkout.sessions.retrieve(providerSessionId);
    if (session.status === 'expired') {
      return { id: `status-${session.id}`, type: 'checkout.failed', providerSessionId: session.id, reason: 'expired' };
    }
    // Same id as any later status check, so the outcome is applied once.
    return this.toOutcome(session, `status-${session.id}`);
  }

  /**
   * Charges the customer's saved card for a renewal. The card itself is looked
   * up from the customer, since the checkout webhook only names the customer.
   */
  async chargeSavedPaymentMethod(input: OffSessionCharge, idempotencyKey: string): Promise<ChargeResult> {
    if (!input.customerRef) return { status: 'failed', reason: 'payment_method_missing' };
    let paymentMethod = input.paymentMethodRef;
    if (!paymentMethod) {
      const methods = await this.stripe.paymentMethods.list({ customer: input.customerRef, type: 'card', limit: 1 });
      paymentMethod = methods.data[0]?.id ?? null;
    }
    if (!paymentMethod) return { status: 'failed', reason: 'payment_method_missing' };

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          customer: input.customerRef,
          payment_method: paymentMethod,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: { reference: input.reference },
        },
        { idempotencyKey: `charge-${idempotencyKey}` },
      );
      return intent.status === 'succeeded'
        ? { status: 'succeeded', providerPaymentId: intent.id }
        : { status: 'failed', reason: `payment_${intent.status}` };
    } catch (err) {
      // A decline or a bank asking for 3-D Secure is an answer, not an outage:
      // the customer has to pay on-session (the "Pay now" link in the app).
      if (err instanceof Stripe.errors.StripeCardError) {
        return { status: 'failed', reason: err.decline_code ?? err.code ?? 'card_declined' };
      }
      throw err;
    }
  }

  private toOutcome(session: Stripe.Checkout.Session, eventId: string): CheckoutOutcome | null {
    if (session.payment_status !== 'paid') return null;
    const paymentIntent =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    return {
      id: eventId,
      type: 'checkout.paid',
      providerSessionId: session.id,
      providerPaymentId: paymentIntent ?? session.id,
      amountMinor: session.amount_total ?? 0,
      currency: (session.currency ?? '').toUpperCase(),
      ...(customer ? { savedPaymentMethod: { customerRef: customer, paymentMethodRef: null, label: 'Card (Stripe)' } } : {}),
    };
  }
}

const ignored = (event: Stripe.Event): NormalizedEvent => ({
  id: event.id,
  type: 'ignored',
  providerType: event.type,
});
