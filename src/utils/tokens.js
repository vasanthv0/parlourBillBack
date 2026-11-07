const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signAccessToken(user) {
  return jwt.sign({ role: user.role, pid: user.parlour_id }, env.auth.accessSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: env.auth.accessTtl,
    issuer: env.auth.issuer,
    audience: env.auth.audience,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.auth.accessSecret, {
    algorithms: ['HS256'],
    issuer: env.auth.issuer,
    audience: env.auth.audience,
  });
}

// Refresh tokens are opaque random strings. Only their SHA-256 hash is stored,
// so a database leak does not expose usable tokens.
const generateRefreshToken = () => crypto.randomBytes(48).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashToken };
