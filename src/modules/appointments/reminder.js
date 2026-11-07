const whatsapp = require('../invoices/whatsapp');

/**
 * The reminder as a WhatsApp message (WhatsApp turns *text* into bold). It is written here, on the server, so every
 * reminder reads the same. A person taps the link, WhatsApp opens with the message and the number filled in, and
 * presses Send. Nothing is sent automatically: that needs the paid WhatsApp Business API.
 */
function buildMessage({ customerName, startsAt, services, performerName, parlour }) {
  const when = new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: parlour.timezone,
  }).format(new Date(startsAt));

  const first = String(customerName ?? '').trim().split(/\s+/)[0];
  const greeting = first && first.toLowerCase() !== 'walk-in' ? `Hello ${first},` : 'Hello,';
  const what = services.map((s) => (s.quantity > 1 ? `${s.name} × ${s.quantity}` : s.name)).join(', ');

  const lines = [`${greeting} this is a reminder of your appointment at *${parlour.name}*.`, '', `When: ${when}`];
  if (what) lines.push(`Services: ${what}`);
  if (performerName) lines.push(`With: ${performerName}`);
  lines.push('');
  if (parlour.phone) lines.push(`Need to change the time? Call ${parlour.phone}.`);
  lines.push('See you soon!');
  return lines.join('\n');
}

/** { phone, message, url }. `phone` is whatever was typed or saved; the same number rules as the bill's WhatsApp link apply. */
function build({ phone, ...appointment }) {
  const number = whatsapp.normalizeNumber(phone);
  const message = buildMessage(appointment);
  return { phone: number, message, url: `https://wa.me/${number}?text=${encodeURIComponent(message)}` };
}

module.exports = { build, buildMessage };
