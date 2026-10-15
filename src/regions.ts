import type { Currency } from './lib/money.js';
import type { ProviderId } from './providers/types.js';

/**
 * Which currency a customer pays in and which payment provider handles it,
 * decided by their billing country. Phase 1 routes every region to the mock
 * provider; later phases swap in Stripe (US/EU), JazzCash/Safepay (PK), etc.
 */
export interface Region {
  id: 'US' | 'EU' | 'PK' | 'IN' | 'BD' | 'INTL';
  currency: Currency;
  provider: ProviderId;
}

const EURO_AREA = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
]);

export function regionFor(country: string): Region {
  const code = country.toUpperCase();
  if (code === 'US') return { id: 'US', currency: 'USD', provider: 'mock' };
  if (EURO_AREA.has(code)) return { id: 'EU', currency: 'EUR', provider: 'mock' };
  if (code === 'PK') return { id: 'PK', currency: 'PKR', provider: 'mock' };
  if (code === 'IN') return { id: 'IN', currency: 'INR', provider: 'mock' };
  if (code === 'BD') return { id: 'BD', currency: 'BDT', provider: 'mock' };
  return { id: 'INTL', currency: 'USD', provider: 'mock' };
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
