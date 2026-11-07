// READ-ONLY report. Changes nothing: the whole run is one READ ONLY transaction that is rolled back.
//
//   npm run report:user-mobiles               full detail (names, numbers, emails)
//   npm run report:user-mobiles -- --mask     hides most digits, surnames and email names: safe to paste into a chat
//   npm run report:user-mobiles -- --json     the same report as JSON
//
// Why it exists: people can now sign in with a mobile number, so a number must belong to exactly ONE account across the
// whole platform (the last 10 digits are compared, like referrers and customers). The unique rule cannot be added while
// two accounts already share a number. This lists every such group, plus numbers that are too short to sign in with, so
// YOU decide what happens to each one. Nothing is ever merged, edited or deleted automatically.
//
// It works on a database that has NOT had the Phase 5 schema applied yet (it never reads users.mobile_normalised), so
// run it against production BEFORE `npm run db:init`.

const { digitsOf } = require('../src/utils/phone');
const { maskPhone, maskName, maskEmail, domesticPrefix } = require('./report-customer-phone-collisions');

const SQL = String.raw`
SELECT u.id, u.name, u.email, u.mobile, u.role, u.is_active, u.created_at, u.last_login_at,
       p.id AS parlour_id, p.name AS parlour_name,
       regexp_replace(u.mobile, '\D', '', 'g') AS digits
  FROM users u
  LEFT JOIN parlours p ON p.id = u.parlour_id
 WHERE u.mobile IS NOT NULL
 ORDER BY p.name NULLS FIRST, u.created_at, u.id`;

const TOTALS_SQL = `SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE mobile IS NOT NULL)::int AS with_mobile FROM users`;

