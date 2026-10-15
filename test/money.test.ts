import { describe, expect, it } from 'vitest';

import { formatMoney } from '../src/lib/money.js';

describe('formatMoney', () => {
  it('formats each currency in its local style', () => {
    expect(formatMoney(999, 'USD')).toBe('$9.99');
    expect(formatMoney(1799, 'EUR')).toBe('€17.99');
    expect(formatMoney(119900, 'PKR')).toBe('Rs 1,199');
    expect(formatMoney(49900, 'INR')).toBe('₹499');
    expect(formatMoney(29950, 'BDT')).toBe('Tk 299.50');
    expect(formatMoney(-500, 'USD')).toBe('-$5.00');
  });

  it('refuses fractional minor units', () => {
    expect(() => formatMoney(9.99, 'USD')).toThrow();
  });
});
