import { HttpError } from './lib/errors.js';
import type { Currency } from './lib/money.js';
import type { PaymentProvider, ProviderId, ProviderRegistry } from './providers/types.js';

/**
 * Which currency a customer pays in and which payment providers can take the
 * payment, decided by their billing country. Providers are in order of
 * preference; the first one configured on this server is used, so the US and
 * EU fall back to the mock provider when no Stripe key is set.
 */
export interface Region {
  id: 'US' | 'EU' | 'PK' | 'IN' | 'BD' | 'INTL';
  currency: Currency;
  providers: readonly ProviderId[];
}

const EURO_AREA = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
]);

export function regionFor(country: string): Region {
  const code = country.toUpperCase();
  if (code === 'US') return { id: 'US', currency: 'USD', providers: ['stripe', 'mock'] };
  if (EURO_AREA.has(code)) return { id: 'EU', currency: 'EUR', providers: ['stripe', 'mock'] };
  // JazzCash / Safepay, Razorpay and bKash adapters slot in here later.
  if (code === 'PK') return { id: 'PK', currency: 'PKR', providers: ['mock'] };
  if (code === 'IN') return { id: 'IN', currency: 'INR', providers: ['mock'] };
  if (code === 'BD') return { id: 'BD', currency: 'BDT', providers: ['mock'] };
  return { id: 'INTL', currency: 'USD', providers: ['mock'] };
}

/** The first of the region's providers that this server has configured. */
export function pickProvider(region: Region, registry: ProviderRegistry): PaymentProvider {
  for (const id of region.providers) {
    const provider = registry.get(id);
    if (provider) return provider;
  }
  throw new HttpError(503, 'provider_unavailable', `No payment provider is set up for ${region.id}`);
}

/** Countries offered in the app's billing-country picker. */
export const FEATURED_COUNTRIES = [
  { country: 'US', name: 'United States' },
  { country: 'DE', name: 'Germany' },
  { country: 'FR', name: 'France' },
  { country: 'PK', name: 'Pakistan' },
  { country: 'IN', name: 'India' },
  { country: 'BD', name: 'Bangladesh' },
] as const;
