const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/env');

const URL_PREFIX = '/uploads/avatars/';
const FILE_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

/** Detects the real image type from the file signature (never trusts the client MIME type). */
function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

/** Saves a validated avatar and returns its public URL path. Returns null for non-images. */
async function saveAvatar(buffer) {
  const type = detectImageType(buffer);
  if (!type) return null;
  await fs.mkdir(config.uploadsDir, { recursive: true });
  const fileName = `${crypto.randomBytes(16).toString('hex')}.${type}`;
  await fs.writeFile(path.join(config.uploadsDir, fileName), buffer, { flag: 'wx' });
  return `${URL_PREFIX}${fileName}`;
}

/** Deletes a previously uploaded avatar. Ignores external URLs and anything not created by saveAvatar. */
async function removeAvatar(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith(URL_PREFIX)) return;
  const fileName = urlPath.slice(URL_PREFIX.length);
  if (!FILE_NAME_RE.test(fileName)) return;
  try {
    await fs.unlink(path.join(config.uploadsDir, fileName));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { detectImageType, saveAvatar, removeAvatar };