const byCreated = (a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || (a.id < b.id ? -1 : 1);

/** rows: the query result; totals: { users, with_mobile }. Returns { totals, groups, short, noDigits }. */
function buildReport(rows, { mask = false, totals = {} } = {}) {
  const accounts = rows.map((r) => {
    const digits = String(r.digits ?? '');
    return {
      id: r.id,
      name: r.name,
      email: r.email ?? null,
      mobile: r.mobile,
      role: r.role,
      isActive: r.is_active,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at ?? null,
      parlourId: r.parlour_id ?? null,
      parlourName: r.parlour_name ?? '(platform)',
      digits,
      mobile10: digits.slice(-10),
      extraDigits: digits.length > 10 ? digits.slice(0, -10) : '',
    };
  });

  // Only numbers with at least 10 digits take part in the rule: shorter ones have no comparable form.
  const byKey = new Map();
  for (const a of accounts.filter((x) => x.digits.length >= 10)) {
    if (!byKey.has(a.mobile10)) byKey.set(a.mobile10, []);
    byKey.get(a.mobile10).push(a);
  }

  const groups = [...byKey.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const sorted = [...list].sort(byCreated);
      return {
        mobile10: sorted[0].mobile10,
        // The same number on accounts of different parlours is the case that matters most: it was never possible to tell them apart.
        acrossParlours: new Set(sorted.map((a) => a.parlourId)).size > 1,
        // true when the extra leading digits differ (say +44 and +91): possibly different people, not a typo.
        mixedPrefixes: new Set(sorted.map((a) => domesticPrefix(a.extraDigits))).size > 1,
        accounts: sorted,
      };
    })
    .sort((a, b) => a.mobile10.localeCompare(b.mobile10));

  const short = accounts.filter((a) => a.digits.length >= 1 && a.digits.length < 10);
  const noDigits = accounts.filter((a) => a.digits.length === 0);

  const report = {
    totals: {
      accounts: Number(totals.users ?? accounts.length),
      withMobile: Number(totals.with_mobile ?? accounts.length),
      collisionGroups: groups.length,
      accountsInCollisions: groups.reduce((n, g) => n + g.accounts.length, 0),
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
  const maskOne = (a) => ({ ...a, name: maskName(a.name), mobile: maskPhone(a.mobile), email: maskEmail(a.email), digits: maskPhone(a.digits), mobile10: maskPhone(a.mobile10) });
  return {
    ...report,
    groups: report.groups.map((g) => ({ ...g, mobile10: maskPhone(g.mobile10), accounts: g.accounts.map(maskOne) })),
    short: report.short.map(maskOne),
    noDigits: report.noDigits.map(maskOne),
  };
}

// ───────────── printing ─────────────
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const summaryRow = (label, value) => `  ${label} ${'.'.repeat(Math.max(2, 42 - label.length))} ${value}`;

const accountLine = (a, i) =>
  `    ${i + 1}) id ${a.id}  ${a.name || '(no name)'}  ${a.role}${a.isActive ? '' : ' (deactivated)'}  "${a.mobile}"${a.email ? `  ${a.email}` : '  (no email)'}\n` +
  `       parlour: ${a.parlourName} · added ${day(a.createdAt)} · last sign-in ${day(a.lastLoginAt)}`;

function formatReport(report, { masked = false, database = '' } = {}) {
  const t = report.totals;
  const out = [];
  out.push('ACCOUNT MOBILE NUMBER REPORT. Read-only: nothing was changed.');
  out.push(`Database: ${database || '(unknown)'}    Generated: ${new Date().toISOString()}`);
  out.push('Rule checked: one account per mobile number across the whole platform, comparing the last 10 digits only.');
  out.push(masked ? 'Masked: digits, surnames and email names are hidden. Ids are real.' : 'This report contains names, numbers and emails. Run it with  -- --mask  before sharing it.');
  out.push('');
  out.push('SUMMARY');
  out.push(summaryRow('Accounts', `${plural(t.accounts, 'account')} (${t.withMobile} with a mobile number)`));
  out.push(summaryRow('Numbers shared by 2 or more accounts', `${t.collisionGroups} (${plural(t.accountsInCollisions, 'account')} involved)`));
  out.push(summaryRow('Numbers with fewer than 10 digits', t.shortNumbers));
  out.push(summaryRow('Numbers with no digits at all', t.noDigits));
  out.push('');

  if (!report.groups.length) {
    out.push('SHARED NUMBERS: none. Nothing stands in the way of the unique rule.');
  } else {
    out.push(`SHARED NUMBERS (${report.groups.length}). The unique index is NOT created until each group is resolved.`);
    out.push('Until then nobody can sign in by one of these numbers (every account can still sign in by email), and the API refuses a new or changed number that another account has.');
    report.groups.forEach((g, gi) => {
      out.push('');
      out.push(`  Group ${gi + 1} of ${report.groups.length} · last 10 digits ${g.mobile10} · ${g.accounts.length} accounts${g.acrossParlours ? ' · in DIFFERENT parlours' : ' · same parlour'}`);
      if (g.mixedPrefixes) out.push('    ! The numbers differ in extra leading digits (another country code?). These may be different people.');
      g.accounts.forEach((a, i) => out.push(accountLine(a, i)));
    });
  }

  if (report.short.length) {
    out.push('');
    out.push(`SHORT NUMBERS (${report.short.length}). Not shared, but under 10 digits: they stay on the account and are left alone, but cannot be used to sign in. Saving a changed number needs 10 digits.`);
    report.short.forEach((a, i) => out.push(accountLine(a, i)));
  }
  if (report.noDigits.length) {
    out.push('');
    out.push(`NO DIGITS (${report.noDigits.length}). The mobile field holds no digits at all.`);
    report.noDigits.forEach((a, i) => out.push(accountLine(a, i)));
  }

  out.push('');
  out.push('Nothing was merged, edited or deleted. Tell me how you want each group handled; the unique index is created by the next  npm run db:init  once no number is shared.');
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
    const { rows: [totals] } = await client.query(TOTALS_SQL);
    const { rows: [db] } = await client.query('SELECT current_database() AS name');
    await client.query('ROLLBACK');
    const report = buildReport(rows, { mask, totals });
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

module.exports = { SQL, TOTALS_SQL, buildReport, formatReport, digitsOf };
