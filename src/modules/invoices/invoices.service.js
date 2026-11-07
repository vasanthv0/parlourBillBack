const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { toPaise, toDecimalString } = require('../../utils/money');
const { offsetOf, pageMeta } = require('../../utils/pagination');
const whatsapp = require('./whatsapp');
const idempotency = require('./idempotency');
const gst = require('./gst');
const payments = require('./payments');
const commission = require('../commissions/commission');
const appointmentRules = require('../appointments/appointments.rules');

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
// "98400 12345", "+91 9840012345" and "9840012345" are the same phone.
const samePhone = (a, b) => { const x = digitsOf(a).slice(-10); const y = digitsOf(b).slice(-10); return x.length >= 7 && x === y; };

const mapRow = (i) => ({
  id: i.id,
  number: i.number,
  customerId: i.customer_id,
  customerName: i.customer_name,
  createdBy: i.created_by,
  createdByName: i.created_by_name ?? null,
  subtotal: Number(i.subtotal),
  discount: Number(i.discount),
  referrerId: i.referrer_id,
  referralPercent: Number(i.referral_percent),
  referralDiscount: Number(i.referral_discount),
  taxPercent: Number(i.tax_percent),
  tax: Number(i.tax),
  // GST detail. cgst and sgst are null on bills made before the split existed: those show one tax line, as they always did.
  priceMode: i.price_mode,
  cgst: i.cgst == null ? null : Number(i.cgst),
  sgst: i.sgst == null ? null : Number(i.sgst),
  taxable: (toPaise(i.total) - toPaise(i.tax)) / 100,
  total: Number(i.total),
  // The one method used, or 'split'. The amounts of a split bill are in `payments` on the full bill (getWith).
  paymentMethod: i.payment_method,
  // Extra money for the staff: not part of the total, not taxed, not revenue. 0 on bills made before tips existed.
  tip: Number(i.tip ?? 0),
  notes: i.notes,
  status: i.status,
  voidReason: i.void_reason,
  voidedAt: i.voided_at,
  createdAt: i.created_at,
});

/**
 * Prices come from the database, never from the client. Totals are computed here, in integer paise.
 *
 * subtotal            services and combos at today's menu prices
 * − referral discount the referrer's percentage of the subtotal (if a referrer was named)
 * − discount          any extra amount the counter takes off
 * GST                 added on top of what is left, or already inside it, as the parlour's price setting says;
 *                     split into CGST and SGST. All of that arithmetic lives in ./gst.js.
 * payments            one or more of cash / UPI / card, which must add up to the total to the paisa (./payments.js).
 *                     A tip is extra: it is saved on the bill but is never part of the total.
 * performers          a line may name who performed it. Each line also records its share of the taxable value, and, when a person
 *                     is named and has a commission rule, the commission earned: all snapshots (../commissions/commission.js).
 */
