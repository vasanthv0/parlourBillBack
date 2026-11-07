// Phone numbers are stored exactly as typed. These helpers give the comparable form:
// the last 10 digits, so "+91 98400-12345", "098400 12345" and "9840012345" all match.
// referrers already use the same rule in SQL: right(regexp_replace(contact, '\D', '', 'g'), 10).
// users.mobile_normalised is the same rule, worked out by the database (db/schema.sql, Phase 5).

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

const last10 = (value) => digitsOf(value).slice(-10);

// What may be typed into a mobile number field: digits and + - ( ) spaces, 7 to 20 characters.
const MOBILE_FORMAT = /^[0-9+\-\s()]{7,20}$/;

// A mobile number can be used to sign in only when it has at least this many digits.
const MOBILE_MIN_DIGITS = 10;

/**
 * The 10-digit form of a mobile number used to find and compare accounts, or null when the text is not a usable
 * mobile number (wrong characters, or fewer than 10 digits). Matches users.mobile_normalised in the database exactly.
 */
const normaliseMobile = (value) => {
  const text = String(value ?? '').trim();
  if (!MOBILE_FORMAT.test(text)) return null;
  const digits = digitsOf(text);
  return digits.length >= MOBILE_MIN_DIGITS ? digits.slice(-10) : null;
};

module.exports = { digitsOf, last10, MOBILE_FORMAT, MOBILE_MIN_DIGITS, normaliseMobile };
