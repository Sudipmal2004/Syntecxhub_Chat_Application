const Message = require('../models/Message');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const chat = require('../services/chatService');
const { validateMessage, validateObjectId, isObjectId } = require('../utils/validators');
const { serializeMessage } = require('../utils/serializers');
const realtime = require('../sockets/socketHandler');

/** POST /api/messages - saves a message and pushes it to connected participants in real time. */
const sendMessage = asyncHandler(async (req, res) => {
  const { conversationId, content, clientId } = validateMessage(req.body);
  const conversation = await chat.getConversationForUser(conversationId, req.user._id);

  const { message, duplicate } = await chat.createMessage({ conversation, senderId: req.user._id, content, clientId });
  const dto = serializeMessage(message);
  if (!duplicate) await realtime.publishMessage(conversation, dto);

  res.status(duplicate ? 200 : 201).json({ success: true, message: dto });
});

/**
 * GET /api/messages/:conversationId
 *   ?limit=30          page size (1-100)
 *   ?before=<messageId> older messages than this one (scroll back through history)
 *   ?after=<messageId>  newer messages than this one (catch up after a reconnect)
 * Messages are always returned oldest-first.
 */
const getMessages = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  await chat.getConversationForUser(conversationId, req.user._id);

  const { before, after } = req.query;
  let limit = 30;
  if (req.query.limit !== undefined) {
    limit = typeof req.query.limit === 'string' && /^\d+$/.test(req.query.limit) ? parseInt(req.query.limit, 10) : 0;
    if (limit < 1 || limit > 100) throw new AppError('Validation failed', 400, [{ field: 'limit', message: 'limit must be a whole number between 1 and 100' }]);
  }
  for (const [field, value] of [['before', before], ['after', after]]) {
    if (value !== undefined && !isObjectId(value)) throw new AppError('Validation failed', 400, [{ field, message: `${field} must be a valid message id` }]);
  }
  if (before && after) throw new AppError('Use either "before" or "after", not both', 400);

  const filter = { conversation: conversationId };
  let messages;
  let hasMore;
  let nextCursor = null;

  if (after) {
    filter._id = { $gt: after };
    const rows = await Message.find(filter).sort({ _id: 1 }).limit(limit + 1).populate('sender', chat.SENDER_FIELDS);
    hasMore = rows.length > limit;
    messages = rows.slice(0, limit);
    nextCursor = messages.length ? String(messages[messages.length - 1]._id) : null;
  } else {
    if (before) filter._id = { $lt: before };
    const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).populate('sender', chat.SENDER_FIELDS);
    hasMore = rows.length > limit;
    messages = rows.slice(0, limit).reverse();
    nextCursor = messages.length ? String(messages[0]._id) : null;
  }

  res.json({ success: true, messages: messages.map(serializeMessage), pagination: { limit, hasMore, nextCursor } });
});

/** PUT /api/messages/:id/read */
const markRead = asyncHandler(async (req, res) => {
  const message = await Message.findById(req.params.id);
  if (!message) throw new AppError('Message not found', 404);
  await chat.getConversationForUser(message.conversation, req.user._id);

  if (message.messageType === 'text' && !message.readBy.some((id) => String(id) === String(req.user._id))) {
    await Message.updateOne({ _id: message._id }, { $addToSet: { readBy: req.user._id, deliveredTo: req.user._id } });
    realtime.emitToConversation(message.conversation, 'message:read', {
      conversationId: String(message.conversation),
      userId: String(req.user._id),
      messageIds: [String(message._id)],
      readAt: new Date().toISOString(),
    });
  }

  const updated = await Message.findById(message._id).populate('sender', chat.SENDER_FIELDS);
  res.json({ success: true, message: serializeMessage(updated) });
});

/** DELETE /api/messages/:id - only the sender may delete; the row is kept as a tombstone. */
const deleteMessage = asyncHandler(async (req, res) => {
  validateObjectId(req.params.id, 'id');
  const message = await Message.findById(req.params.id);
  if (!message) throw new AppError('Message not found', 404);
  await chat.getConversationForUser(message.conversation, req.user._id);

  if (String(message.sender) !== String(req.user._id)) throw new AppError('You can only delete your own messages', 403);
  if (message.messageType === 'system') throw new AppError('System messages cannot be deleted', 400);

  if (!message.isDeleted) {
    await Message.updateOne({ _id: message._id }, { $set: { isDeleted: true, deletedAt: new Date(), content: '' } });
    realtime.emitToConversation(message.conversation, 'message:deleted', {
      conversationId: String(message.conversation),
      messageId: String(message._id),
    });
  }
  res.json({ success: true, message: 'Message deleted' });
});

module.exports = { sendMessage, getMessages, markRead, deleteMessage };
