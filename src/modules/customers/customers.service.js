const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { offsetOf, pageMeta } = require('../../utils/pagination');

const map = (c) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  notes: c.notes,
  createdAt: c.created_at,
  ...(c.visits !== undefined && { visits: Number(c.visits), totalSpent: Number(c.total_spent), lastVisit: c.last_visit }),
});

const dupPhone = () => AppError.conflict('A customer with this phone number already exists', 'PHONE_EXISTS');

exports.list = async (parlourId, q) => {
  const search = q.search ? `%${q.search.replace(/[%_\\]/g, '\\$&')}%` : null;
  const where = `c.parlour_id = $1 AND ($2::text IS NULL OR c.name ILIKE $2 OR c.phone ILIKE $2)`;

  const { rows } = await query(
    `SELECT c.*,
            COUNT(i.id) FILTER (WHERE i.status = 'paid') AS visits,
            COALESCE(SUM(i.total) FILTER (WHERE i.status = 'paid'), 0) AS total_spent,
            MAX(i.created_at) FILTER (WHERE i.status = 'paid') AS last_visit
       FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id
      WHERE ${where}
      GROUP BY c.id ORDER BY lower(c.name) LIMIT $3 OFFSET $4`,
    [parlourId, search, q.limit, offsetOf(q)]
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM customers c WHERE ${where}`, [parlourId, search]);
  return { items: rows.map(map), meta: pageMeta(q, count) };
};

exports.get = async (parlourId, id) => {
  const { rows } = await query(
    `SELECT c.*,
            COUNT(i.id) FILTER (WHERE i.status = 'paid') AS visits,
            COALESCE(SUM(i.total) FILTER (WHERE i.status = 'paid'), 0) AS total_spent,
            MAX(i.created_at) FILTER (WHERE i.status = 'paid') AS last_visit
       FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id
      WHERE c.id = $1 AND c.parlour_id = $2 GROUP BY c.id`,
    [id, parlourId]
  );
  if (!rows[0]) throw AppError.notFound('Customer not found');
  const { rows: recent } = await query(
    `SELECT id, number, total, status, payment_method, created_at FROM invoices
      WHERE customer_id = $1 AND parlour_id = $2 ORDER BY created_at DESC LIMIT 10`,
    [id, parlourId]
  );
  return {
    ...map(rows[0]),
    recentInvoices: recent.map((r) => ({
      id: r.id, number: r.number, total: Number(r.total), status: r.status, paymentMethod: r.payment_method, createdAt: r.created_at,
    })),
  };
};

exports.create = async (parlourId, { name, phone, email = null, notes = null }) => {
  try {
    const { rows } = await query(
      `INSERT INTO customers (parlour_id, name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [parlourId, name, phone, email, notes]
    );
    return map(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw dupPhone();
    throw err;
  }
};

exports.update = async (parlourId, id, p) => {
  try {
    const { rows } = await query(
      `UPDATE customers SET
          name = COALESCE($3, name), phone = COALESCE($4, phone),
          email = CASE WHEN $5::boolean THEN $6 ELSE email END,
          notes = CASE WHEN $7::boolean THEN $8 ELSE notes END
        WHERE id = $1 AND parlour_id = $2 RETURNING *`,
      [id, parlourId, p.name ?? null, p.phone ?? null, 'email' in p, p.email ?? null, 'notes' in p, p.notes ?? null]
    );
    if (!rows[0]) throw AppError.notFound('Customer not found');
    return map(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw dupPhone();
    throw err;
  }
};