const createOnce = async (auth, { customerId, walkInName, items, referrerId, discount, paymentMethod, payments: paid, tip, notes, appointmentId }, idem) => {
  return withTransaction(async (db) => {
    // Billing a visit: it is locked FIRST (so two people billing it at once take turns, and the second is refused), and it must be
    // this parlour's own and still open. Refused here, before the bill counter is touched, so no bill number is used up.
    if (appointmentId) {
      const { rows: [visit] } = await db.query(
        `SELECT id, status FROM appointments WHERE id = $1 AND parlour_id = $2 FOR UPDATE`, [appointmentId, auth.parlourId]);
      if (!visit) throw AppError.badRequest('Appointment not found', 'APPOINTMENT_NOT_FOUND');
      if (!appointmentRules.can('bill', visit.status)) {
        const why = appointmentRules.refusal('bill', visit.status);
        throw AppError.conflict(why.message, why.code);
      }
    }

    // Merge duplicate lines for the same service or combo. The same service done by two DIFFERENT people stays two lines,
    // because each person is credited for their own line.
    const wanted = new Map();
    for (const it of items) {
      const kind = it.comboId ? 'combo' : 'service';
      const id = it.comboId || it.serviceId;
      const performerId = it.performedBy || null;
      const key = `${kind}:${id}:${performerId ?? ''}`;
      const have = wanted.get(key);
      if (have) have.qty += it.quantity; else wanted.set(key, { kind, id, performerId, qty: it.quantity });
    }
    const serviceWants = [...wanted.values()].filter((w) => w.kind === 'service');
    const comboWants = [...wanted.values()].filter((w) => w.kind === 'combo');
    const serviceIds = [...new Set(serviceWants.map((w) => w.id))];
    const comboIds = [...new Set(comboWants.map((w) => w.id))];

    const lines = [];

    if (serviceIds.length) {
      const { rows: services } = await db.query(
        `SELECT id, name, price, sac_code FROM services WHERE parlour_id = $1 AND is_active AND id = ANY($2::uuid[])`,
        [auth.parlourId, serviceIds]
      );
      if (services.length !== serviceIds.length) {
        throw AppError.badRequest('One or more services are unavailable. Refresh and try again.', 'SERVICE_UNAVAILABLE');
      }
      const byId = new Map(services.map((s) => [s.id, s]));
      for (const w of serviceWants) {
        const s = byId.get(w.id);
        const unit = toPaise(s.price);
        lines.push({ serviceId: s.id, comboId: null, performerId: w.performerId, name: s.name, description: null, sacCode: s.sac_code ?? null, quantity: w.qty, unit, line: unit * w.qty });
      }
    }

    if (comboIds.length) {
      const { rows: combos } = await db.query(
        `SELECT id, name, price FROM combos WHERE parlour_id = $1 AND is_active AND id = ANY($2::uuid[])`,
        [auth.parlourId, comboIds]
      );
      if (combos.length !== comboIds.length) {
        throw AppError.badRequest('One or more combos are unavailable. Refresh and try again.', 'COMBO_UNAVAILABLE');
      }
      const { rows: parts } = await db.query(
        `SELECT ci.combo_id, ci.quantity, s.name, s.is_active
           FROM combo_items ci JOIN services s ON s.id = ci.service_id
          WHERE ci.combo_id = ANY($1::uuid[]) ORDER BY lower(s.name)`,
        [combos.map((c) => c.id)]
      );
      const byId = new Map(combos.map((c) => [c.id, c]));
      for (const w of comboWants) {
        const c = byId.get(w.id);
        const inside = parts.filter((p) => p.combo_id === c.id);
        if (!inside.length || inside.some((p) => !p.is_active)) {
          throw AppError.badRequest(`The combo “${c.name}” includes a service that is no longer available.`, 'COMBO_UNAVAILABLE');
        }
        const unit = toPaise(c.price);
        // What was inside is written onto the bill, so it stays true even if the combo is edited or deleted later.
        const description = inside.map((p) => (p.quantity > 1 ? `${p.name} × ${p.quantity}` : p.name)).join(' + ');
        lines.push({ serviceId: null, comboId: c.id, performerId: w.performerId, name: c.name, description, sacCode: null, quantity: w.qty, unit, line: unit * w.qty }); // a combo spans several services, so it has no single SAC
      }
    }

    let customerName = walkInName?.trim() || 'Walk-in';
    let customerPhone = null;
    if (customerId) {
      const { rows } = await db.query(`SELECT name, phone FROM customers WHERE id = $1 AND parlour_id = $2`, [customerId, auth.parlourId]);
      if (!rows[0]) throw AppError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
      customerName = rows[0].name;
      customerPhone = rows[0].phone;
    }

    const subtotal = lines.reduce((sum, l) => sum + l.line, 0);

    // Referral: the referrer's percentage comes off the subtotal, and is recorded on the bill for their account.
    let referralPercent = 0;
    let referralPaise = 0;
    if (referrerId) {
      const { rows: [r] } = await db.query(
        `SELECT id, contact, percent FROM referrers WHERE id = $1 AND parlour_id = $2 AND is_active`,
        [referrerId, auth.parlourId]
      );
      if (!r) throw AppError.badRequest('This referrer is not available. Remove them from the bill or choose another.', 'REFERRER_UNAVAILABLE');
      if (customerPhone && samePhone(customerPhone, r.contact)) {
        throw AppError.badRequest('A customer cannot be their own referrer.', 'SELF_REFERRAL');
      }
      referralPercent = Number(r.percent);
      referralPaise = gst.percentOf(subtotal, referralPercent);
    }

    const discountPaise = toPaise(discount);
    if (discountPaise + referralPaise > subtotal) {
      throw AppError.badRequest(
        referralPaise ? 'Discount plus the referral discount cannot be more than the bill total' : 'Discount cannot be more than the bill total',
        'DISCOUNT_TOO_HIGH',
        { discount: referralPaise ? 'With the referral discount, this is more than the subtotal' : 'Discount cannot be more than the subtotal' }
      );
    }

    // The people named on the bill must be active people of THIS parlour. Their rows are held (FOR SHARE) until the bill is saved,
    // so nobody can delete them half-way through. The commission rules are read only when someone is named: a bill that names
    // nobody makes no extra queries and earns no commission.
    const performerIds = [...new Set(lines.map((l) => l.performerId).filter(Boolean))];
    const performerNames = new Map();
    const personRules = new Map();
    const serviceRules = new Map();
    if (performerIds.length) {
      const { rows: people } = await db.query(
        `SELECT id, name FROM performers WHERE parlour_id = $1 AND is_active AND id = ANY($2::uuid[]) FOR SHARE`,
        [auth.parlourId, performerIds]
      );
      if (people.length !== performerIds.length) {
        throw AppError.badRequest('One or more of the people chosen are no longer available. Refresh and try again.', 'PERFORMER_UNAVAILABLE');
      }
      for (const p of people) performerNames.set(p.id, p.name);
      const { rows: rules } = await db.query(
        `SELECT performer_id, service_id, kind, value FROM commission_rules
          WHERE parlour_id = $1 AND (performer_id = ANY($2::uuid[]) OR service_id = ANY($3::uuid[]))`,
        [auth.parlourId, performerIds, [...new Set(lines.map((l) => l.serviceId).filter(Boolean))]]
      );
      for (const r of rules) (r.performer_id ? personRules : serviceRules).set(r.performer_id || r.service_id, { kind: r.kind, value: r.value });
    }

    // Taking the sequence number last keeps the parlour row locked for as short a time as possible.
    const { rows: [parlour] } = await db.query(
      `UPDATE parlours SET invoice_seq = invoice_seq + 1 WHERE id = $1
       RETURNING invoice_prefix, invoice_seq, tax_percent, gst_price_mode, gst_number`,
      [auth.parlourId]
    );
    const taxPercent = Number(parlour.tax_percent);
    const gstin = parlour.gst_number?.trim() || null; // written onto the bill: a later change to the parlour's GSTIN never alters it
    const { tax, cgst, sgst, total, taxable, priceMode } = gst.computeBill({
      subtotal, referral: referralPaise, discount: discountPaise, taxPercent, priceMode: parlour.gst_price_mode,
    });
    const number = `${parlour.invoice_prefix}-${String(parlour.invoice_seq).padStart(5, '0')}`;

    // Each line's share of the taxable value (what it really took in: after the discounts, before GST). The shares add up to
    // the taxable value to the paisa. Commission is worked out on the share, with the rule as it is today, and written onto the line.
    const nets = commission.allocate(taxable, lines.map((l) => l.line));
    lines.forEach((l, i) => {
      l.net = nets[i];
      l.performerName = l.performerId ? performerNames.get(l.performerId) : null;
      const rule = l.performerId
        ? commission.pickRule({ performerRule: personRules.get(l.performerId) ?? null, serviceRule: l.serviceId ? serviceRules.get(l.serviceId) ?? null : null })
        : null;
      l.commission = commission.forLine({ net: l.net, quantity: l.quantity, rule });
    });

    // How it was paid. The amounts must add up to the total exactly, in whole paise. If they do not, nothing is saved:
    // this transaction is rolled back whole, so the invoice number taken above is not used up.
    const paymentRows = payments.fromRequest({ paymentMethod, payments: paid }, total);
    const settled = payments.check(paymentRows, total);
    if (!settled.ok) {
      const rupees = (paise) => `₹${(Math.abs(paise) / 100).toFixed(2)}`;
      const message = settled.difference > 0
        ? `The payments are ${rupees(settled.difference)} short of the bill total of ${rupees(total)}`
        : `The payments are ${rupees(settled.difference)} more than the bill total of ${rupees(total)}`;
      throw AppError.badRequest(message, 'PAYMENTS_MISMATCH', { payments: message });
    }
    const tipPaise = toPaise(tip ?? 0);

    const { rows: [inv] } = await db.query(
      `INSERT INTO invoices (parlour_id, number, customer_id, customer_name, created_by, subtotal, discount,
                             referrer_id, referral_percent, referral_discount, tax_percent, tax, total, payment_method, notes,
                             idempotency_key, idempotency_fingerprint, price_mode, cgst, sgst, gstin, tip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [auth.parlourId, number, customerId || null, customerName, auth.userId,
       toDecimalString(subtotal), toDecimalString(discountPaise),
       referrerId || null, referralPercent.toFixed(2), toDecimalString(referralPaise),
       taxPercent.toFixed(2), toDecimalString(tax), toDecimalString(total), payments.methodOnBill(paymentRows), notes || null,
       idem?.key ?? null, idem?.fingerprint ?? null,
       priceMode, toDecimalString(cgst), toDecimalString(sgst), gstin, toDecimalString(tipPaise)]
    );
    for (const row of paymentRows) {
      await db.query(`INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1,$2,$3)`, [inv.id, row.method, toDecimalString(row.paise)]);
    }
    for (const l of lines) {
      await db.query(
        `INSERT INTO invoice_items (invoice_id, service_id, combo_id, description, name, unit_price, quantity, line_total, sac_code,
                                   net_amount, performed_by, performer_name, commission_kind, commission_rate, commission)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [inv.id, l.serviceId, l.comboId, l.description, l.name, toDecimalString(l.unit), l.quantity, toDecimalString(l.line), l.sacCode,
         toDecimalString(l.net), l.performerId, l.performerName, l.commission.kind, l.commission.rate == null ? null : l.commission.rate.toFixed(2), toDecimalString(l.commission.amount)]
      );
    }
    // The visit is now done, and points at the bill that closed it.
    if (appointmentId) {
      await db.query(
        `UPDATE appointments SET status = 'completed', invoice_id = $3, updated_at = now() WHERE id = $1 AND parlour_id = $2`,
        [appointmentId, auth.parlourId, inv.id]
      );
    }
    return exports.getWith(db, auth, inv.id);
  });
};

