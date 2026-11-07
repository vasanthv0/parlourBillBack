const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const rules = require('./appointments.rules');
const reminder = require('./reminder');

// Everything here is scoped by parlour_id, which always comes from the token (auth.parlourId), never from the request.
// Another parlour's appointment, customer, performer or service is simply "not found". Admin and staff share one schedule:
// it is the parlour's calendar, so both see all of it (unlike bills, where staff only see their own).

// ── Reading ───────────────────────────────────────────────────────────────────────────
// `local_date` and `local_time` are the date and the clock time on the parlour's own wall, in its own time zone.
const SELECT = `
  SELECT a.*,
         to_char(a.starts_at AT TIME ZONE p.timezone, 'YYYY-MM-DD') AS local_date,
         to_char(a.starts_at AT TIME ZONE p.timezone, 'HH24:MI') AS local_time,
         pf.name AS performer_name,
         u.name AS created_by_name,
         i.number AS invoice_number, i.created_by AS invoice_created_by
    FROM appointments a
    JOIN parlours p ON p.id = a.parlour_id
    LEFT JOIN performers pf ON pf.id = a.performer_id AND pf.parlour_id = a.parlour_id
    LEFT JOIN users u ON u.id = a.created_by
    LEFT JOIN invoices i ON i.id = a.invoice_id AND i.parlour_id = a.parlour_id`;

const endOf = (startsAt, durationMin) => new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

const mapRow = (a, services, auth) => ({
  id: a.id,
  kind: a.kind,
  status: a.status,
  date: a.local_date,
  time: a.local_time,
  startsAt: new Date(a.starts_at).toISOString(),
  endsAt: endOf(a.starts_at, a.duration_min),
  durationMin: a.duration_min,
  customerId: a.customer_id,
  customerName: a.customer_name,
  customerPhone: a.customer_phone,
  performerId: a.performer_id,
  performerName: a.performer_name ?? null,
  notes: a.notes,
  cancelReason: a.cancel_reason,
  reminderSentAt: a.reminder_sent_at,
  invoiceId: a.invoice_id,
  invoiceNumber: a.invoice_number ?? null,
  // Staff can only open their own bills, so only offer the link to a bill the person may open.
  canOpenInvoice: !!a.invoice_id && (auth.role === 'admin' || a.invoice_created_by === auth.userId),
  createdByName: a.created_by_name ?? null,
  createdAt: a.created_at,
  services: services.map((s) => ({ serviceId: s.service_id, name: s.name, durationMin: s.duration_min, quantity: s.quantity })),
});

/** The services of several appointments in one query, read through the appointment so another parlour's can never come back. */
async function servicesOf(db, parlourId, ids) {
  const byAppointment = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byAppointment;
  const { rows } = await db.query(
    `SELECT s.appointment_id, s.service_id, s.name, s.duration_min, s.quantity
       FROM appointment_services s JOIN appointments a ON a.id = s.appointment_id
      WHERE a.parlour_id = $1 AND s.appointment_id = ANY($2::uuid[]) ORDER BY s.position, s.name`,
    [parlourId, ids]
  );
  for (const r of rows) byAppointment.get(r.appointment_id).push(r);
  return byAppointment;
}

async function shape(db, auth, rows) {
  const services = await servicesOf(db, auth.parlourId, rows.map((r) => r.id));
  return rows.map((r) => mapRow(r, services.get(r.id) ?? [], auth));
}

exports.getWith = async (db, auth, id) => {
  const { rows } = await db.query(`${SELECT} WHERE a.id = $1 AND a.parlour_id = $2`, [id, auth.parlourId]);
  if (!rows[0]) throw AppError.notFound('Appointment not found');
  return (await shape(db, auth, rows))[0];
};
exports.get = (auth, id) => exports.getWith({ query }, auth, id);

/** The parlour's own "today" and time zone (from the database clock), so the screen never guesses from the browser. */
const parlourToday = async (db, parlourId) => {
  const { rows: [p] } = await db.query(
    `SELECT timezone, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today FROM parlours WHERE id = $1`, [parlourId]);
  return { timezone: p.timezone, today: p.today };
};

