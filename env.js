const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace_with')) {
  if (isProd) {
    console.error('[config] JWT_SECRET must be set to a random string of at least 32 characters.');
    process.exit(1);
  }
  // Development convenience only: a throw-away secret means sessions reset on every restart.
  jwtSecret = crypto.randomBytes(48).toString('hex');
  console.warn('[config] JWT_SECRET is missing or weak - using a temporary secret. Copy .env.example to .env to persist sessions.');
}

module.exports = {
  nodeEnv,
  isProd,
  port: toInt(process.env.PORT, 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat_application',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
  corsOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === 'true',
  rateLimit: {
    windowMs: toInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    login: toInt(process.env.LOGIN_RATE_LIMIT_MAX, 10),
    register: toInt(process.env.REGISTER_RATE_LIMIT_MAX, 20),
    api: toInt(process.env.API_RATE_LIMIT_MAX, 600),
  },
  presenceGraceMs: toInt(process.env.PRESENCE_GRACE_MS, 3000),
  maxGroupMembers: 200,
  uploadsDir: path.join(__dirname, '..', 'public', 'uploads', 'avatars'),
};
