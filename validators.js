const AppError = require('./AppError');

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Control characters except tab (\u0009), line feed (\u000A) and carriage return (\u000D).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const MAX_MESSAGE_LENGTH = 2000;

const isObjectId = (value) => typeof value === 'string' && OBJECT_ID_RE.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asBody = (body) => (isPlainObject(body) ? body : {});

/** Single-line text: strips control characters and collapses whitespace. */
const cleanLine = (text) => text.replace(CONTROL_RE, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
/** Multi-line text: strips control characters and normalises line endings. */
const cleanMultiline = (text) => text.replace(CONTROL_RE, '').replace(/\r\n?/g, '\n').trim();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fail(errors) {
  throw new AppError('Validation failed', 400, errors);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 bytes long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

function usernameProblem(username) {
  return USERNAME_RE.test(username) ? null : 'Username must be 3-30 characters: letters, numbers, underscores or dots';
}

function validateObjectId(value, field = 'id') {
  if (!isObjectId(value)) fail([{ field, message: `${field} must be a valid id` }]);
  return value;
}

function validateRegister(rawBody) {
  const body = asBody(rawBody);
  const errors = [];
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const uErr = usernameProblem(username);
  if (uErr) errors.push({ field: 'username', message: uErr });
  if (!EMAIL_RE.test(email) || email.length > 254) errors.push({ field: 'email', message: 'Please enter a valid email address' });
  const pErr = passwordProblem(password);
  if (pErr) errors.push({ field: 'password', message: pErr });

  if (errors.length) fail(errors);
  return { username, email, password };
}

function validateLogin(rawBody) {
  const body = asBody(rawBody);
  const errors = [];
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Please enter a valid email address' });
  if (!password) errors.push({ field: 'password', message: 'Password is required' });
  if (errors.length) fail(errors);
  return { email, password };
}

function validateProfile(rawBody) {
  const body = asBody(rawBody);
  const errors = [];
  const result = {};

  if (body.username !== undefined) {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const uErr = usernameProblem(username);
    if (uErr) errors.push({ field: 'username', message: uErr });
    else result.username = username;
  }
  if (body.bio !== undefined) {
    if (typeof body.bio !== 'string') errors.push({ field: 'bio', message: 'Bio must be text' });
    else {
      const bio = cleanLine(body.bio);
      if (bio.length > 160) errors.push({ field: 'bio', message: 'Bio must be at most 160 characters' });
      else result.bio = bio;
    }
  }
  if (body.removeAvatar !== undefined) result.removeAvatar = body.removeAvatar === true || body.removeAvatar === 'true';

  if (body.newPassword !== undefined && body.newPassword !== '') {
    if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
      errors.push({ field: 'currentPassword', message: 'Current password is required to set a new one' });
    }
    const pErr = passwordProblem(body.newPassword);
    if (pErr) errors.push({ field: 'newPassword', message: pErr });
    result.currentPassword = body.currentPassword;
    result.newPassword = body.newPassword;
  }

  if (errors.length) fail(errors);
  return result;
}

function validateMessageContent(content) {
  if (typeof content !== 'string') return { error: 'Message content must be text' };
  const cleaned = cleanMultiline(content);
  if (!cleaned) return { error: 'Message cannot be empty' };
  if (cleaned.length > MAX_MESSAGE_LENGTH) return { error: `Message must be at most ${MAX_MESSAGE_LENGTH} characters` };
  return { value: cleaned };
}

/** Validates a client-originated message (REST or socket). Clients can only send plain text. */
function validateMessage(rawBody) {
  const body = asBody(rawBody);
  const errors = [];

  if (!isObjectId(body.conversationId)) errors.push({ field: 'conversationId', message: 'conversationId must be a valid id' });
  const content = validateMessageContent(body.content);
  if (content.error) errors.push({ field: 'content', message: content.error });
  if (body.messageType !== undefined && body.messageType !== 'text') {
    errors.push({ field: 'messageType', message: 'Only "text" messages can be sent' });
  }
  let clientId;
  if (body.clientId !== undefined) {
    if (typeof body.clientId !== 'string' || !/^[\w-]{1,64}$/.test(body.clientId)) {
      errors.push({ field: 'clientId', message: 'clientId must be 1-64 letters, numbers, dashes or underscores' });
    } else clientId = body.clientId;
  }

  if (errors.length) fail(errors);
  return { conversationId: body.conversationId, content: content.value, clientId };
}

function validateGroup(rawBody, maxMembers) {
  const body = asBody(rawBody);
  const errors = [];

  const groupName = typeof body.groupName === 'string' ? cleanLine(body.groupName) : '';
  if (groupName.length < 2 || groupName.length > 50) errors.push({ field: 'groupName', message: 'Group name must be 2-50 characters' });

  let participantIds = [];
  if (body.participantIds !== undefined) {
    if (!Array.isArray(body.participantIds) || !body.participantIds.every(isObjectId)) {
      errors.push({ field: 'participantIds', message: 'participantIds must be an array of valid user ids' });
    } else if (body.participantIds.length > maxMembers - 1) {
      errors.push({ field: 'participantIds', message: `A group can have at most ${maxMembers} members` });
    } else participantIds = [...new Set(body.participantIds)];
  }

  let isPublic = false;
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== 'boolean') errors.push({ field: 'isPublic', message: 'isPublic must be true or false' });
    else isPublic = body.isPublic;
  }

  if (errors.length) fail(errors);
  return { groupName, participantIds, isPublic };
}

function validateMemberIds(rawBody) {
  const body = asBody(rawBody);
  if (!Array.isArray(body.userIds) || !body.userIds.length || !body.userIds.every(isObjectId)) {
    fail([{ field: 'userIds', message: 'userIds must be a non-empty array of valid user ids' }]);
  }
  return [...new Set(body.userIds)];
}

function validateSearchQuery(query) {
  const q = query && query.q;
  if (typeof q !== 'string' || !q.trim()) fail([{ field: 'q', message: 'Search query "q" is required' }]);
  const cleaned = cleanLine(q);
  if (cleaned.length > 50) fail([{ field: 'q', message: 'Search query must be at most 50 characters' }]);
  return cleaned;
}

function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 50 } = {}) {
  const errors = [];
  const readInt = (value, field, fallback, min, max) => {
    if (value === undefined) return fallback;
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      errors.push({ field, message: `${field} must be a whole number between ${min} and ${max}` });
      return fallback;
    }
    return parsed;
  };
  const page = readInt(query.page, 'page', 1, 1, 100000);
  const limit = readInt(query.limit, 'limit', defaultLimit, 1, maxLimit);
  if (errors.length) fail(errors);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  isObjectId,
  escapeRegex,
  cleanLine,
  cleanMultiline,
  validateObjectId,
  validateRegister,
  validateLogin,
  validateProfile,
  validateMessage,
  validateGroup,
  validateMemberIds,
  validateSearchQuery,
  parsePagination,
};
