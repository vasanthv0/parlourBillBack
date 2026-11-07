// The rules of an appointment, as small pure functions: no database, easy to test and easy to change.

/** Statuses in which a visit is still going to happen (or is happening). Everything else is closed. */
const ACTIVE = ['booked', 'waiting', 'in_service'];

/**
 * What a person can do to a visit, and from which statuses.
 *   start    the customer is here and the work begins          booked or waiting → in_service
 *   cancel   it will not happen                                  booked, waiting or in_service → cancelled
 *   noShow   a booking whose time has passed and nobody came     booked → no_show
 *   bill     done: set only by billing, never by a button        booked, waiting or in_service → completed
 */
const ACTIONS = {
  start: { from: ['booked', 'waiting'], to: 'in_service' },
  cancel: { from: ACTIVE, to: 'cancelled' },
  noShow: { from: ['booked'], to: 'no_show' },
  bill: { from: ACTIVE, to: 'completed' },
};

const can = (action, status) => ACTIONS[action].from.includes(status);

const WHY_CLOSED = {
  completed: 'This appointment has already been billed.',
  cancelled: 'This appointment was cancelled.',
  no_show: 'This appointment was marked as a no-show.',
};

/** The message, and its code, for an action that the visit's status does not allow. */
function refusal(action, status) {
  const why = WHY_CLOSED[status];
  if (why) return { code: status === 'completed' ? 'APPOINTMENT_ALREADY_BILLED' : 'APPOINTMENT_CLOSED', message: why };
  const needs = { start: 'booked or waiting', noShow: 'booked', cancel: 'open', bill: 'open' }[action];
  return { code: 'APPOINTMENT_STATE', message: `Only an appointment that is ${needs} can do that, and this one is ${status.replace('_', ' ')}.` };
}

// How far from now a booking may be made: a day back (to write up something that just happened) and a year ahead.
const PAST_LIMIT_MS = 24 * 60 * 60 * 1000;
const FUTURE_LIMIT_MS = 366 * 24 * 60 * 60 * 1000;

/** null when the time is acceptable for a booking, otherwise { code, message }. `now` is the database clock. */
function bookingWindowError(startsAt, now) {
  const at = new Date(startsAt).getTime();
  const base = new Date(now).getTime();
  if (Number.isNaN(at) || Number.isNaN(base)) return { code: 'INVALID_TIME', message: 'Enter a valid date and time' };
  if (at < base - PAST_LIMIT_MS) return { code: 'TIME_TOO_EARLY', message: 'That time is more than a day in the past' };
  if (at > base + FUTURE_LIMIT_MS) return { code: 'TIME_TOO_FAR', message: 'Appointments can be booked up to a year ahead' };
  return null;
}

/** Merges repeats of one service into one line (quantities add up), keeping the order they were first given in. */
function mergeLines(items) {
  const byId = new Map();
  for (const it of items) {
    const have = byId.get(it.serviceId);
    if (have) have.quantity += it.quantity; else byId.set(it.serviceId, { serviceId: it.serviceId, quantity: it.quantity });
  }
  return [...byId.values()];
}

const MIN_DURATION = 5;
const MAX_DURATION = 600;

/**
 * How long the visit takes when nobody typed a length: each service's minutes times its quantity, added up, and kept
 * within the 5 to 600 minutes the database allows (a very long list of services is cut to 10 hours, not refused).
 */
function durationFrom(lines) {
  const total = lines.reduce((sum, l) => sum + Number(l.duration_min) * Number(l.quantity), 0);
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, total));
}

/** The walk-ins in the queue, longest-waiting first, each with their place in line (1 = next). */
function queueOrder(rows) {
  return [...rows]
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || new Date(a.created_at) - new Date(b.created_at))
    .map((row, i) => ({ row, position: i + 1 }));
}

module.exports = { ACTIVE, ACTIONS, can, refusal, bookingWindowError, mergeLines, durationFrom, queueOrder, MIN_DURATION, MAX_DURATION, PAST_LIMIT_MS, FUTURE_LIMIT_MS };
