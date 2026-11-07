// READ-ONLY report. Changes nothing: the whole run is one READ ONLY transaction that is rolled back.
//
//   npm run report:customer-phones               full detail (names, numbers, emails)
//   npm run report:customer-phones -- --mask     hides most digits, surnames and email names: safe to paste into a chat
//   npm run report:customer-phones -- --json     the same report as JSON
//
// Why it exists: the plan is to make UNIQUE (parlour_id, last 10 digits of phone) true for customers, the same
// rule referrers already follow. That rule cannot be added while two customers of one parlour share a number.
// This lists every such group, plus numbers that are too short or have no digits, so YOU decide what happens to
// each one. Nothing is ever merged, edited or deleted automatically.

const { digitsOf } = require('../src/utils/phone');

// The digits are extracted with the same regexp_replace the referrers index uses; the last 10 are taken in JS
// (identical to right(digits, 10)). Bill counts come from invoices: paid ones, voided ones, money and last visit.
const SQL = String.raw`
SELECT p.id AS parlour_id, p.name AS parlour_name,
       c.id, c.name, c.phone, c.email, c.created_at,
       regexp_replace(c.phone, '\D', '', 'g') AS digits,
       COALESCE(s.bills, 0)      AS bills,
       COALESCE(s.void_bills, 0) AS void_bills,
       COALESCE(s.spent, 0)      AS spent,
       s.last_visit
  FROM customers c
  JOIN parlours p ON p.id = c.parlour_id
  LEFT JOIN (
    SELECT customer_id,
           COUNT(*)           FILTER (WHERE status = 'paid') AS bills,
           COUNT(*)           FILTER (WHERE status = 'void') AS void_bills,
           SUM(total)         FILTER (WHERE status = 'paid') AS spent,
           MAX(created_at)    FILTER (WHERE status = 'paid') AS last_visit
      FROM invoices
     WHERE customer_id IS NOT NULL
     GROUP BY customer_id
  ) s ON s.customer_id = c.id
 ORDER BY p.name, c.created_at, c.id`;

// ───────────── masking (for pasting the report somewhere) ─────────────
const maskPhone = (phone) => {
  const d = digitsOf(phone);
  return d.length <= 5 ? '*'.repeat(d.length) : `${d.slice(0, 2)}${'*'.repeat(d.length - 5)}${d.slice(-3)}`;
};
const maskName = (name) => {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts[0]} ${parts[parts.length - 1][0]}.`;
};
const maskEmail = (email) => (email ? String(email).replace(/^(.).*(@.*)$/, '$1***$2') : null);

// ───────────── building the report from the query rows ─────────────

// A number typed with +91, 91 or a leading 0 is still a local number: those prefixes do not make two
// customers different people. Any other extra leading digits (another country code) might.
const domesticPrefix = (extra) => (['', '0', '91'].includes(extra) ? '' : extra);

const byCreated = (a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || (a.id < b.id ? -1 : 1);

/** rows: the query result. Returns { totals, groups, short, noDigits }. Groups use the real digits; masking happens last. */
function buildReport(rows, { mask = false } = {}) {
  const customers = rows.map((r) => {
    const digits = String(r.digits ?? '');
    return {
      parlourId: r.parlour_id,
      parlourName: r.parlour_name,
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email ?? null,
      createdAt: r.created_at,
      digits,
      phone10: digits.slice(-10),
      extraDigits: digits.length > 10 ? digits.slice(0, -10) : '',
      bills: Number(r.bills) || 0,
      voidBills: Number(r.void_bills) || 0,
      spent: Number(r.spent) || 0,
      lastVisit: r.last_visit ?? null,
    };
  });

  const byKey = new Map();
  for (const c of customers) {
    const key = `${c.parlourId}|${c.phone10}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const groups = [...byKey.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const sorted = [...list].sort(byCreated);
      return {
        parlourId: sorted[0].parlourId,
        parlourName: sorted[0].parlourName,
        phone10: sorted[0].phone10,
        noDigits: sorted[0].phone10 === '',
        // true when the extra leading digits differ (say +44 and +91): possibly different people, not a typo.
        mixedPrefixes: new Set(sorted.map((c) => domesticPrefix(c.extraDigits))).size > 1,
        customers: sorted,
      };
    })
    .sort((a, b) => a.parlourName.localeCompare(b.parlourName) || a.phone10.localeCompare(b.phone10));

  const short = customers.filter((c) => c.digits.length >= 1 && c.digits.length < 10);
  const noDigits = customers.filter((c) => c.digits.length === 0);

  const report = {
    totals: {
      customers: customers.length,
      parlours: new Set(customers.map((c) => c.parlourId)).size,
      collisionGroups: groups.length,
      customersInCollisions: groups.reduce((n, g) => n + g.customers.length, 0),
      shortNumbers: short.length,
      noDigits: noDigits.length,
    },
    groups,
    short,
    noDigits,
  };
  return mask ? maskReport(report) : report;
}

