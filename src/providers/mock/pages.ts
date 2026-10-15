import { escapeHtml, page } from '../../lib/html.js';
import { type Currency, formatMoney } from '../../lib/money.js';

export function checkoutPage(session: {
  id: string;
  description: string;
  customer: string;
  amountMinor: number;
  currency: Currency;
  status: 'open' | 'succeeded' | 'failed' | 'canceled';
  /** A subscription checkout: offer the ways of paying that renew differently. */
  savePaymentMethod: boolean;
}): string {
  const amount = escapeHtml(formatMoney(session.amountMinor, session.currency));
  const action = (name: string) => `/mock-provider/checkout/${encodeURIComponent(session.id)}/${name}`;
  const button = (name: string, label: string, hint = '', style = '') =>
    `<form method="post" action="${action(name)}"><button class="${style}" type="submit">${label}${
      hint ? `<span class="hint">${hint}</span>` : ''
    }</button></form>`;

  const payButtons = session.savePaymentMethod
    ? button('pay', `Pay ${amount} with Visa •••• 4242`, 'Renews automatically', 'primary') +
      button('pay-failing-card', 'Pay with Mastercard •••• 0341', 'Works today, declines at renewal (tests retries)') +
      button('pay-wallet', 'Pay with mobile wallet', 'Like JazzCash or Easypaisa: you renew by hand')
    : button('pay', `Pay ${amount}`, '', 'primary');

  const controls =
    session.status === 'open'
      ? `<div class="section">Pay with</div>
         ${payButtons}
         <div class="section">Test outcomes</div>
         ${button('decline', 'Simulate a declined card', '', 'danger')}
         ${button('cancel', 'Cancel and go back', '', 'plain')}`
      : `<p class="muted">This checkout is already ${escapeHtml(session.status)}.</p>`;

  return page(
    'Nova Cinema checkout',
    `<div class="brand">NOVA CINEMA</div>
    <div class="card">
      <span class="badge">Test mode</span>
      <h1>${escapeHtml(session.description)}</h1>
      <div class="muted">Billed to ${escapeHtml(session.customer)}</div>
      <div class="amount">${amount}</div>
      ${controls}
    </div>
    <p class="note">This page plays the part of a payment provider's hosted checkout
    (Stripe, JazzCash). No real money moves. In production the customer enters
    card or wallet details on the provider's page, never inside the app.</p>`,
  );
}

/** Where the provider sends the customer back; the app closes its checkout view on it. */
export function returnPage(canceled: boolean): string {
  return page(
    'Back to Nova Cinema',
    `<div class="brand">NOVA CINEMA</div>
    <div class="card center">
      <h1>${canceled ? 'Checkout canceled' : 'Thanks! Finishing up…'}</h1>
      <p class="muted">You can close this page and return to the Nova Cinema app.</p>
    </div>`,
  );
}
