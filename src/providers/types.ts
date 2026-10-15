import type { IncomingHttpHeaders } from 'node:http';

import type { Currency } from '../lib/money.js';

export type ProviderId = 'mock';

export interface CreateCheckoutInput {
  /** Our checkout session id; the provider echoes it back in webhooks. */
  reference: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  customerEmail: string;
  /** Where the provider sends the customer once they finish or cancel. */
  returnUrl: string;
}

export interface ProviderCheckout {
  providerSessionId: string;
  /** Hosted payment page. Card details are entered there, never in our app. */
  url: string;
}

/**
 * A webhook translated into our own vocabulary. Every adapter produces these,
 * so nothing outside `providers/` knows any provider's payload format.
 */
export type NormalizedEvent =
  | {
      id: string;
      type: 'checkout.paid';
      providerSessionId: string;
      providerPaymentId: string;
      amountMinor: number;
      currency: string;
    }
  | {
      id: string;
      type: 'checkout.failed';
      providerSessionId: string;
      reason: string;
    }
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
}

export class WebhookSignatureError extends Error {}

export type ProviderRegistry = ReadonlyMap<ProviderId, PaymentProvider>;
