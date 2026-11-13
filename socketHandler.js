const { Server } = require('socket.io');
const config = require('../config/env');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AppError = require('../utils/AppError');
const { authenticateToken } = require('../middleware/authMiddleware');
const { validateMessage, validateObjectId } = require('../utils/validators');
const { serializeMessage, serializePublicUser } = require('../utils/serializers');
const chat = require('../services/chatService');

/**
 * Socket.IO layer.
 *
 * Rooms:
 *   user:<userId>  every socket (tab/device) of one user
 *   conv:<convId>  every connected participant of one conversation
 *
 * Client -> server (all accept an optional acknowledgement callback):
 *   message:send {conversationId, content, clientId}   persists, then broadcasts
 *   message:read {conversationId}                       marks the conversation as read
 *   typing:start / typing:stop {conversationId}
 *   room:join / room:leave {conversationId}             public group rooms
 *
 * Server -> client:
 *   message:new, message:delivered, message:read, message:deleted, typing,
 *   presence:snapshot, presence:update, conversation:new, room:member_joined,
 *   room:member_left, room:members_added, user:updated
 */

let io = null;
const online = new Map(); // userId -> Set<socketId>
const offlineTimers = new Map(); // userId -> Timeout (grace period before "offline")

const convRoom = (id) => `conv:${id}`;
const userRoom = (id) => `user:${id}`;
const isUserOnline = (userId) => online.has(String(userId));

/* ---------------------------------------------------------------- helpers */

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function errorPayload(err) {
  if (err instanceof AppError) {
    return { ok: false, status: err.statusCode, error: err.message, errors: err.details };
  }
  console.error('[socket] unexpected error:', err);
  return { ok: false, status: 500, error: 'Something went wrong' };
}

/** Wraps a socket handler: catches errors and always answers through the ack callback. */
function handle(fn) {
  return async (payload, ack) => {
    try {
      const result = await fn(payload);
      reply(ack, { ok: true, ...(result || {}) });
    } catch (err) {
      reply(ack, errorPayload(err));
    }
  };
}

/** Sliding-window limiter stored on the socket so one noisy client cannot flood the server. */
function allow(socket, key, max, windowMs) {
  const now = Date.now();
  const hits = (socket.data.hits ||= {});
  const recent = (hits[key] || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits[key] = recent;
    return false;
  }
  recent.push(now);
  hits[key] = recent;
  return true;
}

async function conversationIdsOf(userId) {
  const rows = await Conversation.find({ participants: userId }).select('_id');
  return rows.map((row) => String(row._id));
}

async function broadcastToContacts(userId, event, payload) {
  const ids = await conversationIdsOf(userId);
  if (ids.length) io.to(ids.map(convRoom)).emit(event, payload);
}

/* --------------------------------------------------------------- presence */

async function markOnline(userId) {
  await User.updateOne({ _id: userId }, { $set: { status: 'online' } });
  await broadcastToContacts(userId, 'presence:update', { userId, status: 'online', lastSeen: null });
}

async function markOffline(userId) {
  const lastSeen = new Date();
  await User.updateOne({ _id: userId }, { $set: { status: 'offline', lastSeen } });
  await broadcastToContacts(userId, 'presence:update', { userId, status: 'offline', lastSeen });
}

function trackConnection(socket) {
  const userId = String(socket.data.user._id);
  const sockets = online.get(userId) || new Set();
  const wasOnline = sockets.size > 0;
  sockets.add(socket.id);
  online.set(userId, sockets);

  const pending = offlineTimers.get(userId);
  if (pending) {
    // The user reconnected (e.g. page refresh) before the grace period ended: stay "online".
    clearTimeout(pending);
    offlineTimers.delete(userId);
    return false;
  }
  return !wasOnline; // true when this is the user's first live connection
}

function trackDisconnection(socket) {
  const userId = String(socket.data.user._id);
  const sockets = online.get(userId);
  if (!sockets) return;
  sockets.delete(socket.id);
  if (sockets.size) return;

  online.delete(userId);
  const timer = setTimeout(() => {
    offlineTimers.delete(userId);
    if (!isUserOnline(userId)) markOffline(userId).catch((err) => console.error('[socket] markOffline failed:', err.message));
  }, config.presenceGraceMs);
  offlineTimers.set(userId, timer);
}

