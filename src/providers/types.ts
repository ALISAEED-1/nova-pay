import type { IncomingHttpHeaders } from 'node:http';

import type { Currency } from '../lib/money.js';

export type ProviderId = 'mock' | 'stripe';

export interface CreateCheckoutInput {
  /** Our checkout session id; the provider echoes it back in webhooks. */
  reference: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  customerEmail: string;
  /** Where the provider sends the customer once they finish or cancel. */
  returnUrl: string;
  /**
   * Keep the payment method for later off-session charges (subscription
   * renewals). False for one-off purchases such as rentals.
   */
  savePaymentMethod: boolean;
}

export interface ProviderCheckout {
  providerSessionId: string;
  /** Hosted payment page. Card details are entered there, never in our app. */
  url: string;
}

/** How the customer paid, kept so later renewals can charge it. */
export interface SavedPaymentMethod {
  /** The provider's customer, when it has one (Stripe `cus_…`). */
  customerRef: string | null;
  /** A method that can be charged without the customer present, or null (wallets). */
  paymentMethodRef: string | null;
  /** For display: "Visa •••• 4242", "Mobile wallet". */
  label: string;
}

/** A finished checkout, in our own vocabulary. */
export type CheckoutOutcome =
  | {
      id: string;
      type: 'checkout.paid';
      providerSessionId: string;
      providerPaymentId: string;
      amountMinor: number;
      currency: string;
      /** Present when the checkout asked to keep the payment method. */
      savedPaymentMethod?: SavedPaymentMethod;
    }
  | {
      id: string;
      type: 'checkout.failed';
      providerSessionId: string;
      reason: string;
    };

/**
 * A webhook translated into our own vocabulary. Every adapter produces these,
 * so nothing outside `providers/` knows any provider's payload format.
 */
export type NormalizedEvent =
  | CheckoutOutcome
  | {
      /** A provider event we do not act on. Still recorded, never retried. */
      id: string;
      type: 'ignored';
      providerType: string;
    };

export interface PaymentProvider {
  readonly id: ProviderId;
  /**
   * Creates a hosted checkout. Must be idempotent on `idempotencyKey`: a retry
   * after a timeout returns the same checkout instead of a second one.
   */
  createCheckout(input: CreateCheckoutInput, idempotencyKey: string): Promise<ProviderCheckout>;
  /** Verifies the signature, then translates the payload. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): NormalizedEvent;
  /**
   * Asks the provider directly how a checkout ended; null while it is still
   * open. A safety net for a webhook that is late or never arrives.
   */
  fetchCheckoutOutcome?(providerSessionId: string): Promise<CheckoutOutcome | null>;
  /**
   * Charges a saved payment method with the customer absent (a renewal).
   * Idempotent on `idempotencyKey`. A decline is a result, not an error; it
   * throws only when the outcome is unknown, so the attempt can be retried.
   */
  chargeSavedPaymentMethod?(input: OffSessionCharge, idempotencyKey: string): Promise<ChargeResult>;
}

export interface OffSessionCharge {
  customerRef: string | null;
  paymentMethodRef: string | null;
  amountMinor: number;
  currency: Currency;
  /** Our invoice id. */
  reference: string;
  description: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerPaymentId: string }
  | { status: 'failed'; reason: string };

export class WebhookSignatureError extends Error {}

export type ProviderRegistry = ReadonlyMap<ProviderId, PaymentProvider>;
