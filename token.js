const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * Signs a JWT for a user. `tv` (token version) lets the server invalidate every
 * issued token at once (logout, password change) without a blacklist table.
 */
function signToken(user) {
  return jwt.sign({ sub: String(user._id), tv: user.tokenVersion || 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

module.exports = { signToken, verifyToken };