/** Which of the user's contacts (people sharing a conversation) are online right now. */
async function onlineContactsOf(userId, conversations) {
  const contacts = new Set();
  conversations.forEach((c) => c.participants.forEach((p) => contacts.add(String(p))));
  contacts.delete(String(userId));
  return [...contacts].filter(isUserOnline);
}

/** Everything undelivered to this user becomes "delivered" the moment they connect. */
async function deliverPending(user, conversations) {
  if (!conversations.length) return;
  const pending = await Message.find({
    conversation: { $in: conversations.map((c) => c._id) },
    sender: { $ne: user._id },
    deliveredTo: { $ne: user._id },
    messageType: 'text',
  }).select('_id conversation');
  if (!pending.length) return;

  await Message.updateMany({ _id: { $in: pending.map((m) => m._id) } }, { $addToSet: { deliveredTo: user._id } });
  const grouped = new Map();
  pending.forEach((m) => {
    const key = String(m.conversation);
    grouped.set(key, [...(grouped.get(key) || []), String(m._id)]);
  });
  grouped.forEach((messageIds, conversationId) => {
    io.to(convRoom(conversationId)).emit('message:delivered', { conversationId, messageIds, userIds: [String(user._id)] });
  });
}

/* ------------------------------------------------- exported publish API */

/**
 * Broadcasts a saved message to its conversation room and records delivery for
 * recipients who are online. Used by both the socket handler and the REST API.
 */
async function publishMessage(conversation, dto, { exceptSocketId } = {}) {
  if (!io) return dto;
  const conversationId = String(conversation._id || conversation.id);

  let operator = io.to(convRoom(conversationId));
  if (exceptSocketId) operator = operator.except(exceptSocketId);
  operator.emit('message:new', dto);

  if (dto.messageType === 'text') {
    const recipients = conversation.participants.map(String).filter((id) => id !== dto.sender.id && isUserOnline(id));
    if (recipients.length) {
      await Message.updateOne({ _id: dto.id }, { $addToSet: { deliveredTo: { $each: recipients } } });
      dto.deliveredTo = [...new Set([...dto.deliveredTo, ...recipients])];
      io.to(convRoom(conversationId)).emit('message:delivered', { conversationId, messageIds: [dto.id], userIds: recipients });
    }
  }
  return dto;
}

/** Subscribes every live socket of the given users to a conversation room. */
function joinUsersToConversation(userIds, conversationId) {
  if (!io) return;
  userIds.forEach((id) => io.in(userRoom(id)).socketsJoin(convRoom(conversationId)));
}

/** Unsubscribes every live socket of the given users from a conversation room (used when someone leaves). */
function removeUsersFromConversation(userIds, conversationId) {
  if (!io) return;
  userIds.forEach((id) => io.in(userRoom(id)).socketsLeave(convRoom(conversationId)));
}

/** Tells newly added members about a group so it appears in their sidebar immediately. */
function notifyConversationCreated(userIds, conversationId, conversationDTO) {
  if (!io) return;
  joinUsersToConversation(userIds, conversationId);
  userIds.forEach((id) => io.to(userRoom(id)).emit('conversation:new', conversationDTO));
}

function emitToConversation(conversationId, event, payload) {
  if (io) io.to(convRoom(conversationId)).emit(event, payload);
}

async function publishUserUpdate(user) {
  if (!io) return;
  await broadcastToContacts(user._id, 'user:updated', serializePublicUser(user));
}

function disconnectUser(userId) {
  if (io) io.in(userRoom(userId)).disconnectSockets(true);
}

/** After a restart no socket survives, so nobody can still be "online" in the database. */
async function resetPresence() {
  await User.updateMany({ status: 'online' }, { $set: { status: 'offline', lastSeen: new Date() } });
}

/* --------------------------------------------------------- socket events */

async function ensureMember(socket, conversationId) {
  validateObjectId(conversationId, 'conversationId');
  if (socket.rooms.has(convRoom(conversationId))) return;
  await chat.getConversationForUser(conversationId, socket.data.user._id); // throws 404 / 403
  socket.join(convRoom(conversationId));
}

