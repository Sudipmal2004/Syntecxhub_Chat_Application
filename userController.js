const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { signToken } = require('../utils/token');
const { saveAvatar, removeAvatar } = require('../utils/avatarStorage');
const { validateProfile, validateSearchQuery, parsePagination, escapeRegex } = require('../utils/validators');
const { serializePublicUser, serializeCurrentUser } = require('../utils/serializers');
const { publishUserUpdate } = require('../sockets/socketHandler');

/** GET /api/users?page=&limit= - every other registered user, alphabetically. */
const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const filter = { _id: { $ne: req.user._id } };

  const [users, total] = await Promise.all([
    User.find(filter).sort({ usernameKey: 1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  res.json({
    success: true,
    users: users.map(serializePublicUser),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

/** GET /api/users/search?q= - case-insensitive username search. */
const searchUsers = asyncHandler(async (req, res) => {
  const q = validateSearchQuery(req.query);
  const users = await User.find({
    _id: { $ne: req.user._id },
    usernameKey: { $regex: escapeRegex(q.toLowerCase()) }, // escaped: user input is never treated as a pattern
  })
    .sort({ usernameKey: 1 })
    .limit(20);

  res.json({ success: true, users: users.map(serializePublicUser) });
});

/** GET /api/users/:id */
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  res.json({ success: true, user: serializePublicUser(user) });
});

/** PUT /api/users/profile - username, bio, avatar upload/removal and optional password change. */
const updateProfile = asyncHandler(async (req, res) => {
  const changes = validateProfile(req.body);
  const user = await User.findById(req.user._id).select('+password +tokenVersion');

  if (changes.username && changes.username !== user.username) {
    const taken = await User.exists({ usernameKey: changes.username.toLowerCase(), _id: { $ne: user._id } });
    if (taken) throw new AppError('Username is already taken', 409, [{ field: 'username', message: 'Username is already taken' }]);
    user.username = changes.username;
  }
  if (changes.bio !== undefined) user.bio = changes.bio;

  const previousAvatar = user.profilePicture;
  if (req.file) {
    const url = await saveAvatar(req.file.buffer);
    if (!url) throw new AppError('Avatar must be a JPEG, PNG, WebP or GIF image', 400, [{ field: 'avatar', message: 'Unsupported image type' }]);
    user.profilePicture = url;
  } else if (changes.removeAvatar) {
    user.profilePicture = '';
  }

  let token;
  if (changes.newPassword) {
    if (!(await user.comparePassword(changes.currentPassword))) {
      throw new AppError('Current password is incorrect', 400, [{ field: 'currentPassword', message: 'Current password is incorrect' }]);
    }
    user.password = changes.newPassword;
    user.tokenVersion += 1; // signs out every other session
    token = true;
  }

  await user.save();
  if (user.profilePicture !== previousAvatar) await removeAvatar(previousAvatar);
  if (token) token = signToken(user);

  publishUserUpdate(user).catch((err) => console.error('[socket] user update broadcast failed:', err.message));
  res.json({ success: true, user: serializeCurrentUser(user), ...(token && { token }) });
});

module.exports = { listUsers, searchUsers, getUser, updateProfile };
