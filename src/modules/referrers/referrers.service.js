const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { offsetOf, pageMeta } = require('../../utils/pagination');
const { toPaise, toDecimalString } = require('../../utils/money');

const escapeLike = (s) => s.replace(/[%_\\]/g, '\\$&');

// Totals are worked out from the saved bills, so they are right after every bill, edit and void.
// Voided bills do not count: a void takes its referral amount back off.
const WITH_STATS = `
  SELECT r.*,
         COUNT(i.id) FILTER (WHERE i.status = 'paid')::int AS bills,
         COALESCE(SUM(i.referral_discount) FILTER (WHERE i.status = 'paid'), 0) AS total_discount,
         MAX(i.created_at) FILTER (WHERE i.status = 'paid') AS last_used_at,
         COUNT(i.id)::int AS total_uses,
         -- What the referrer is owed (their credit on bills that stand and have not been marked as paid), what has been paid,
         -- and what was paid on a bill that was voided afterwards (nothing is changed for you: it is shown so it can be settled).
         COALESCE(SUM(i.referral_discount) FILTER (WHERE i.status = 'paid' AND i.referral_payout_id IS NULL), 0) AS owed,
         COALESCE(SUM(i.referral_discount) FILTER (WHERE i.status = 'paid' AND i.referral_payout_id IS NOT NULL), 0) AS paid_out,
         COALESCE(SUM(i.referral_discount) FILTER (WHERE i.status = 'void' AND i.referral_payout_id IS NOT NULL), 0) AS voided_after_paid
    FROM referrers r LEFT JOIN invoices i ON i.referrer_id = r.id`;

const map = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  contact: r.contact,
  percent: Number(r.percent),
  isActive: r.is_active,
  createdAt: r.created_at,
  ...(r.bills !== undefined && {
    bills: r.bills,
    totalDiscount: Number(r.total_discount),
    owed: Number(r.owed),
    paidOut: Number(r.paid_out),
    voidedAfterPaid: Number(r.voided_after_paid),
    lastUsedAt: r.last_used_at,
    canDelete: r.total_uses === 0, // a referrer that has ever been on a bill can only be deactivated
  }),
});

const contactTaken = () => AppError.conflict('A referrer with this phone number already exists', 'CONTACT_EXISTS');

exports.list = async (parlourId, q) => {
  const search = q.search ? `%${escapeLike(q.search)}%` : null;
  const where = `r.parlour_id = $1 AND ($2::text IS NULL OR r.name ILIKE $2 OR r.code ILIKE $2 OR r.contact ILIKE $2)`;
  const { rows } = await query(`${WITH_STATS} WHERE ${where} GROUP BY r.id ORDER BY r.created_at DESC, r.id LIMIT $3 OFFSET $4`, [parlourId, search, q.limit, offsetOf(q)]);
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM referrers r WHERE ${where}`, [parlourId, search]);
  return { items: rows.map(map), meta: pageMeta(q, count) };
};

/** What the billing counter needs: active referrers matching a name or ID. No phone numbers, no earnings. */
exports.lookup = async (parlourId, q) => {
  const { rows } = await query(
    `SELECT id, code, name, percent FROM referrers
      WHERE parlour_id = $1 AND is_active AND (name ILIKE $2 OR code ILIKE $2)
      ORDER BY (lower(code) = lower($3)) DESC, lower(name) LIMIT 8`,
    [parlourId, `%${escapeLike(q)}%`, q]
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, percent: Number(r.percent) }));
};

exports.get = async (parlourId, id) => {
  const { rows } = await query(`${WITH_STATS} WHERE r.id = $1 AND r.parlour_id = $2 GROUP BY r.id`, [id, parlourId]);
  if (!rows[0]) throw AppError.notFound('Referrer not found');
  const { rows: history } = await query(
    `SELECT i.id, i.number, i.customer_name, i.referral_percent, i.referral_discount, i.total, i.status, i.created_at, i.referral_payout_id
       FROM invoices i WHERE i.referrer_id = $1 AND i.parlour_id = $2 ORDER BY i.created_at DESC LIMIT 100`,
    [id, parlourId]
  );
  const { rows: payouts } = await query(
    `SELECT po.id, po.amount, po.bill_count, po.paid_at, u.name AS paid_by_name
       FROM referral_payouts po LEFT JOIN users u ON u.id = po.paid_by
      WHERE po.referrer_id = $1 AND po.parlour_id = $2 ORDER BY po.paid_at DESC, po.id LIMIT 20`,
    [id, parlourId]
  );
  return {
    ...map(rows[0]),
    history: history.map((h) => ({
      id: h.id, number: h.number, customerName: h.customer_name, percent: Number(h.referral_percent),
      discount: Number(h.referral_discount), total: Number(h.total), status: h.status, createdAt: h.created_at,
      paid: h.referral_payout_id != null,
    })),
    payouts: payouts.map((p) => ({ id: p.id, amount: Number(p.amount), bills: p.bill_count, paidAt: p.paid_at, paidByName: p.paid_by_name })),
  };
};

/** Creates the referrer and their ID (REF-0001, REF-0002 …, counted per parlour). */
exports.create = async (parlourId, { name, contact, percent }) => {
  try {
    const id = await withTransaction(async (db) => {
      const { rows: [p] } = await db.query(`UPDATE parlours SET referral_seq = referral_seq + 1 WHERE id = $1 RETURNING referral_seq`, [parlourId]);
      const code = `REF-${String(p.referral_seq).padStart(4, '0')}`;
      const { rows: [r] } = await db.query(
        `INSERT INTO referrers (parlour_id, code, name, contact, percent) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [parlourId, code, name, contact, percent.toFixed(2)]
      ); // a duplicate phone number rolls the whole thing back, so the ID is not used up
      return r.id;
    });
    return await exports.get(parlourId, id);
  } catch (err) {
    if (err.code === '23505') throw contactTaken();
    throw err;
  }
};

