const multer = require('multer');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

// Files are kept in memory so they can be verified (magic bytes) before anything touches disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 10 },
});

/** Accepts an optional single "avatar" file on multipart requests; JSON requests pass straight through. */
const avatarUpload = upload.single('avatar');

module.exports = { avatarUpload, MAX_AVATAR_BYTES };
