const bcrypt = require('bcrypt');
const User = require('../models/User');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { signToken } = require('../utils/token');
const { validateRegister, validateLogin } = require('../utils/validators');
const { serializeCurrentUser } = require('../utils/serializers');
const { disconnectUser } = require('../sockets/socketHandler');

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const dummyHash = bcrypt.hash('not-a-real-password', config.bcryptRounds);

/** POST /api/auth/register */
const register = asyncHandler(async (req, res) => {
  const { username, email, password } = validateRegister(req.body);

  const existing = await User.findOne({ $or: [{ email }, { usernameKey: username.toLowerCase() }] }).select('email');
  if (existing) {
    const field = existing.email === email ? 'email' : 'username';
    const message = field === 'email' ? 'Email is already registered' : 'Username is already taken';
    throw new AppError(message, 409, [{ field, message }]);
  }

  const user = await User.create({ username, email, password }); // password is hashed by the model hook
  res.status(201).json({ success: true, token: signToken(user), user: serializeCurrentUser(user) });
});

/** POST /api/auth/login */
const login = asyncHandler(async (req, res) => {
  const { email, password } = validateLogin(req.body);

  const user = await User.findOne({ email }).select('+password +tokenVersion');
  const valid = user ? await user.comparePassword(password) : await bcrypt.compare(password, await dummyHash);
  if (!valid) throw new AppError('Invalid email or password', 401);

  res.json({ success: true, token: signToken(user), user: serializeCurrentUser(user) });
});

/** POST /api/auth/logout - revokes every token issued so far and closes the user's sockets. */
const logout = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  disconnectUser(req.user._id);
  res.json({ success: true, message: 'Logged out successfully' });
});

/** GET /api/auth/me */
const me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: serializeCurrentUser(req.user) });
});

module.exports = { register, login, logout, me };
