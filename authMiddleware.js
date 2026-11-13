const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyToken } = require('../utils/token');
const { isObjectId } = require('../utils/validators');

/**
 * Verifies a JWT and loads its user. Shared by the HTTP middleware and the
 * Socket.IO handshake so both transports enforce identical rules.
 */
async function authenticateToken(token) {
  if (!token || typeof token !== 'string') throw new AppError('Authentication required', 401);

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    throw new AppError(err.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Invalid authentication token', 401);
  }

  if (!isObjectId(payload.sub)) throw new AppError('Invalid authentication token', 401);
  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || (user.tokenVersion || 0) !== (payload.tv || 0)) {
    throw new AppError('Session is no longer valid. Please log in again.', 401);
  }
  return user;
}

const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError('Authentication required', 401);
  req.user = await authenticateToken(token);
  next();
});

module.exports = { protect, authenticateToken };
