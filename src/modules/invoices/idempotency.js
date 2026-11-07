// Idempotency for POST /invoices. The client sends an Idempotency-Key header made once per bill attempt.
// If the same request arrives again (a double tap, or a retry after the connection dropped before the answer
// came back) we return the bill the first request created instead of making a second one.
//
// The key is stored on the invoice itself, in the same transaction that creates it, so "bill exists" and
// "key is used" can never disagree. A partial unique index on (parlour_id, created_by, idempotency_key)
// (db/schema.sql) is what makes two simultaneous copies safe: only one insert can win.

const crypto = require('node:crypto');
const AppError = require('../../utils/AppError');
const { toPaise } = require('../../utils/money');

// The name of that unique index in db/schema.sql. PostgreSQL reports it as `constraint` on the error.
const KEY_INDEX = 'invoices_idempotency_key';

/**
 * A short fingerprint of what the request asks for, so we can tell "the same request again" from
 * "a different bill that reused the key". It is built from the VALIDATED body, with lines merged and
 * sorted the way create() merges them, so the order of lines (and of split payments) does not matter. Prices are not part of it:
 * they come from the menu, and a retry must get the original bill even if the menu changed meanwhile.
 */
function fingerprintOf({ customerId, walkInName, items, referrerId, discount, paymentMethod, payments, tip, notes, appointmentId }) {
  const lines = new Map();
  for (const it of items) {
    // The person who performed a line is part of what the line is, but only when one was named: a request that names
    // nobody has exactly the fingerprint it always had.
    const id = (it.comboId ? `combo:${it.comboId}` : `service:${it.serviceId}`) + (it.performedBy ? `|by:${it.performedBy}` : '');
    lines.set(id, (lines.get(id) || 0) + it.quantity);
  }
  const canonical = {
    customerId: customerId || null,
    walkInName: (walkInName || '').trim(),
    lines: [...lines.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    referrerId: referrerId || null,
    discountPaise: toPaise(discount ?? 0),
    paymentMethod,
    notes: (notes || '').trim(),
    // Added only when used, so the fingerprint of a request in the old shape (one paymentMethod, no tip) is exactly what
    // it always was: a retry of a bill made just before an upgrade still finds its bill instead of being refused.
    // Payments are sorted by method, so the order they were listed in does not matter.
    ...(payments?.length ? { payments: payments.map((p) => [p.method, toPaise(p.amount)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) } : {}),
    ...(toPaise(tip ?? 0) > 0 ? { tipPaise: toPaise(tip) } : {}),
    // Likewise only when a visit is being billed, so a bill with no visit keeps the fingerprint it always had.
    ...(appointmentId ? { appointmentId } : {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The id of the bill this person already made with this key, or null if the key is new.
 * Keys belong to one person in one parlour (staff only ever see their own bills), so a key can never
 * lead to somebody else's bill. Throws 409 if the key was used for a different request.
 * `db` is anything with query(text, params).
 */
async function findReplay(db, auth, key, fingerprint) {
  const { rows: [existing] } = await db.query(
    `SELECT id, idempotency_fingerprint FROM invoices
      WHERE parlour_id = $1 AND created_by = $2 AND idempotency_key = $3`,
    [auth.parlourId, auth.userId, key]
  );
  if (!existing) return null;
  if (existing.idempotency_fingerprint !== fingerprint) {
    throw AppError.conflict(
      'This request ID was already used for a different bill. Refresh the screen and try again.',
      'IDEMPOTENCY_KEY_REUSED'
    );
  }
  return existing.id;
}

/** True when an insert failed because another copy of the same request got there first. */
const isKeyConflict = (err) => err?.code === '23505' && err?.constraint === KEY_INDEX;

module.exports = { fingerprintOf, findReplay, isKeyConflict, KEY_INDEX };
