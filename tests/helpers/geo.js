// Shared by the attendance tests: a salon location and readings placed at known distances from it.
const { EARTH_RADIUS_M } = require('../../src/modules/attendance/attendance.geo');

const SALON = { latitude: 13.0827, longitude: 80.2707, radiusM: 100, maxAccuracyM: 50 }; // Chennai Central

/** A point `north` / `east` metres from the salon (small-distance approximation, plenty for tests). */
function offset(north, east) {
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  return {
    latitude: SALON.latitude + north / mPerDegLat,
    longitude: SALON.longitude + east / (mPerDegLat * Math.cos((SALON.latitude * Math.PI) / 180)),
  };
}

/** A GPS reading `north`/`east` metres from the salon, as the browser would send it. */
const readingAt = (north, east, accuracy = 10, capturedAt = Date.now()) => ({ ...offset(north, east), accuracy, capturedAt });

module.exports = { SALON, offset, readingAt };
