const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { toPaise, toDecimalString } = require('../../utils/money');

const LOCAL_DATE = `(i.created_at AT TIME ZONE p.timezone)::date`;
const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;
const sumPaise = (rows, field) => rows.reduce((s, r) => s + toPaise(r[field]), 0);

/** Parlour-local days, default the last 30 days, at most a year: the same rules as the dashboard. */
async function resolveRange(parlourId, { from, to }) {
  const { rows: [parlour] } = await query(`SELECT timezone FROM parlours WHERE id = $1`, [parlourId]);
  if (!parlour) throw AppError.notFound('Parlour not found');
  const { rows: [r] } = await query(
    `SELECT to_char(COALESCE($2::date, (now() AT TIME ZONE $1)::date - 29), 'YYYY-MM-DD') AS from_date,
            to_char(COALESCE($3::date, (now() AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS to_date`,
    [parlour.timezone, from ?? null, to ?? null]
  );
  if (r.from_date > r.to_date) throw AppError.badRequest('Start date must be before end date', 'BAD_RANGE');
  const days = (new Date(r.to_date) - new Date(r.from_date)) / 86_400_000 + 1;
  if (days > 366) throw AppError.badRequest('Choose a range of one year or less', 'RANGE_TOO_LARGE');
  return { from: r.from_date, to: r.to_date };
}

// ───────────── what each person has earned ─────────────

/**
 * Per person, for bills in the range (parlour-local days):
 *   sales    their lines' share of the bills' taxable value
 *   earned   commission on bills that are not void
 *   paid     the part of that already marked as paid
 *   due      earned − paid: what "Mark as paid" would pay out now
 *   voidedAfterPaid   commission that was paid and then the bill was voided. Nothing is changed for you: it is shown so the admin can settle it.
 * People with no bills in the range are listed too if they are active.
 */
exports.report = async (parlourId, q) => {
  const range = await resolveRange(parlourId, q);
  const { rows } = await query(
    `WITH earned_lines AS (
       SELECT it.performed_by, it.net_amount, it.commission, it.commission_payout_id, i.status
         FROM invoice_items it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN parlours p ON p.id = i.parlour_id
        WHERE i.parlour_id = $1 AND it.performed_by IS NOT NULL AND ${LOCAL_DATE} BETWEEN $2::date AND $3::date
     )
     SELECT pf.id, pf.name, pf.is_active,
            COUNT(l.performed_by) FILTER (WHERE l.status = 'paid')::int AS lines,
            COALESCE(SUM(l.net_amount)  FILTER (WHERE l.status = 'paid'), 0) AS sales,
            COALESCE(SUM(l.commission)  FILTER (WHERE l.status = 'paid'), 0) AS earned,
            COALESCE(SUM(l.commission)  FILTER (WHERE l.status = 'paid' AND l.commission_payout_id IS NOT NULL), 0) AS paid,
            COALESCE(SUM(l.commission)  FILTER (WHERE l.status = 'void' AND l.commission_payout_id IS NOT NULL), 0) AS voided_after_paid
       FROM performers pf
       LEFT JOIN earned_lines l ON l.performed_by = pf.id
      WHERE pf.parlour_id = $1 AND (pf.is_active OR l.performed_by IS NOT NULL)
      GROUP BY pf.id, pf.name, pf.is_active
      ORDER BY earned DESC, lower(pf.name)`,
    [parlourId, range.from, range.to]
  );
  const people = rows.map((r) => {
    const earned = toPaise(r.earned);
    const paid = toPaise(r.paid);
    return {
      id: r.id, name: r.name, isActive: r.is_active, lines: r.lines,
      sales: toPaise(r.sales) / 100, earned: earned / 100, paid: paid / 100, due: (earned - paid) / 100,
      voidedAfterPaid: toPaise(r.voided_after_paid) / 100,
    };
  });
  const total = (field) => people.reduce((s, p) => s + toPaise(p[field]), 0) / 100;
  return {
    range,
    people,
    totals: { sales: total('sales'), earned: total('earned'), paid: total('paid'), due: total('due'), voidedAfterPaid: total('voidedAfterPaid') },
  };
};

