const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { toPaise } = require('../../utils/money');

// A combo with its services, and what those services would cost separately.
const COMBO_ROWS = `
  SELECT c.id, c.name, c.price, c.is_active, c.created_at,
         COALESCE(json_agg(json_build_object('serviceId', s.id, 'name', s.name, 'quantity', ci.quantity, 'price', s.price, 'isActive', s.is_active)
                           ORDER BY lower(s.name)) FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS items
    FROM combos c
    LEFT JOIN combo_items ci ON ci.combo_id = c.id
    LEFT JOIN services s ON s.id = ci.service_id`;

const map = (c) => {
  const items = c.items.map((i) => ({ serviceId: i.serviceId, name: i.name, quantity: i.quantity, price: Number(i.price), isActive: i.isActive }));
  const regularPaise = items.reduce((sum, i) => sum + toPaise(i.price) * i.quantity, 0);
  const pricePaise = toPaise(c.price);
  return {
    id: c.id,
    name: c.name,
    price: Number(c.price),
    isActive: c.is_active,
    createdAt: c.created_at,
    items,
    regularPrice: regularPaise / 100,
    savings: (regularPaise - pricePaise) / 100,
    // Sellable only if it is on and every service inside it is still on the menu.
    available: c.is_active && items.length > 0 && items.every((i) => i.isActive),
  };
};

const exists = () => AppError.conflict('A combo with this name already exists', 'COMBO_EXISTS');

async function checkServices(db, parlourId, items) {
  const { rows } = await db.query(`SELECT id FROM services WHERE parlour_id = $1 AND is_active AND id = ANY($2::uuid[])`, [parlourId, items.map((i) => i.serviceId)]);
  if (rows.length !== items.length) {
    throw AppError.badRequest('One or more services are not available. Choose from your current menu.', 'SERVICE_UNAVAILABLE', { items: 'Choose services from your current menu' });
  }
}
async function writeItems(db, comboId, items) {
  await db.query(`DELETE FROM combo_items WHERE combo_id = $1`, [comboId]);
  for (const i of items) {
    await db.query(`INSERT INTO combo_items (combo_id, service_id, quantity) VALUES ($1, $2, $3)`, [comboId, i.serviceId, i.quantity]);
  }
}
async function getWith(db, parlourId, id) {
  const { rows } = await db.query(`${COMBO_ROWS} WHERE c.parlour_id = $1 AND c.id = $2 GROUP BY c.id`, [parlourId, id]);
  if (!rows[0]) throw AppError.notFound('Combo not found');
  return map(rows[0]);
}

exports.list = async (parlourId, { includeInactive }) => {
  const { rows } = await query(
    `${COMBO_ROWS} WHERE c.parlour_id = $1 ${includeInactive ? '' : 'AND c.is_active'} GROUP BY c.id ORDER BY lower(c.name)`,
    [parlourId]
  );
  return rows.map(map);
};

exports.create = async (parlourId, { name, price, items }) => {
  try {
    return await withTransaction(async (db) => {
      await checkServices(db, parlourId, items);
      const { rows: [c] } = await db.query(`INSERT INTO combos (parlour_id, name, price) VALUES ($1, $2, $3) RETURNING id`, [parlourId, name, price.toFixed(2)]);
      await writeItems(db, c.id, items);
      return getWith(db, parlourId, c.id);
    });
  } catch (err) {
    if (err.code === '23505') throw exists();
    throw err;
  }
};

exports.update = async (parlourId, id, p) => {
  try {
    return await withTransaction(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE combos SET name = COALESCE($3, name), price = COALESCE($4, price), is_active = COALESCE($5, is_active)
          WHERE id = $1 AND parlour_id = $2`,
        [id, parlourId, p.name ?? null, p.price == null ? null : p.price.toFixed(2), p.isActive ?? null]
      );
      if (!rowCount) throw AppError.notFound('Combo not found');
      if (p.items) { await checkServices(db, parlourId, p.items); await writeItems(db, id, p.items); }
      return getWith(db, parlourId, id);
    });
  } catch (err) {
    if (err.code === '23505') throw exists();
    throw err;
  }
};

/** Deleting a combo never changes past bills: they keep its name, price and contents as they were. */
exports.remove = async (parlourId, id) => {
  const { rowCount } = await query(`DELETE FROM combos WHERE id = $1 AND parlour_id = $2`, [id, parlourId]);
  if (!rowCount) throw AppError.notFound('Combo not found');
};