/**
 * Create a bill. With an Idempotency-Key the same request can safely be sent again (a double tap, or a retry
 * after a dropped connection) and the original bill comes back instead of a second one:
 *   same key, same request   → the original bill (replayed: true)
 *   same key, other request  → 409 IDEMPOTENCY_KEY_REUSED, nothing is created
 * Without a key nothing changes. Returns { invoice, replayed }.
 */
exports.create = async (auth, body, { idempotencyKey = null } = {}) => {
  if (!idempotencyKey) return { invoice: await createOnce(auth, body, null), replayed: false };

  const fingerprint = idempotency.fingerprintOf(body);
  const replay = async () => {
    const id = await idempotency.findReplay({ query }, auth, idempotencyKey, fingerprint);
    return id ? { invoice: await exports.get(auth, id), replayed: true } : null;
  };

  const earlier = await replay();
  if (earlier) return earlier;
  try {
    return { invoice: await createOnce(auth, body, { key: idempotencyKey, fingerprint }), replayed: false };
  } catch (err) {
    // Two copies of the same request arrived together and the other one won. Its bill is the answer;
    // this attempt was rolled back whole, so the invoice number it took is not used up.
    if (idempotency.isKeyConflict(err)) {
      const won = await replay();
      if (won) return won;
    }
    throw err;
  }
};

