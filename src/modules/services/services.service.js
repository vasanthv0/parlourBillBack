const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');

const map = (s) => ({
  id: s.id,
  name: s.name,
  category: s.category,
  price: Number(s.price),
  durationMin: s.duration_min,
  sacCode: s.sac_code,
  isActive: s.is_active,
});

exports.list = async (parlourId, { includeInactive }) => {
  const { rows } = await query(
    `SELECT * FROM services WHERE parlour_id = $1 ${includeInactive ? '' : 'AND is_active'} ORDER BY category, lower(name)`,
    [parlourId]
  );
  return rows.map(map);
};

exports.create = async (parlourId, { name, category, price, durationMin, sacCode }) => {
  try {
    const { rows } = await query(
      `INSERT INTO services (parlour_id, name, category, price, duration_min, sac_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [parlourId, name, category, price.toFixed(2), durationMin, sacCode ?? null]
    );
    return map(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('A service with this name already exists', 'SERVICE_EXISTS');
    throw err;
  }
};

exports.update = async (parlourId, id, p) => {
  try {
    const { rows } = await query(
      `UPDATE services SET
          name = COALESCE($3, name), category = COALESCE($4, category), price = COALESCE($5, price),
          duration_min = COALESCE($6, duration_min), is_active = COALESCE($7, is_active),
          sac_code = CASE WHEN $8::boolean THEN $9 ELSE sac_code END
        WHERE id = $1 AND parlour_id = $2 RETURNING *`,
      [id, parlourId, p.name ?? null, p.category ?? null, p.price == null ? null : p.price.toFixed(2), p.durationMin ?? null, p.isActive ?? null,
       'sacCode' in p, p.sacCode ?? null] // only a request that mentions sacCode changes it (null clears it)
    );
    if (!rows[0]) throw AppError.notFound('Service not found');
    return map(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('A service with this name already exists', 'SERVICE_EXISTS');
    throw err;
  }
};