/**
 * One day on the parlour's calendar: every visit whose date (on the parlour's clock) is that day, any status, earliest first.
 * Also says how many visits from EARLIER days were never billed or closed (a booking nobody turned up for, a walk-in
 * left waiting), so they cannot be forgotten off the bottom of the list.
 */
exports.day = async (auth, { date }) => {
  const { timezone, today } = await parlourToday({ query }, auth.parlourId);
  const day = date ?? today;
  const { rows } = await query(
    `${SELECT} WHERE a.parlour_id = $1 AND (a.starts_at AT TIME ZONE p.timezone)::date = $2::date ORDER BY a.starts_at, a.created_at`,
    [auth.parlourId, day]
  );
  const { rows: [open] } = await query(
    `SELECT COUNT(*)::int AS count, to_char(MIN(a.starts_at AT TIME ZONE p.timezone), 'YYYY-MM-DD') AS oldest
       FROM appointments a JOIN parlours p ON p.id = a.parlour_id
      WHERE a.parlour_id = $1 AND a.status IN ('booked', 'waiting', 'in_service')
        AND (a.starts_at AT TIME ZONE p.timezone)::date < (now() AT TIME ZONE p.timezone)::date`,
    [auth.parlourId]
  );
  return {
    date: day, today, timezone,
    appointments: await shape({ query }, auth, rows),
    earlierOpen: { count: open.count, oldest: open.oldest },
  };
};

/** The walk-in queue: everyone waiting, longest first, with their place in line. Includes anyone left waiting from an earlier day. */
exports.queue = async (auth) => {
  const { rows } = await query(
    `${SELECT} WHERE a.parlour_id = $1 AND a.status = 'waiting' ORDER BY a.starts_at, a.created_at`, [auth.parlourId]);
  const { today } = await parlourToday({ query }, auth.parlourId);
  const shaped = await shape({ query }, auth, rows);
  const order = rules.queueOrder(rows);
  const byId = new Map(shaped.map((s) => [s.id, s]));
  return { today, queue: order.map(({ row, position }) => ({ ...byId.get(row.id), position, fromEarlierDay: byId.get(row.id).date < today })) };
};

// ── The pieces a booking is made of ───────────────────────────────────────────────────
async function resolveLines(db, parlourId, items) {
  const wanted = rules.mergeLines(items);
  const { rows } = await db.query(
    `SELECT id, name, duration_min FROM services WHERE parlour_id = $1 AND is_active AND id = ANY($2::uuid[])`,
    [parlourId, wanted.map((w) => w.serviceId)]
  );
  if (rows.length !== wanted.length) throw AppError.badRequest('One or more services are unavailable. Refresh and try again.', 'SERVICE_UNAVAILABLE');
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((w) => ({ service_id: w.serviceId, name: byId.get(w.serviceId).name, duration_min: byId.get(w.serviceId).duration_min, quantity: w.quantity }));
}

async function resolveCustomer(db, parlourId, customerId) {
  const { rows: [c] } = await db.query(`SELECT id, name, phone FROM customers WHERE id = $1 AND parlour_id = $2`, [customerId, parlourId]);
  if (!c) throw AppError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  return c;
}

async function resolvePerformer(db, parlourId, performerId) {
  const { rows: [p] } = await db.query(`SELECT id, name FROM performers WHERE id = $1 AND parlour_id = $2 AND is_active`, [performerId, parlourId]);
  if (!p) throw AppError.badRequest('This person is no longer available. Refresh and try again.', 'PERFORMER_UNAVAILABLE');
  return p;
}

/** The instant a date and a clock time on the parlour's wall mean, and the database's clock now. */
async function resolveStart(db, parlourId, date, time) {
  const { rows: [r] } = await db.query(
    `SELECT (($2::date + $3::time) AT TIME ZONE timezone) AS starts_at, now() AS now FROM parlours WHERE id = $1`, [parlourId, date, time]);
  return { startsAt: r.starts_at, now: r.now };
}

const hhmm = (d, timezone) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(d));

