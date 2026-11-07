const env = require('../../config/env');
const AppError = require('../../utils/AppError');
const { halfRate } = require('./gst');
const { LABELS } = require('./payments');

/** Turns whatever was typed into the digits WhatsApp wants: country code first, no + or spaces. */
function normalizeNumber(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) throw AppError.badRequest('Enter the customer’s WhatsApp number', 'PHONE_REQUIRED', { phone: 'Enter the customer’s WhatsApp number' });
  if (digits.length === 10) return env.whatsappCountryCode + digits;                          // 9840012345
  if (digits.length === 11 && digits.startsWith('0')) return env.whatsappCountryCode + digits.slice(1); // 09840012345
  if (digits.length < 11 || digits.length > 15) {
    throw AppError.badRequest('That does not look like a valid phone number', 'INVALID_PHONE', { phone: 'Enter a 10-digit number, or include the country code' });
  }
  return digits; // already has a country code
}

const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN', Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * How it was paid. One method reads exactly as it always has ("Paid by UPI"); a split bill lists each part
 * ("Paid by cash ₹300 + UPI ₹500"). A bill carrying no payment list falls back to its single method.
 */
function paidLine(inv) {
  const parts = inv.payments ?? [];
  if (parts.length > 1) return `Paid by ${parts.map((p) => `${LABELS[p.method] ?? p.method} ${rupees(p.amount)}`).join(' + ')}`;
  const method = parts[0]?.method ?? inv.paymentMethod;
  return `Paid by ${LABELS[method] ?? method}`;
}

/**
 * The bill as a WhatsApp message (WhatsApp turns *text* into bold).
 *
 * A bill made with the GST split shows the taxable value, CGST and SGST (and the SAC of each service). When the menu
 * prices already contain GST the split is shown under the total, as the part of it that is GST. A bill made before the
 * split existed has no CGST/SGST saved, so it keeps its single "GST 5%" line.
 */
function buildMessage(inv) {
  const when = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: inv.parlour.timezone,
  }).format(new Date(inv.createdAt));

  const hasSplit = inv.cgst != null && inv.sgst != null;
  const inclusive = hasSplit && inv.priceMode === 'inclusive';
  const rate = halfRate(inv.taxPercent);
  const splitLines = () => [`Taxable value: ${rupees(inv.taxable)}`, `CGST ${rate}%: ${rupees(inv.cgst)}`, `SGST ${rate}%: ${rupees(inv.sgst)}`];

  const lines = [`*${inv.parlour.name}*`];
  if (inv.gstin) lines.push(`GSTIN: ${inv.gstin}`);
  lines.push(`Bill ${inv.number} · ${when}`);
  if (inv.customerName && inv.customerName !== 'Walk-in') lines.push(`Customer: ${inv.customerName}`); // no name given: nothing to say
  lines.push('', 'Items');
  for (const it of inv.items) {
    lines.push(`• ${it.name}${it.quantity > 1 ? ` × ${it.quantity}` : ''}: ${rupees(it.lineTotal)}`);
    if (it.description) lines.push(`   (${it.description})`);
    if (it.sacCode) lines.push(`   SAC ${it.sacCode}`);
  }
  lines.push('', `Subtotal${inclusive && inv.tax > 0 ? ' (incl. GST)' : ''}: ${rupees(inv.subtotal)}`);
  if (inv.referralDiscount > 0) lines.push(`Referral discount (${inv.referrer?.name ?? 'referral'}, ${inv.referralPercent}%): − ${rupees(inv.referralDiscount)}`);
  if (inv.discount > 0) lines.push(`Discount: − ${rupees(inv.discount)}`);
  if (inv.tax > 0 && !hasSplit) lines.push(`GST ${inv.taxPercent}%: ${rupees(inv.tax)}`);
  if (inv.tax > 0 && hasSplit && !inclusive) lines.push(...splitLines());
  lines.push(`*Total: ${rupees(inv.total)}*`);
  if (inv.tax > 0 && inclusive) lines.push(`Total includes GST of ${rupees(inv.tax)}:`, ...splitLines());
  lines.push(paidLine(inv));
  // A tip is extra: it is not in the total above and is never taxed.
  if (inv.tip > 0) lines.push(`Tip: ${rupees(inv.tip)} (not included in the total)`);
  lines.push('');
  if (inv.parlour.phone) lines.push(`Questions? Call ${inv.parlour.phone}`);
  lines.push('Thank you for visiting!');
  return lines.join('\n');
}

module.exports = { normalizeNumber, buildMessage };
