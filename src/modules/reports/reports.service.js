const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { toPaise } = require('../../utils/money');

const LOCAL_DATE = `(i.created_at AT TIME ZONE p.timezone)::date`;
const todayLocal = (tzParam) => `(now() AT TIME ZONE ${tzParam})::date`;

// The paid bills of one parlour in a date range. $1 parlour, $2 first day, $3 last day (parlour-local days). Void bills are out.
const BASE = `FROM invoices i JOIN parlours p ON p.id = i.parlour_id
                WHERE i.parlour_id = $1 AND i.status = 'paid' AND ${LOCAL_DATE} BETWEEN $2::date AND $3::date`;

/**
 * Takings by payment method, read from invoice_payments. A bill made before payments existed has no rows there: it was
 * paid in full by the single method on the bill itself, so it is counted under that method for its whole total.
 * A bill is in exactly one of the two halves (it has payment rows, or it does not), so nothing is counted twice and
 * nothing is missed: the methods add up to the revenue. `invoices` is how many bills used that method.
 */
const byPaymentSql = (base) => `
  WITH bills AS (SELECT i.id, i.payment_method, i.total ${base}),
       parts AS (
         SELECT ip.method, ip.amount FROM invoice_payments ip JOIN bills b ON b.id = ip.invoice_id
         UNION ALL
         SELECT b.payment_method, b.total FROM bills b WHERE NOT EXISTS (SELECT 1 FROM invoice_payments x WHERE x.invoice_id = b.id)
       )
  SELECT method, COUNT(*)::int AS invoices, SUM(amount) AS revenue FROM parts GROUP BY method ORDER BY revenue DESC, method`;

/**
 * Admin analytics for a date range (parlour-local days, default: last 30 days). Void bills are excluded.
 * `options.performers` says whether the Performers page is on for this parlour: only then is sales-by-performer worked out
 * (otherwise byPerformer is null, which the dashboard reads as "do not show it").
 */
