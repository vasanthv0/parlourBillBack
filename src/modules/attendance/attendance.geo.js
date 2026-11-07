// Pure geofence logic: no database, no Express. Everything here can be tested on its own.
//
// The browser sends a reading ({ latitude, longitude, accuracy, capturedAt }). This file decides what to do
// with it. The distance is always calculated here, on the server, with the Haversine formula, so a modified
// web app cannot claim to be closer than it is.

const EARTH_RADIUS_M = 6371008.8; // IUGG mean Earth radius, in metres

const DEFAULT_RADIUS_M = 100;       // geofence radius when the admin has not chosen one
const DEFAULT_MAX_ACCURACY_M = 50;  // worst GPS accuracy we will accept when the admin has not chosen one
const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000; // a reading must be stamped within 5 minutes of server time

const toRad = (deg) => (deg * Math.PI) / 180;
const round1 = (n) => Math.round(n * 10) / 10;

/** Great-circle distance between two latitude/longitude points, in metres (Haversine formula). */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  // Rounding can push `a` a hair above 1 for opposite points; clamp so asin never returns NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decide whether a reading is good enough to act on.
 *
 *   reading  { latitude, longitude, accuracy (metres), capturedAt (epoch ms) }
 *   settings { latitude, longitude, radiusM, maxAccuracyM }   the salon
 *
 * verdict:
 *   'stale'        the reading's timestamp is far from server time (old payload replayed, or a wrong device clock)
 *   'out_of_range' the device is outside the radius
 *   'inaccurate'   the GPS fix is too vague to say whether the device is inside
 *   'ok'           inside the radius with an acceptable fix
 *
 * A vague fix (accuracy worse than the limit) is only called "inaccurate" when the device *might* be inside.
 * If it is outside even on the most generous reading (distance minus accuracy still beyond the radius),
 * it is plainly out of range, and saying so is more useful than asking for a better signal.
 */
function assessReading(reading, settings, nowMs = Date.now()) {
  const distance = haversineMeters(reading.latitude, reading.longitude, settings.latitude, settings.longitude);
  const withinRadius = distance <= settings.radiusM;

  let verdict;
  if (Math.abs(nowMs - reading.capturedAt) > MAX_CLOCK_DRIFT_MS) {
    verdict = 'stale';
  } else if (reading.accuracy > settings.maxAccuracyM) {
    verdict = distance - reading.accuracy > settings.radiusM ? 'out_of_range' : 'inaccurate';
  } else {
    verdict = withinRadius ? 'ok' : 'out_of_range';
  }

  return {
    verdict,
    withinRadius,
    distanceM: round1(distance),
    radiusM: settings.radiusM,
    accuracyM: round1(reading.accuracy),
    maxAccuracyM: settings.maxAccuracyM,
  };
}

module.exports = {
  EARTH_RADIUS_M,
  DEFAULT_RADIUS_M,
  DEFAULT_MAX_ACCURACY_M,
  MAX_CLOCK_DRIFT_MS,
  haversineMeters,
  assessReading,
};