const LINE_LIMIT = 500;

/** The bill lines behind one person's numbers, newest first, so an admin can check them before paying. */
exports.lines = async (parlourId, performerId, q) => {
  const { rows: [pf] } = await query(`SELECT id, name FROM performers WHERE id = $1 AND parlour_id = $2`, [performerId, parlourId]);
  if (!pf) throw AppError.notFound('Person not found');
  const range = await resolveRange(parlourId, q);
  const { rows } = await query(
    `SELECT it.id, i.id AS invoice_id, i.number, i.status, i.created_at, it.name, it.quantity, it.net_amount,
            it.commission_kind, it.commission_rate, it.commission, it.commission_payout_id
       FROM invoice_items it
       JOIN invoices i ON i.id = it.invoice_id
       JOIN parlours p ON p.id = i.parlour_id
      WHERE i.parlour_id = $1 AND it.performed_by = $2 AND ${LOCAL_DATE} BETWEEN $3::date AND $4::date
      ORDER BY i.created_at DESC, it.id
      LIMIT ${LINE_LIMIT + 1}`,
    [parlourId, performerId, range.from, range.to]
  );
  return {
    range,
    person: { id: pf.id, name: pf.name },
    truncated: rows.length > LINE_LIMIT,
    lines: rows.slice(0, LINE_LIMIT).map((r) => ({
      id: r.id, invoiceId: r.invoice_id, number: r.number, status: r.status, createdAt: r.created_at,
      name: r.name, quantity: r.quantity, base: r.net_amount == null ? null : Number(r.net_amount),
      kind: r.commission_kind, rate: r.commission_rate == null ? null : Number(r.commission_rate),
      commission: Number(r.commission), paid: r.commission_payout_id != null,
    })),
  };
};

// ───────────── marking it as paid ─────────────

/**
 * Pays out what one person is owed for the bills in a range, in one payout. Safe to press twice: the second one finds
 * nothing left. Everything happens in one transaction:
 *   1. the person's row is locked, so two payouts for the same person run one after the other
 *   2. the lines it would pay are locked, together with their bills, so a bill cannot be voided half-way through
 *   3. if what is owed is no longer exactly what the admin saw on screen, NOTHING is paid and they are told the new amount
 * Only bills that are not void, and only commission not already paid, are included.
 */
exports.pay = async (auth, { performerId, from, to, expectedAmount }) => {
  return withTransaction(async (db) => {
    const { rows: [pf] } = await db.query(`SELECT id, name FROM performers WHERE id = $1 AND parlour_id = $2 FOR UPDATE`, [performerId, auth.parlourId]);
    if (!pf) throw AppError.notFound('Person not found');

    const { rows: owed } = await db.query(
      `SELECT it.id, it.commission
         FROM invoice_items it
         JOIN invoices i ON i.id = it.invoice_id
         JOIN parlours p ON p.id = i.parlour_id
        WHERE i.parlour_id = $1 AND it.performed_by = $2 AND i.status = 'paid'
          AND it.commission_payout_id IS NULL AND it.commission > 0
          AND ${LOCAL_DATE} BETWEEN $3::date AND $4::date
        ORDER BY i.id, it.id
          FOR UPDATE OF it, i`,
      [auth.parlourId, performerId, from, to]
    );
    const total = sumPaise(owed, 'commission');
    if (!owed.length || total === 0) throw AppError.conflict(`There is no unpaid commission for ${pf.name} in these dates.`, 'NOTHING_TO_PAY');
    if (total !== toPaise(expectedAmount)) {
      throw AppError.conflict(`What ${pf.name} is owed has changed: it is now ${rupees(total)}, not ${rupees(toPaise(expectedAmount))}. Nothing was paid. Check the page and try again.`, 'AMOUNT_CHANGED');
    }

    const { rows: [payout] } = await db.query(
      `INSERT INTO commission_payouts (parlour_id, performer_id, performer_name, from_date, to_date, amount, line_count, paid_by)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8) RETURNING id, paid_at`,
      [auth.parlourId, performerId, pf.name, from, to, toDecimalString(total), owed.length, auth.userId]
    );
    const { rowCount } = await db.query(
      `UPDATE invoice_items SET commission_payout_id = $1 WHERE id = ANY($2::uuid[]) AND commission_payout_id IS NULL`,
      [payout.id, owed.map((r) => r.id)]
    );
    if (rowCount !== owed.length) throw new Error('Commission payout did not cover every line it counted'); // rolls everything back
    return { id: payout.id, performerId, performerName: pf.name, from, to, amount: total / 100, lines: owed.length, paidAt: payout.paid_at };
  });
};

/** Every payout made, newest first. */
exports.payouts = async (parlourId, { limit }) => {
  const { rows } = await query(
    `SELECT po.id, po.performer_id, po.performer_name, to_char(po.from_date, 'YYYY-MM-DD') AS from_date, to_char(po.to_date, 'YYYY-MM-DD') AS to_date,
            po.amount, po.line_count, po.paid_at, u.name AS paid_by_name
       FROM commission_payouts po LEFT JOIN users u ON u.id = po.paid_by
      WHERE po.parlour_id = $1 ORDER BY po.paid_at DESC, po.id LIMIT $2`,
    [parlourId, limit]
  );
  return rows.map((r) => ({
    id: r.id, performerId: r.performer_id, performerName: r.performer_name, from: r.from_date, to: r.to_date,
    amount: Number(r.amount), lines: r.line_count, paidAt: r.paid_at, paidByName: r.paid_by_name,
  }));
};

// ───────────── the rules ─────────────

const mapRule = (r) => ({
  id: r.id, kind: r.kind, value: Number(r.value),
  performerId: r.performer_id, performerName: r.performer_name ?? null,
  serviceId: r.service_id, serviceName: r.service_name ?? null,
});

const RULE_SELECT = `SELECT r.id, r.kind, r.value, r.performer_id, pf.name AS performer_name, r.service_id, s.name AS service_name
                       FROM commission_rules r
                       LEFT JOIN performers pf ON pf.id = r.performer_id
                       LEFT JOIN services s ON s.id = r.service_id`;

exports.rules = async (parlourId) => {
  const { rows } = await query(`${RULE_SELECT} WHERE r.parlour_id = $1 ORDER BY (r.performer_id IS NULL), lower(COALESCE(pf.name, s.name))`, [parlourId]);
  return rows.map(mapRule);
};

/** Sets the rule for one person or one service: adds it, or replaces the one it already has. Applies to FUTURE bills only. */
exports.putRule = async (parlourId, { performerId, serviceId, kind, value }) => {
  // The person or service must belong to THIS parlour: a rule can never point at someone else's.
  const { rows: [target] } = performerId
    ? await query(`SELECT id FROM performers WHERE id = $1 AND parlour_id = $2`, [performerId, parlourId])
    : await query(`SELECT id FROM services WHERE id = $1 AND parlour_id = $2`, [serviceId, parlourId]);
  if (!target) throw AppError.notFound(performerId ? 'Person not found' : 'Service not found');

  const conflict = performerId ? `(parlour_id, performer_id) WHERE performer_id IS NOT NULL` : `(parlour_id, service_id) WHERE service_id IS NOT NULL`;
  const { rows: [saved] } = await query(
    `INSERT INTO commission_rules (parlour_id, performer_id, service_id, kind, value) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ${conflict} DO UPDATE SET kind = EXCLUDED.kind, value = EXCLUDED.value, updated_at = now()
     RETURNING id`,
    [parlourId, performerId ?? null, serviceId ?? null, kind, value.toFixed(2)]
  );
  const { rows: [row] } = await query(`${RULE_SELECT} WHERE r.id = $1 AND r.parlour_id = $2`, [saved.id, parlourId]);
  return mapRule(row);
};

exports.removeRule = async (parlourId, id) => {
  const { rowCount } = await query(`DELETE FROM commission_rules WHERE id = $1 AND parlour_id = $2`, [id, parlourId]);
  if (!rowCount) throw AppError.notFound('Rule not found');
};