exports.summary = async (parlourId, { from, to }, options = {}) => {
  const { rows: [parlour] } = await query(`SELECT timezone FROM parlours WHERE id = $1`, [parlourId]);
  if (!parlour) throw AppError.notFound('Parlour not found');

  const { rows: [range] } = await query(
    `SELECT to_char(COALESCE($2::date, (now() AT TIME ZONE $1)::date - 29), 'YYYY-MM-DD') AS from_date,
            to_char(COALESCE($3::date, (now() AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS to_date`,
    [parlour.timezone, from ?? null, to ?? null]
  );
  const fromDate = range.from_date;
  const toDate = range.to_date;
  if (fromDate > toDate) throw AppError.badRequest('Start date must be before end date', 'BAD_RANGE');
  const days = (new Date(toDate) - new Date(fromDate)) / 86_400_000 + 1;
  if (days > 366) throw AppError.badRequest('Choose a range of one year or less', 'RANGE_TOO_LARGE');

  const base = BASE;
  const args = [parlourId, fromDate, toDate];

  const [totals, byPayment, daily, topServices, byStaff, byPerformer] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS invoices, COALESCE(SUM(i.total),0) AS revenue, COALESCE(SUM(i.discount + i.referral_discount),0) AS discounts, COALESCE(SUM(i.referral_discount),0) AS referral_discounts, COALESCE(SUM(i.tax),0) AS tax, COALESCE(SUM(i.tip),0) AS tips, COALESCE(SUM(i.total - i.tax),0) AS taxable ${base}`,
      args
    ),
    query(byPaymentSql(base), args),
    query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(x.revenue, 0) AS revenue, COALESCE(x.invoices, 0) AS invoices
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN (SELECT ${LOCAL_DATE} AS day, SUM(i.total) AS revenue, COUNT(*)::int AS invoices ${base} GROUP BY 1) x ON x.day = d::date
        ORDER BY d`,
      args
    ),
    query(
      `SELECT it.name, SUM(it.quantity)::int AS quantity, SUM(it.line_total) AS revenue
         FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id JOIN parlours p ON p.id = i.parlour_id
        WHERE i.parlour_id = $1 AND i.status = 'paid' AND ${LOCAL_DATE} BETWEEN $2::date AND $3::date
        GROUP BY it.name ORDER BY revenue DESC LIMIT 6`,
      args
    ),
    query(
      `SELECT COALESCE(u.name, 'Removed user') AS name, COUNT(*)::int AS invoices, SUM(i.total) AS revenue
         FROM invoices i JOIN parlours p ON p.id = i.parlour_id LEFT JOIN users u ON u.id = i.created_by
        WHERE i.parlour_id = $1 AND i.status = 'paid' AND ${LOCAL_DATE} BETWEEN $2::date AND $3::date
        GROUP BY u.id, u.name ORDER BY revenue DESC`,
      args
    ),
    // Sales by the person who PERFORMED the work (not the one who made the bill): each line's share of what the bill really
    // took in, after discounts and before GST. A line nobody was chosen for, and every bill from before this existed, is not here.
    options.performers
      ? query(
          `SELECT it.performed_by AS id, pf.name, COUNT(*)::int AS lines, SUM(it.quantity)::int AS quantity, SUM(it.net_amount) AS sales
             FROM invoice_items it
             JOIN invoices i ON i.id = it.invoice_id
             JOIN parlours p ON p.id = i.parlour_id
             JOIN performers pf ON pf.id = it.performed_by
            WHERE i.parlour_id = $1 AND pf.parlour_id = $1 AND i.status = 'paid' AND ${LOCAL_DATE} BETWEEN $2::date AND $3::date
            GROUP BY it.performed_by, pf.name ORDER BY sales DESC, lower(pf.name)`,
          args
        )
      : Promise.resolve(null),
  ]);

  const t = totals.rows[0];
  const revenue = Number(t.revenue);
  return {
    range: { from: fromDate, to: toDate },
    totals: {
      invoices: t.invoices,
      revenue,
      discounts: Number(t.discounts),
      referralDiscounts: Number(t.referral_discounts),
      tax: Number(t.tax),
      // Tips are extra money for the staff: they are not in revenue or in the methods below.
      tips: Number(t.tips),
      averageBill: t.invoices ? Math.round((revenue / t.invoices) * 100) / 100 : 0,
    },
    byPayment: byPayment.rows.map((r) => ({ method: r.method, invoices: r.invoices, revenue: Number(r.revenue) })),
    daily: daily.rows.map((r) => ({
      day: r.day,
      revenue: Number(r.revenue),
      invoices: r.invoices,
    })),
    topServices: topServices.rows.map((r) => ({ name: r.name, quantity: r.quantity, revenue: Number(r.revenue) })),
    byStaff: byStaff.rows.map((r) => ({ name: r.name, invoices: r.invoices, revenue: Number(r.revenue) })),
    byPerformer: byPerformer ? performerSales(byPerformer.rows, t.taxable) : null,
  };
};

/**
 * Sales by performer. `unassigned` is whatever the range's bills took in (before GST) that is not credited to anyone, so
 * the people and "unassigned" add up to the whole taxable value, to the paisa. Worked out in whole paise.
 */
function performerSales(rows, taxableOfAllBills) {
  const people = rows.map((r) => ({ id: r.id, name: r.name, lines: r.lines, quantity: r.quantity, sales: Number(r.sales) }));
  const assigned = rows.reduce((sum, r) => sum + toPaise(r.sales), 0);
  return { people, unassigned: (toPaise(taxableOfAllBills) - assigned) / 100 };
}

exports.BASE = BASE;
exports.byPaymentSql = byPaymentSql;

/** Today's numbers for the signed-in person only (what a staff member sees on their home screen). */
exports.myDay = async (auth) => {
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS invoices, COALESCE(SUM(i.total), 0) AS revenue
       FROM invoices i JOIN parlours p ON p.id = i.parlour_id
      WHERE i.parlour_id = $1 AND i.created_by = $2 AND i.status = 'paid' AND ${LOCAL_DATE} = ${todayLocal('p.timezone')}`,
    [auth.parlourId, auth.userId]
  );
  return { invoices: r.invoices, revenue: Number(r.revenue) };
};