function registerHandlers(socket) {
  const user = socket.data.user;
  const userId = String(user._id);

  socket.on(
    'message:send',
    handle(async (payload) => {
      if (!allow(socket, 'send', 20, 10000)) throw new AppError('You are sending messages too quickly', 429);
      const { conversationId, content, clientId } = validateMessage(payload);
      const conversation = await chat.getConversationForUser(conversationId, user._id);
      const { message, duplicate } = await chat.createMessage({ conversation, senderId: user._id, content, clientId });
      const dto = serializeMessage(message);
      if (!duplicate) await publishMessage(conversation, dto, { exceptSocketId: socket.id });
      return { message: dto };
    })
  );

  socket.on(
    'message:read',
    handle(async (payload) => {
      await ensureMember(socket, payload && payload.conversationId);
      const count = await chat.markConversationRead(payload.conversationId, user._id);
      if (count) {
        io.to(convRoom(payload.conversationId)).emit('message:read', {
          conversationId: payload.conversationId,
          userId,
          readAt: new Date().toISOString(),
        });
      }
      return { count };
    })
  );

  const typing = (isTyping) =>
    handle(async (payload) => {
      if (!allow(socket, 'typing', 40, 10000)) return {};
      await ensureMember(socket, payload && payload.conversationId);
      socket.to(convRoom(payload.conversationId)).emit('typing', {
        conversationId: payload.conversationId,
        userId,
        username: user.username,
        isTyping,
      });
      return {};
    });
  socket.on('typing:start', typing(true));
  socket.on('typing:stop', typing(false));

  socket.on(
    'room:join',
    handle(async (payload) => {
      validateObjectId(payload && payload.conversationId, 'conversationId');
      const { conversation, joined, systemMessage } = await chat.joinGroup(payload.conversationId, user._id);
      joinUsersToConversation([userId], conversation._id);
      if (joined) {
        emitToConversation(conversation._id, 'room:member_joined', { conversationId: String(conversation._id), user: serializePublicUser(user) });
        await publishMessage(conversation, serializeMessage(systemMessage));
      }
      return { conversation: await chat.getConversationDTO(conversation._id, user._id), joined };
    })
  );

  socket.on(
    'room:leave',
    handle(async (payload) => {
      validateObjectId(payload && payload.conversationId, 'conversationId');
      const result = await chat.leaveGroup(payload.conversationId, user._id);
      if (!result.deleted) {
        emitToConversation(result.conversation._id, 'room:member_left', {
          conversationId: String(result.conversation._id),
          userId,
          groupAdmin: result.conversation.groupAdmin ? String(result.conversation.groupAdmin) : null,
        });
        await publishMessage(result.conversation, serializeMessage(result.systemMessage));
      }
      removeUsersFromConversation([userId], payload.conversationId);
      return {};
    })
  );
}

async function onConnection(socket) {
  const user = socket.data.user;
  const userId = String(user._id);

  registerHandlers(socket); // synchronous, so events sent right after connecting are never missed
  socket.join(userRoom(userId));
  const firstConnection = trackConnection(socket);
  socket.on('disconnect', () => trackDisconnection(socket));

  try {
    const conversations = await Conversation.find({ participants: user._id }).select('participants');
    conversations.forEach((c) => socket.join(convRoom(c._id)));

    socket.emit('presence:snapshot', { online: await onlineContactsOf(userId, conversations) });
    if (firstConnection) await markOnline(userId);
    await deliverPending(user, conversations);
  } catch (err) {
    console.error('[socket] connection setup failed:', err.message);
  }
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e5,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  // Secure handshake: the JWT must be valid and not revoked before a socket is accepted.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      socket.data.user = await authenticateToken(token);
      next();
    } catch (err) {
      const rejection = new Error(err.message || 'Authentication failed');
      rejection.data = { code: err.statusCode || 401 };
      next(rejection);
    }
  });

  io.on('connection', onConnection);
  return io;
}

module.exports = {
  initSocket,
  publishMessage,
  joinUsersToConversation,
  removeUsersFromConversation,
  notifyConversationCreated,
  emitToConversation,
  publishUserUpdate,
  disconnectUser,
  resetPresence,
  isUserOnline,
};
