const router = require('express').Router();
const env = require('../../config/env');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const requireXhr = require('../../middleware/requireXhr');
const { authLimiter } = require('../../middleware/rateLimit');
const schemas = require('./auth.schemas');
const service = require('./auth.service');

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.cookie.secure,
  sameSite: env.cookie.sameSite,
  path: env.cookie.path,
});
const setRefreshCookie = (res, token) =>
  res.cookie(env.cookie.name, token, { ...cookieOptions(), maxAge: env.auth.refreshTtlDays * 86_400_000 });
const clearRefreshCookie = (res) => res.clearCookie(env.cookie.name, cookieOptions());
const metaOf = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// The refresh token travels only in an httpOnly cookie; the JSON body carries the short-lived access token.
const sendSession = (res, session, status = 200) => {
  setRefreshCookie(res, session.refreshToken);
  res.status(status).json({ data: { accessToken: session.accessToken, user: session.user } });
};

router.post('/login', authLimiter, validate(schemas.login), async (req, res) => {
  sendSession(res, await service.login(req.valid.body, metaOf(req)));
});

router.post('/refresh', requireXhr, async (req, res) => {
  try {
    sendSession(res, await service.refresh(req.cookies[env.cookie.name], metaOf(req)));
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
});

router.post('/logout', requireXhr, async (req, res) => {
  await service.logout(req.cookies[env.cookie.name]);
  clearRefreshCookie(res);
  res.status(204).end();
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ data: await service.me(req.auth.userId) });
});

router.post('/change-password', authenticate, validate(schemas.changePassword), async (req, res) => {
  sendSession(res, await service.changePassword(req.auth.userId, req.valid.body, metaOf(req)));
});

module.exports = router;