exports.list = async (auth, q) => {
  const params = [auth.parlourId];
  const where = ['i.parlour_id = $1'];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };

  // Staff only ever see the bills they created; admins see the whole parlour.
  if (auth.role !== 'admin') add('i.created_by = ?', auth.userId);
  else if (q.createdBy) add('i.created_by = ?', q.createdBy); // admin-only "made by" filter
  if (q.status) add('i.status = ?', q.status);
  if (q.from) add(`(i.created_at AT TIME ZONE p.timezone)::date >= ?::date`, q.from);
  if (q.to) add(`(i.created_at AT TIME ZONE p.timezone)::date <= ?::date`, q.to);
  if (q.search) {
    add(`(i.number ILIKE ? OR i.customer_name ILIKE ?)`, `%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
  }

  const from = `FROM invoices i JOIN parlours p ON p.id = i.parlour_id LEFT JOIN users u ON u.id = i.created_by WHERE ${where.join(' AND ')}`;
  const { rows } = await query(
    `SELECT i.*, u.name AS created_by_name ${from} ORDER BY i.created_at DESC LIMIT ${Number(q.limit)} OFFSET ${Number(offsetOf(q))}`,
    params
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count ${from}`, params);
  return { items: rows.map(mapRow), meta: pageMeta(q, count) };
};

/** People who have made at least one bill: the options for the admin's "made by" filter. */
exports.makers = async (parlourId) => {
  const { rows } = await query(
    `SELECT u.id, u.name FROM users u
      WHERE u.parlour_id = $1 AND EXISTS (SELECT 1 FROM invoices i WHERE i.created_by = u.id)
      ORDER BY lower(u.name)`,
    [parlourId]
  );
  return rows;
};

