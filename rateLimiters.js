const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const AppError = require('../utils/AppError');

const handler = (message) => (req, res, next) => next(new AppError(message, 429));

const base = {
  windowMs: config.rateLimit.windowMs,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/** Brute-force protection: only FAILED login attempts count towards the limit. */
const loginLimiter = rateLimit({
  ...base,
  limit: config.rateLimit.login,
  skipSuccessfulRequests: true,
  handler: handler('Too many failed login attempts. Please try again later.'),
});

const registerLimiter = rateLimit({
  ...base,
  limit: config.rateLimit.register,
  handler: handler('Too many accounts created from this address. Please try again later.'),
});

/** Generous global limiter that stops a single client from hammering the API. */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  limit: config.rateLimit.api,
  handler: handler('Too many requests. Please slow down.'),
});

module.exports = { loginLimiter, registerLimiter, apiLimiter };