/**
 * Refuses (409 SLOT_TAKEN) when this person already has a visit that overlaps [startsAt, startsAt + durationMin).
 * Back-to-back is fine: a visit that ends at 3:00 does not clash with one that starts at 3:00. Only visits that occupy time
 * count (booked, and in service); someone waiting in the queue has not been given a slot. The person's row is locked for the
 * rest of the transaction, so two people booking the same slot at once cannot both get it.
 * The screen can retry with allowOverlap: true after the person has seen the message; the server never decides that alone.
 */
async function assertFree(db, { parlourId, performerId, startsAt, durationMin, ignoreId = null }) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`appointments:${performerId}`]);
  const { rows: [clash] } = await db.query(
    `SELECT a.customer_name, a.starts_at, a.duration_min, p.timezone, pf.name AS performer_name
       FROM appointments a JOIN parlours p ON p.id = a.parlour_id JOIN performers pf ON pf.id = a.performer_id
      WHERE a.parlour_id = $1 AND a.performer_id = $2 AND a.status IN ('booked', 'in_service')
        AND ($5::uuid IS NULL OR a.id <> $5)
        AND a.starts_at < $3::timestamptz + make_interval(mins => $4::int)
        AND a.starts_at + make_interval(mins => a.duration_min) > $3::timestamptz
      ORDER BY a.starts_at LIMIT 1`,
    [parlourId, performerId, startsAt, durationMin, ignoreId]
  );
  if (clash) {
    const end = new Date(new Date(clash.starts_at).getTime() + clash.duration_min * 60_000);
    throw AppError.conflict(
      `${clash.performer_name} already has ${clash.customer_name} from ${hhmm(clash.starts_at, clash.timezone)} to ${hhmm(end, clash.timezone)}.`,
      'SLOT_TAKEN'
    );
  }
}

async function writeLines(db, appointmentId, lines) {
  await db.query(`DELETE FROM appointment_services WHERE appointment_id = $1`, [appointmentId]);
  let position = 0;
  for (const l of lines) {
    await db.query(
      `INSERT INTO appointment_services (appointment_id, service_id, name, duration_min, quantity, position) VALUES ($1,$2,$3,$4,$5,$6)`,
      [appointmentId, l.service_id, l.name, l.duration_min, l.quantity, position++]
    );
  }
}

// ── Making and changing ───────────────────────────────────────────────────────────────
/**
 * A booking (a customer chose a time) or a walk-in (they are here now and join the queue).
 * Only the name of the services and their minutes are saved; no price is, because the bill works the price out on the day.
 */