/** A new percentage applies to future bills only; past bills keep the percentage they were made with. */
exports.update = async (parlourId, id, p) => {
  try {
    const { rowCount } = await query(
      `UPDATE referrers SET name = COALESCE($3, name), contact = COALESCE($4, contact),
              percent = COALESCE($5, percent), is_active = COALESCE($6, is_active)
        WHERE id = $1 AND parlour_id = $2`,
      [id, parlourId, p.name ?? null, p.contact ?? null, p.percent == null ? null : p.percent.toFixed(2), p.isActive ?? null]
    );
    if (!rowCount) throw AppError.notFound('Referrer not found');
    return await exports.get(parlourId, id);
  } catch (err) {
    if (err.code === '23505') throw contactTaken();
    throw err;
  }
};

exports.remove = async (parlourId, id) => {
  return withTransaction(async (db) => {
    const { rows: [r] } = await db.query(`SELECT id FROM referrers WHERE id = $1 AND parlour_id = $2 FOR UPDATE`, [id, parlourId]);
    if (!r) throw AppError.notFound('Referrer not found');
    const { rows: [{ uses }] } = await db.query(`SELECT COUNT(*)::int AS uses FROM invoices WHERE referrer_id = $1`, [id]);
    if (uses > 0) throw AppError.conflict('This referrer is on past bills, so it cannot be deleted. Deactivate it instead.', 'REFERRER_IN_USE');
    await db.query(`DELETE FROM referrers WHERE id = $1`, [id]);
  });
};

/**
 * Records that the referrer has been paid what they are owed: every bill that stands (not void) and has not been paid out
 * already, up to now, in one payout. Safe to press twice: the second one finds nothing left. In one transaction:
 *   1. the referrer's row is locked, so two payouts for the same person run one after the other
 *   2. the bills it would pay are locked, so a bill cannot be voided half-way through
 *   3. if what is owed is no longer exactly what the admin saw on screen, NOTHING is paid and they are told the new amount
 */
exports.pay = async (auth, id, { expectedAmount }) => {
  return withTransaction(async (db) => {
    const { rows: [r] } = await db.query(`SELECT id, code, name FROM referrers WHERE id = $1 AND parlour_id = $2 FOR UPDATE`, [id, auth.parlourId]);
    if (!r) throw AppError.notFound('Referrer not found');

    const { rows: owed } = await db.query(
      `SELECT id, referral_discount FROM invoices
        WHERE parlour_id = $1 AND referrer_id = $2 AND status = 'paid' AND referral_payout_id IS NULL AND referral_discount > 0
        ORDER BY id FOR UPDATE`,
      [auth.parlourId, id]
    );
    const total = owed.reduce((sum, b) => sum + toPaise(b.referral_discount), 0);
    const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;
    if (!owed.length || total === 0) throw AppError.conflict(`${r.name} is not owed anything right now.`, 'NOTHING_TO_PAY');
    if (total !== toPaise(expectedAmount)) {
      throw AppError.conflict(`What ${r.name} is owed has changed: it is now ${rupees(total)}, not ${rupees(toPaise(expectedAmount))}. Nothing was paid. Check the page and try again.`, 'AMOUNT_CHANGED');
    }

    const { rows: [payout] } = await db.query(
      `INSERT INTO referral_payouts (parlour_id, referrer_id, referrer_name, referrer_code, amount, bill_count, paid_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, paid_at`,
      [auth.parlourId, id, r.name, r.code, toDecimalString(total), owed.length, auth.userId]
    );
    const { rowCount } = await db.query(
      `UPDATE invoices SET referral_payout_id = $1 WHERE id = ANY($2::uuid[]) AND referral_payout_id IS NULL`,
      [payout.id, owed.map((b) => b.id)]
    );
    if (rowCount !== owed.length) throw new Error('Referral payout did not cover every bill it counted'); // rolls everything back
    return { id: payout.id, referrerId: id, referrerName: r.name, amount: total / 100, bills: owed.length, paidAt: payout.paid_at };
  });
};
