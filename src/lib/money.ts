/**
 * Money is always an integer number of minor units (cents, paisa) plus a
 * currency code. Floats never touch an amount.
 */
export const CURRENCIES = ['USD', 'EUR', 'PKR', 'INR', 'BDT'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  amountMinor: number;
  currency: Currency;
  /** Display string, e.g. "$9.99" or "Rs 899". Clients show it as-is. */
  formatted: string;
}

interface Style {
  symbol: string;
  /** Put a space between symbol and number ("Rs 899"). */
  spaced: boolean;
  /** Drop ".00" for whole amounts, the local convention for these currencies. */
  hideWholeDecimals: boolean;
}

const STYLES: Record<Currency, Style> = {
  USD: { symbol: '$', spaced: false, hideWholeDecimals: false },
  EUR: { symbol: '€', spaced: false, hideWholeDecimals: false },
  PKR: { symbol: 'Rs', spaced: true, hideWholeDecimals: true },
  INR: { symbol: '₹', spaced: false, hideWholeDecimals: true },
  BDT: { symbol: 'Tk', spaced: true, hideWholeDecimals: true },
};

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

export function formatMoney(amountMinor: number, currency: Currency): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(`amount must be an integer number of minor units, got ${amountMinor}`);
  }
  const style = STYLES[currency];
  const whole = Math.trunc(Math.abs(amountMinor) / 100);
  const cents = Math.abs(amountMinor) % 100;
  const wholeText = whole.toLocaleString('en-US');
  const number =
    style.hideWholeDecimals && cents === 0
      ? wholeText
      : `${wholeText}.${String(cents).padStart(2, '0')}`;
  const sign = amountMinor < 0 ? '-' : '';
  return `${sign}${style.symbol}${style.spaced ? ' ' : ''}${number}`;
}

export function money(amountMinor: number, currency: Currency): Money {
  return { amountMinor, currency, formatted: formatMoney(amountMinor, currency) };
}
