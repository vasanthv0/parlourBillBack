// Development seed: one demo parlour, an admin, two staff, a service menu, customers and two weeks of bills.
//   npm run db:init && npm run db:seed
const env = require('../src/config/env');
const { pool, withTransaction } = require('../src/config/db');
const { hashPassword } = require('../src/modules/auth/auth.service');
const { toPaise, toDecimalString } = require('../src/utils/money');
const gst = require('../src/modules/invoices/gst');
const payments = require('../src/modules/invoices/payments');
const commission = require('../src/modules/commissions/commission');

const SERVICES = [
  ['Haircut – Women', 'Hair', 450, 45], ['Haircut – Men', 'Hair', 200, 30], ['Hair Colour (Global)', 'Hair', 1800, 120],
  ['Keratin Treatment', 'Hair', 3500, 150], ['Head Massage', 'Hair', 300, 20],
  ['Classic Facial', 'Skin', 900, 60], ['Gold Facial', 'Skin', 1500, 75], ['De-tan Clean-up', 'Skin', 700, 45],
  ['Manicure', 'Nails', 500, 40], ['Pedicure', 'Nails', 650, 50], ['Gel Polish', 'Nails', 800, 45],
  ['Full Arms Waxing', 'Waxing', 350, 25], ['Full Legs Waxing', 'Waxing', 500, 35], ['Threading – Eyebrows', 'Waxing', 60, 10],
  ['Bridal Makeup', 'Bridal', 12000, 180], ['Party Makeup', 'Bridal', 3500, 75],
];
// Example SAC codes for the demo menu (999721 hairdressing, 999722 beauty treatment). Check the right code for your own services.
const SAC_BY_CATEGORY = { Hair: '999721', Skin: '999722', Nails: '999722', Waxing: '999722', Bridal: '999722' };
const DEMO_GSTIN = '33ABCDE1234F1Z5';
const CUSTOMERS = [
  ['Ananya Iyer', '9840012345'], ['Meera Krishnan', '9840023456'], ['Divya Raman', '9840034567'], ['Sneha Patel', '9840045678'],
  ['Lakshmi Narayanan', '9840056789'], ['Priyanka Das', '9840067890'], ['Kavya Menon', '9840078901'], ['Rohit Sharma', '9840089012'],
];
const METHODS = ['cash', 'upi', 'upi', 'card', 'cash'];

const COMBOS = [
  ['Glow Package', 1500, [['Classic Facial', 1], ['De-tan Clean-up', 1], ['Threading – Eyebrows', 1]]],
  ['Bridal Prep', 1700, [['Full Arms Waxing', 1], ['Full Legs Waxing', 1], ['Manicure', 1], ['Pedicure', 1]]],
  ['Hair Care Duo', 650, [['Haircut – Women', 1], ['Head Massage', 1]]],
];
const REFERRERS = [['Anita Rao', '9841100001', 10], ['Kumar S', '9841100002', 5], ['Divya M', '9841100003', 8]];
// The people who perform services (names only, no login), and a few commission rules to show the options:
// a percentage for two of them, none for the third (so a service rule can apply to them), and a flat amount on one service.
const PERFORMERS = ['Meena', 'Asha', 'Farhan'];
const PERSON_RULES = [['Meena', 'percent', 10], ['Asha', 'percent', 12.5]];
const SERVICE_RULES = [['Keratin Treatment', 'flat', 200]];

/**
 * A demo staff member who signs in with a mobile number alone (no email): 9840033333. Safe to run again:
 * nothing is added if anybody already has that number.
 */
async function addMobileOnlyStaff(db, parlourId, hash) {
  const { rowCount } = await db.query(`SELECT 1 FROM users WHERE mobile_normalised = '9840033333'`);
  if (rowCount) return false;
  await db.query(
    `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'Kavya', NULL, '98400 33333', $2, 'staff')`,
    [parlourId, hash]
  );
  return true;
}