function maskReport(report) {
  const maskOne = (c) => ({ ...c, name: maskName(c.name), phone: maskPhone(c.phone), email: maskEmail(c.email), digits: maskPhone(c.digits), phone10: maskPhone(c.phone10), extraDigits: c.extraDigits });
  return {
    ...report,
    groups: report.groups.map((g) => ({ ...g, phone10: maskPhone(g.phone10), customers: g.customers.map(maskOne) })),
    short: report.short.map(maskOne),
    noDigits: report.noDigits.map(maskOne),
  };
}

// ───────────── printing ─────────────
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

const summaryRow = (label, value) => `  ${label} ${'.'.repeat(Math.max(2, 38 - label.length))} ${value}`;

const customerLine = (c, i) =>
  `    ${i + 1}) id ${c.id}  ${c.name || '(no name)'}  "${c.phone}"${c.email ? `  ${c.email}` : ''}\n` +
  `       added ${day(c.createdAt)} · ${plural(c.bills, 'paid bill')}${c.bills ? ` (${rupees(c.spent)}, last visit ${day(c.lastVisit)})` : ''}` +
  `${c.voidBills ? ` · ${plural(c.voidBills, 'voided bill')}` : ''}`;

function formatReport(report, { masked = false, database = '' } = {}) {
  const t = report.totals;
  const out = [];
  out.push('CUSTOMER PHONE COLLISION REPORT. Read-only: nothing was changed.');
  out.push(`Database: ${database || '(unknown)'}    Generated: ${new Date().toISOString()}`);
  out.push('Rule checked: one customer per parlour per phone number, comparing the last 10 digits only.');
  out.push(masked ? 'Masked: digits, surnames and email names are hidden. Ids are real.' : 'This report contains customer names and numbers. Run it with  -- --mask  before sharing it.');
  out.push('');
  out.push('SUMMARY');
  out.push(summaryRow('Customers checked', `${plural(t.customers, 'customer')} in ${plural(t.parlours, 'parlour')}`));
  out.push(summaryRow('Collision groups', `${t.collisionGroups} (${plural(t.customersInCollisions, 'customer')} involved)`));
  out.push(summaryRow('Numbers with fewer than 10 digits', t.shortNumbers));
  out.push(summaryRow('Numbers with no digits at all', t.noDigits));
  out.push('');

  if (!report.groups.length) {
    out.push('COLLISIONS: none. Nothing stands in the way of the unique rule.');
  } else {
    out.push(`COLLISIONS (${report.groups.length}). The unique rule cannot be added until each group is resolved.`);
    report.groups.forEach((g, gi) => {
      const what = g.noDigits ? 'numbers with no digits at all' : `last 10 digits ${g.phone10}`;
      out.push('');
      out.push(`  Group ${gi + 1} of ${report.groups.length} · ${g.parlourName} (parlour ${String(g.parlourId).slice(0, 8)}…) · ${what} · ${g.customers.length} customers`);
      if (g.mixedPrefixes) out.push('    ! The numbers differ in extra leading digits (another country code?). These may be different people.');
      g.customers.forEach((c, i) => out.push(customerLine(c, i)));
    });
  }

  if (report.short.length) {
    out.push('');
    out.push(`SHORT NUMBERS (${report.short.length}). Not collisions, but under 10 digits; the new at-least-10-digits rule would reject them if someone edits that number.`);
    report.short.forEach((c, i) => out.push(`${customerLine(c, i)}   [${c.parlourName}]`));
  }
  if (report.noDigits.length) {
    out.push('');
    out.push(`NO DIGITS (${report.noDigits.length}). The phone holds no digits at all.`);
    report.noDigits.forEach((c, i) => out.push(`${customerLine(c, i)}   [${c.parlourName}]`));
  }

  out.push('');
  out.push('Nothing was merged, edited or deleted. Tell me how you want each group handled; the unique rule is added only after that.');
  return out.join('\n');
}

// ───────────── running it ─────────────
async function main(argv = process.argv.slice(2)) {
  const mask = argv.includes('--mask');
  const json = argv.includes('--json');
  const { pool } = require('../src/config/db'); // loaded here so the functions above can be tested without a database

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY'); // the database itself refuses any write
    const { rows } = await client.query(SQL);
    const { rows: [db] } = await client.query('SELECT current_database() AS name');
    await client.query('ROLLBACK');
    const report = buildReport(rows, { mask });
    console.log(json ? JSON.stringify({ database: db.name, ...report }, null, 2) : formatReport(report, { masked: mask, database: db.name }));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Report failed:', err.message); // message only: never a connection string or a query
    process.exitCode = 1;
  });
}

module.exports = { SQL, buildReport, formatReport, maskPhone, maskName, maskEmail, domesticPrefix };