exports.create = async (auth, body) => withTransaction(async (db) => {
  const lines = await resolveLines(db, auth.parlourId, body.items);
  const customer = body.customerId ? await resolveCustomer(db, auth.parlourId, body.customerId) : null;
  const performer = body.performerId ? await resolvePerformer(db, auth.parlourId, body.performerId) : null;

  const isBooking = body.kind === 'booked';
  let startsAt;
  if (isBooking) {
    const at = await resolveStart(db, auth.parlourId, body.date, body.time);
    const bad = rules.bookingWindowError(at.startsAt, at.now);
    if (bad) throw AppError.badRequest(bad.message, bad.code, { time: bad.message });
    startsAt = at.startsAt;
  } else {
    startsAt = (await db.query(`SELECT now() AS now`)).rows[0].now; // the arrival time is the server's clock, never the browser's
  }
  const durationMin = body.durationMin ?? rules.durationFrom(lines);

  // A walk-in who is only waiting has not been given a slot, so there is nothing to clash with until they start.
  if (isBooking && performer && !body.allowOverlap) await assertFree(db, { parlourId: auth.parlourId, performerId: performer.id, startsAt, durationMin });

  const { rows: [row] } = await db.query(
    `INSERT INTO appointments (parlour_id, kind, status, customer_id, customer_name, customer_phone, performer_id, starts_at, duration_min, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [auth.parlourId, body.kind, isBooking ? 'booked' : 'waiting', customer?.id ?? null,
     customer?.name ?? body.customerName ?? 'Walk-in', body.customerPhone ?? customer?.phone ?? null,
     performer?.id ?? null, startsAt, durationMin, body.notes ?? null, auth.userId]
  );
  await writeLines(db, row.id, lines);
  return exports.getWith(db, auth, row.id);
});

/** Locks the appointment for this transaction, so two people changing (or billing) it at once take turns. */
async function lock(db, auth, id) {
  const { rows: [a] } = await db.query(
    `SELECT a.*, now() AS db_now FROM appointments a WHERE a.id = $1 AND a.parlour_id = $2 FOR UPDATE`, [id, auth.parlourId]);
  if (!a) throw AppError.notFound('Appointment not found');
  return a;
}

const refuse = (action, status) => {
  const r = rules.refusal(action, status);
  return AppError.conflict(r.message, r.code);
};

/**
 * Changes a visit that is still open: who, when, what, for how long, or the customer's details. Closed visits (billed,
 * cancelled, no-show) are a record and cannot be changed. Moving a booking asks for a new reminder.
 */
exports.update = async (auth, id, body) => withTransaction(async (db) => {
  const cur = await lock(db, auth, id);
  if (!rules.ACTIVE.includes(cur.status)) throw refuse('cancel', cur.status);

  const next = {
    customer_id: cur.customer_id, customer_name: cur.customer_name, customer_phone: cur.customer_phone,
    performer_id: cur.performer_id, starts_at: cur.starts_at, duration_min: cur.duration_min,
    notes: cur.notes, reminder_sent_at: cur.reminder_sent_at,
  };

  if (body.customerId) {
    const c = await resolveCustomer(db, auth.parlourId, body.customerId);
    Object.assign(next, { customer_id: c.id, customer_name: c.name, customer_phone: c.phone });
  } else if (body.customerId === null) {
    next.customer_id = null; // keep the name and number as written; the booking just no longer points at a saved customer
  }
  if (body.customerName !== undefined) next.customer_name = body.customerName;
  if (body.customerPhone !== undefined) next.customer_phone = body.customerPhone;
  if (body.notes !== undefined) next.notes = body.notes;

  let performerChanged = false;
  if (body.performerId !== undefined && body.performerId !== cur.performer_id) {
    if (body.performerId) await resolvePerformer(db, auth.parlourId, body.performerId);
    next.performer_id = body.performerId;
    performerChanged = true;
  }

  let timeChanged = false;
  if (body.date) {
    if (cur.kind !== 'booked') throw AppError.badRequest('A walk-in has no booked time to move', 'NOT_A_BOOKING', { time: 'A walk-in has no booked time to move' });
    if (cur.status !== 'booked') throw AppError.badRequest('An appointment that has started cannot be moved', 'ALREADY_STARTED', { time: 'This appointment has already started' });
    const at = await resolveStart(db, auth.parlourId, body.date, body.time);
    const bad = rules.bookingWindowError(at.startsAt, at.now);
    if (bad) throw AppError.badRequest(bad.message, bad.code, { time: bad.message });
    timeChanged = new Date(at.startsAt).getTime() !== new Date(cur.starts_at).getTime();
    next.starts_at = at.startsAt;
    if (timeChanged) next.reminder_sent_at = null; // the old reminder named the old time
  }

  let lines = null;
  if (body.items) lines = await resolveLines(db, auth.parlourId, body.items);
  if (body.durationMin !== undefined) next.duration_min = body.durationMin;
  else if (lines) next.duration_min = rules.durationFrom(lines);

  const occupies = cur.status === 'in_service' || cur.status === 'booked';
  const moved = performerChanged || timeChanged || next.duration_min !== cur.duration_min;
  if (occupies && next.performer_id && moved && !body.allowOverlap) {
    await assertFree(db, { parlourId: auth.parlourId, performerId: next.performer_id, startsAt: next.starts_at, durationMin: next.duration_min, ignoreId: id });
  }

  await db.query(
    `UPDATE appointments SET customer_id = $3, customer_name = $4, customer_phone = $5, performer_id = $6, starts_at = $7,
            duration_min = $8, notes = $9, reminder_sent_at = $10, updated_at = now()
      WHERE id = $1 AND parlour_id = $2`,
    [id, auth.parlourId, next.customer_id, next.customer_name, next.customer_phone, next.performer_id, next.starts_at,
     next.duration_min, next.notes, next.reminder_sent_at]
  );
  if (lines) await writeLines(db, id, lines);
  return exports.getWith(db, auth, id);
});

/**
 * The customer is here and the work begins. The visit moves to "in service", takes the database's clock as its start, and
 * (for a walk-in) is given a person if it had none. A person already busy then is refused like any other double booking.
 */
exports.start = async (auth, id, { performerId, allowOverlap }) => withTransaction(async (db) => {
  const cur = await lock(db, auth, id);
  if (!rules.can('start', cur.status)) throw refuse('start', cur.status);

  const who = performerId === undefined || performerId === null ? cur.performer_id : performerId;
  if (who && who !== cur.performer_id) await resolvePerformer(db, auth.parlourId, who);
  if (who && !allowOverlap) await assertFree(db, { parlourId: auth.parlourId, performerId: who, startsAt: cur.db_now, durationMin: cur.duration_min, ignoreId: id });

  await db.query(
    `UPDATE appointments SET status = 'in_service', performer_id = $3, starts_at = now(), updated_at = now() WHERE id = $1 AND parlour_id = $2`,
    [id, auth.parlourId, who]
  );
  return exports.getWith(db, auth, id);
});

/** It will not happen. The visit stays on record as cancelled, with the reason if one was given. */
exports.cancel = async (auth, id, { reason }) => withTransaction(async (db) => {
  const cur = await lock(db, auth, id);
  if (!rules.can('cancel', cur.status)) throw refuse('cancel', cur.status);
  await db.query(
    `UPDATE appointments SET status = 'cancelled', cancel_reason = $3, updated_at = now() WHERE id = $1 AND parlour_id = $2`,
    [id, auth.parlourId, reason ?? null]
  );
  return exports.getWith(db, auth, id);
});

/** A booking whose time has come and gone and nobody turned up. It cannot be marked early. */
exports.noShow = async (auth, id) => withTransaction(async (db) => {
  const cur = await lock(db, auth, id);
  if (!rules.can('noShow', cur.status)) throw refuse('noShow', cur.status);
  if (new Date(cur.starts_at) > new Date(cur.db_now)) {
    throw AppError.conflict('This appointment has not reached its time yet, so it cannot be a no-show. Cancel it instead.', 'TOO_EARLY_FOR_NO_SHOW');
  }
  await db.query(`UPDATE appointments SET status = 'no_show', updated_at = now() WHERE id = $1 AND parlour_id = $2`, [id, auth.parlourId]);
  return exports.getWith(db, auth, id);
});

// ── Reminder (a WhatsApp link; nothing is sent automatically) ─────────────────────────
exports.reminder = async (auth, id, { phone }) => {
  const a = await exports.get(auth, id);
  if (a.status !== 'booked') throw AppError.conflict('Only a booked appointment can be reminded.', 'NOT_REMINDABLE');
  if (new Date(a.startsAt) <= new Date()) throw AppError.conflict('This appointment time has passed, so there is nothing to remind.', 'NOT_REMINDABLE');
  const { rows: [p] } = await query(`SELECT name, phone, timezone FROM parlours WHERE id = $1`, [auth.parlourId]);
  return reminder.build({
    phone: phone || a.customerPhone,
    customerName: a.customerName, startsAt: a.startsAt, services: a.services, performerName: a.performerName,
    parlour: { name: p.name, phone: p.phone, timezone: p.timezone },
  });
};

/** Records that someone opened the reminder. It says the message was opened in WhatsApp, not that it was sent or read. */
exports.markReminded = async (auth, id) => {
  const { rowCount } = await query(
    `UPDATE appointments SET reminder_sent_at = now(), updated_at = now() WHERE id = $1 AND parlour_id = $2 AND status = 'booked'`,
    [id, auth.parlourId]
  );
  if (!rowCount) {
    await exports.get(auth, id); // 404 if it is not this parlour's
    throw AppError.conflict('Only a booked appointment can be reminded.', 'NOT_REMINDABLE');
  }
  return exports.get(auth, id);
};