/** Demo combos and referrers. Safe to run on a database that already has them. */
async function addExtras(db, parlourId) {
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM combos WHERE parlour_id = $1`, [parlourId]);
  if (n === 0) {
    const { rows: services } = await db.query(`SELECT id, name FROM services WHERE parlour_id = $1`, [parlourId]);
    const byName = new Map(services.map((s) => [s.name, s.id]));
    for (const [name, price, parts] of COMBOS) {
      if (!parts.every(([sn]) => byName.has(sn))) continue;
      const { rows: [c] } = await db.query(`INSERT INTO combos (parlour_id, name, price) VALUES ($1,$2,$3) RETURNING id`, [parlourId, name, price]);
      for (const [sn, qty] of parts) await db.query(`INSERT INTO combo_items (combo_id, service_id, quantity) VALUES ($1,$2,$3)`, [c.id, byName.get(sn), qty]);
    }
  }
  const { rows: [{ r }] } = await db.query(`SELECT COUNT(*)::int AS r FROM referrers WHERE parlour_id = $1`, [parlourId]);
  if (r === 0) {
    let seq = 0;
    for (const [name, contact, percent] of REFERRERS) {
      seq += 1;
      await db.query(`INSERT INTO referrers (parlour_id, code, name, contact, percent) VALUES ($1,$2,$3,$4,$5)`, [parlourId, `REF-${String(seq).padStart(4, '0')}`, name, contact, percent]);
    }
    await db.query(`UPDATE parlours SET referral_seq = GREATEST(referral_seq, $2) WHERE id = $1`, [parlourId, seq]);
  }
  const { rows: [{ p }] } = await db.query(`SELECT COUNT(*)::int AS p FROM performers WHERE parlour_id = $1`, [parlourId]);
  if (p === 0) {
    const ids = new Map();
    for (const name of PERFORMERS) {
      const { rows: [row] } = await db.query(`INSERT INTO performers (parlour_id, name) VALUES ($1, $2) RETURNING id`, [parlourId, name]);
      ids.set(name, row.id);
    }
    for (const [name, kind, value] of PERSON_RULES) {
      await db.query(`INSERT INTO commission_rules (parlour_id, performer_id, kind, value) VALUES ($1,$2,$3,$4)`, [parlourId, ids.get(name), kind, value]);
    }
    const { rows: services } = await db.query(`SELECT id, name FROM services WHERE parlour_id = $1`, [parlourId]);
    const byName = new Map(services.map((sv) => [sv.name, sv.id]));
    for (const [name, kind, value] of SERVICE_RULES) {
      if (byName.has(name)) await db.query(`INSERT INTO commission_rules (parlour_id, service_id, kind, value) VALUES ($1,$2,$3,$4)`, [parlourId, byName.get(name), kind, value]);
    }
  }
}

// Deterministic pseudo-random so every seed run looks the same.
let state = 42;
const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

(async () => {
  if (env.isProd && !process.env.SEED_PASSWORD) {
    console.error('Refusing to seed production without SEED_PASSWORD set.');
    process.exit(1);
  }
  const password = process.env.SEED_PASSWORD || 'Demo@12345';
  const hash = await hashPassword(password);

  try {
    await withTransaction(async (db) => {
      // The platform super admin (belongs to no parlour). Real installs create theirs with `npm run superadmin:create`.
      const hasSuper = await db.query(`SELECT 1 FROM users WHERE lower(email) = 'super@demo.parlour'`);
      if (!hasSuper.rowCount) {
        await db.query(`INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES (NULL, 'Platform Admin', 'super@demo.parlour', $1, 'super_admin')`, [hash]);
        console.log(`Created super admin: super@demo.parlour / ${password}`);
      }

      const existing = await db.query(`SELECT id FROM users WHERE lower(email) = 'admin@demo.parlour'`);
      if (existing.rowCount) {
        const { rows: [demo] } = await db.query(`SELECT parlour_id FROM users WHERE lower(email) = 'admin@demo.parlour'`);
        await addExtras(db, demo.parlour_id); // an older demo database gets the newer demo data too
        if (await addMobileOnlyStaff(db, demo.parlour_id, hash)) console.log(`Added demo staff who signs in by mobile: 9840033333 / ${password}`);
        console.log('Demo data already present. Added demo combos, referrers and performers if they were missing.');
        return;
      }

      const { rows: [parlour] } = await db.query(
        `INSERT INTO parlours (name, phone, address, gst_number, tax_percent, invoice_prefix)
         VALUES ('Demo Parlour', '9840000000', '12, Lake View Road, Chennai', '${DEMO_GSTIN}', 5, 'DP') RETURNING id, tax_percent`
      );
      const user = async (name, email, mobile, role) =>
        (await db.query(`INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [parlour.id, name, email, mobile, hash, role])).rows[0].id;
      await user('Demo Admin', 'admin@demo.parlour', '9840000001', 'admin');
      const staffIds = [await user('Riya', 'staff@demo.parlour', '9840011111', 'staff'), await user('Farah', 'farah@demo.parlour', '9840022222', 'staff')];

      const services = [];
      for (const [name, category, price, dur] of SERVICES) {
        const { rows } = await db.query(
          `INSERT INTO services (parlour_id, name, category, price, duration_min, sac_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, price, sac_code`,
          [parlour.id, name, category, price, dur, SAC_BY_CATEGORY[category] ?? null]);
        services.push(rows[0]);
      }
      const customers = [];
      for (const [name, phone] of CUSTOMERS) {
        const { rows } = await db.query(`INSERT INTO customers (parlour_id, name, phone) VALUES ($1,$2,$3) RETURNING id, name`, [parlour.id, name, phone]);
        customers.push(rows[0]);
      }

      await addExtras(db, parlour.id);
      await addMobileOnlyStaff(db, parlour.id, hash);
      const { rows: referrers } = await db.query(`SELECT id, percent FROM referrers WHERE parlour_id = $1`, [parlour.id]);

      // Who performed what is chosen by position, not by chance, so the demo bills above are exactly what they were before.
      // Every 4th bill (the "old" ones) names nobody, so the dashboard also shows work that is not credited to anyone.
      const { rows: performers } = await db.query(`SELECT id, name FROM performers WHERE parlour_id = $1 ORDER BY name`, [parlour.id]);
      const { rows: ruleRows } = await db.query(`SELECT performer_id, service_id, kind, value FROM commission_rules WHERE parlour_id = $1`, [parlour.id]);
      const personRules = new Map(ruleRows.filter((r) => r.performer_id).map((r) => [r.performer_id, { kind: r.kind, value: r.value }]));
      const serviceRules = new Map(ruleRows.filter((r) => r.service_id).map((r) => [r.service_id, { kind: r.kind, value: r.value }]));

      let seq = 0;
      for (let n = 0; n < 45; n++) {
        const daysAgo = Math.floor(rand() * 14);
        const hours = 10 + Math.floor(rand() * 9);
        const lines = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(services)))];
        const subtotal = lines.reduce((s, l) => s + toPaise(l.price), 0);
        // About one bill in five names a referrer; those bills take the referral discount instead of a manual one.
        const referrer = rand() < 0.2 ? pick(referrers) : null;
        const referral = referrer ? gst.percentOf(subtotal, referrer.percent) : 0;
        const discount = !referrer && rand() < 0.2 ? Math.round(subtotal * 0.1 / 100) * 100 : 0;
        // The same arithmetic the API uses (the demo parlour adds GST on top of its prices), with the CGST/SGST split.
        const bill = gst.computeBill({ subtotal, referral, discount, taxPercent: Number(parlour.tax_percent), priceMode: 'exclusive' });
        const customer = rand() < 0.7 ? pick(customers) : null;
        seq += 1;
        const staffId = pick(staffIds);
        const method = pick(METHODS);
        // Chosen by position, not by chance, so the demo data above is the same as it was before payments existed:
        //   every 4th bill is an "old" bill (only payment_method, no payment rows), which exercises the old-bill path in reports;
        //   every 5th of the rest is paid half cash, half UPI (a split bill); every 7th of the rest carries a ₹50 tip.
        const legacy = n % 4 === 3;
        const split = !legacy && n % 5 === 0 && bill.total >= 2;
        const rows = split
          ? [{ method: 'cash', paise: Math.floor(bill.total / 2) }, { method: 'upi', paise: bill.total - Math.floor(bill.total / 2) }]
          : [{ method, paise: bill.total }];
        const tipPaise = !legacy && n % 7 === 0 ? 5_000 : 0;
        const { rows: [inv] } = await db.query(
          `INSERT INTO invoices (parlour_id, number, customer_id, customer_name, created_by, subtotal, discount, tax_percent, tax, total, payment_method,
                                 referrer_id, referral_percent, referral_discount, price_mode, cgst, sgst, gstin, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$14,$15,$16,$17,$18,$19,$20, date_trunc('day', now()) - ($12 || ' days')::interval + ($13 || ' hours')::interval) RETURNING id`,
          [parlour.id, `DP-${String(seq).padStart(5, '0')}`, customer?.id ?? null, customer?.name ?? 'Walk-in', staffId,
           toDecimalString(subtotal), toDecimalString(discount), parlour.tax_percent, toDecimalString(bill.tax), toDecimalString(bill.total),
           payments.methodOnBill(rows), String(daysAgo), String(hours),
           referrer?.id ?? null, referrer ? referrer.percent : 0, toDecimalString(referral),
           bill.priceMode, toDecimalString(bill.cgst), toDecimalString(bill.sgst), DEMO_GSTIN]);
        if (!legacy) {
          for (const r of rows) await db.query(`INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1,$2,$3)`, [inv.id, r.method, toDecimalString(r.paise)]);
          if (tipPaise) await db.query(`UPDATE invoices SET tip = $2 WHERE id = $1`, [inv.id, toDecimalString(tipPaise)]);
        }
        const by = !legacy && performers.length ? performers[n % performers.length] : null;
        const nets = commission.allocate(bill.taxable, lines.map((l) => toPaise(l.price)));
        for (const [i, l] of lines.entries()) {
          const rule = by ? commission.pickRule({ performerRule: personRules.get(by.id), serviceRule: serviceRules.get(l.id) }) : null;
          const c = commission.forLine({ net: nets[i], quantity: 1, rule });
          await db.query(
            `INSERT INTO invoice_items (invoice_id, service_id, name, unit_price, quantity, line_total, sac_code,
                                        net_amount, performed_by, performer_name, commission_kind, commission_rate, commission)
             VALUES ($1,$2,$3,$4,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [inv.id, l.id, l.name, l.price, l.sac_code, toDecimalString(nets[i]), by?.id ?? null, by?.name ?? null,
             c.kind, c.rate == null ? null : c.rate.toFixed(2), toDecimalString(c.amount)]);
        }
      }
      await db.query(`UPDATE parlours SET invoice_seq = $2 WHERE id = $1`, [parlour.id, seq]);
      console.log(`Seeded Demo Parlour.\n  admin@demo.parlour / ${password}\n  staff@demo.parlour / ${password}\n  9840033333 (mobile only) / ${password}`);
    });
  } catch (err) {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