/** Full invoice with line items and the parlour header, ready to display or print. */
exports.getWith = async (db, auth, id) => {
  const { rows } = await db.query(
    `SELECT i.*, u.name AS created_by_name,
            p.name AS parlour_name, p.phone AS parlour_phone, p.address AS parlour_address, p.gst_number AS parlour_gst,
            p.timezone AS parlour_timezone, c.phone AS customer_phone,
            rf.code AS referrer_code, rf.name AS referrer_name
       FROM invoices i
       JOIN parlours p ON p.id = i.parlour_id
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN referrers rf ON rf.id = i.referrer_id
      WHERE i.id = $1 AND i.parlour_id = $2 ${auth.role === 'admin' ? '' : 'AND i.created_by = $3'}`,
    auth.role === 'admin' ? [id, auth.parlourId] : [id, auth.parlourId, auth.userId]
  );
  if (!rows[0]) throw AppError.notFound('Invoice not found');
  const { rows: items } = await db.query(
    `SELECT id, combo_id, description, name, sac_code, unit_price, quantity, line_total, performed_by, performer_name FROM invoice_items WHERE invoice_id = $1 ORDER BY name, performer_name, id`,
    [id]
  );
  // Read through the invoice so another parlour's payments can never come back, even for a mistyped id.
  const { rows: paid } = await db.query(
    `SELECT ip.method, ip.amount FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE ip.invoice_id = $1 AND i.parlour_id = $2`,
    [id, auth.parlourId]
  );
  const r = rows[0];
  return {
    ...mapRow(r),
    // What was paid with each method. A bill from before payments existed has no rows: it shows its one method for the whole total.
    payments: payments.forDisplay(paid, { method: r.payment_method, total: r.total }),
    customerPhone: r.customer_phone,
    // The GSTIN printed on this bill. A bill with a GST split carries the one it was made under; a bill from before the
    // split has none saved and shows the parlour's current one, exactly as it always has.
    gstin: r.cgst == null ? r.parlour_gst : r.gstin,
    referrer: r.referrer_id ? { id: r.referrer_id, code: r.referrer_code, name: r.referrer_name } : null,
    parlour: { name: r.parlour_name, phone: r.parlour_phone, address: r.parlour_address, gstNumber: r.parlour_gst, timezone: r.parlour_timezone },
    items: items.map((it) => ({
      id: it.id, comboId: it.combo_id, description: it.description, name: it.name, sacCode: it.sac_code ?? null,
      unitPrice: Number(it.unit_price), quantity: it.quantity, lineTotal: Number(it.line_total),
      // Who performed it, as named on the day. Null when nobody was chosen, and on every bill made before this existed.
      // What they earned is deliberately NOT here: staff can open their own bills, and commission is the admin's to see.
      performedBy: it.performed_by ?? null, performerName: it.performer_name ?? null,
    })),
  };
};

exports.get = (auth, id) => exports.getWith({ query }, auth, id);

exports.void = async (auth, id, { reason }) => {
  const { rowCount } = await query(
    `UPDATE invoices SET status = 'void', void_reason = $3, voided_by = $4, voided_at = now()
      WHERE id = $1 AND parlour_id = $2 AND status = 'paid'`,
    [id, auth.parlourId, reason, auth.userId]
  );
  if (!rowCount) {
    const { rows } = await query(`SELECT status FROM invoices WHERE id = $1 AND parlour_id = $2`, [id, auth.parlourId]);
    if (!rows[0]) throw AppError.notFound('Invoice not found');
    throw AppError.conflict('This invoice is already void', 'ALREADY_VOID');
  }
  return exports.get(auth, id);
};

/**
 * The bill as a ready-to-send WhatsApp link. WhatsApp opens with the message written and the number filled in;
 * a person still presses Send. The text is built here so every bill reads the same and the switch is enforced server-side.
 */
exports.whatsapp = async (auth, id, { phone }) => {
  const inv = await exports.get(auth, id); // staff can only reach their own bills
  if (inv.status === 'void') throw AppError.conflict('A voided bill cannot be sent', 'BILL_VOID');
  const number = whatsapp.normalizeNumber(phone || inv.customerPhone);
  const message = whatsapp.buildMessage(inv);
  return { phone: number, message, url: `https://wa.me/${number}?text=${encodeURIComponent(message)}` };
};
