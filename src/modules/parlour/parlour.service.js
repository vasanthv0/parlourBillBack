const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');

const map = (p) => ({
  id: p.id,
  name: p.name,
  phone: p.phone,
  address: p.address,
  gstNumber: p.gst_number,
  currency: p.currency,
  timezone: p.timezone,
  taxPercent: Number(p.tax_percent),
  // 'exclusive': GST is added to the menu price. 'inclusive': the menu price already contains it.
  gstPriceMode: p.gst_price_mode,
  invoicePrefix: p.invoice_prefix,
});

exports.get = async (parlourId) => {
  const { rows } = await query(`SELECT * FROM parlours WHERE id = $1`, [parlourId]);
  if (!rows[0]) throw AppError.notFound('Parlour not found');
  return map(rows[0]);
};

exports.update = async (parlourId, p) => {
  const { rows } = await query(
    `UPDATE parlours SET
        name = COALESCE($2, name),
        phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
        address = CASE WHEN $5::boolean THEN $6 ELSE address END,
        gst_number = CASE WHEN $7::boolean THEN $8 ELSE gst_number END,
        tax_percent = COALESCE($9, tax_percent),
        invoice_prefix = COALESCE($10, invoice_prefix),
        gst_price_mode = COALESCE($11, gst_price_mode)
      WHERE id = $1 RETURNING *`,
    [
      parlourId,
      p.name ?? null,
      'phone' in p, p.phone ?? null,
      'address' in p, p.address ?? null,
      'gstNumber' in p, p.gstNumber ?? null,
      p.taxPercent ?? null,
      p.invoicePrefix ?? null,
      p.gstPriceMode ?? null,
    ]
  );
  return map(rows[0]);
};
