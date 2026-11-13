const Conversation = require('../models/Conversation');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const chat = require('../services/chatService');
const { validateObjectId, validateGroup, validateMemberIds, escapeRegex, cleanLine } = require('../utils/validators');
const { serializeMessage } = require('../utils/serializers');
const config = require('../config/env');
const realtime = require('../sockets/socketHandler');

const idsOf = (conversation) => conversation.participants.map(String);

/** POST /api/conversations - get or create the private conversation with another user. */
const createPrivate = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const participantId = validateObjectId(body.participantId, 'participantId');

  const { conversation, created } = await chat.getOrCreatePrivateConversation(req.user._id, participantId);
  // Both users' live sockets join the room so the first message reaches the recipient instantly.
  realtime.joinUsersToConversation(idsOf(conversation), conversation._id);

  res.status(created ? 201 : 200).json({
    success: true,
    created,
    conversation: await chat.getConversationDTO(conversation._id, req.user._id),
  });
});

/** GET /api/conversations */
const listConversations = asyncHandler(async (req, res) => {
  res.json({ success: true, conversations: await chat.listConversationDTOs(req.user._id) });
});

/** GET /api/conversations/:id */
const getConversation = asyncHandler(async (req, res) => {
  await chat.getConversationForUser(req.params.id, req.user._id);
  res.json({ success: true, conversation: await chat.getConversationDTO(req.params.id, req.user._id) });
});

/** POST /api/conversations/group */
const createGroup = asyncHandler(async (req, res) => {
  const input = validateGroup(req.body, config.maxGroupMembers);
  const { conversation, systemMessage } = await chat.createGroupConversation({ adminId: req.user._id, ...input });

  const dto = await chat.getConversationDTO(conversation._id, null);
  const others = idsOf(conversation).filter((id) => id !== String(req.user._id));
  realtime.joinUsersToConversation([String(req.user._id)], conversation._id);
  realtime.notifyConversationCreated(others, conversation._id, dto);
  await realtime.publishMessage(conversation, serializeMessage(systemMessage));

  res.status(201).json({ success: true, conversation: await chat.getConversationDTO(conversation._id, req.user._id) });
});

/** GET /api/conversations/rooms/public?q= - discover public rooms. */
const listPublicRooms = asyncHandler(async (req, res) => {
  const filter = { conversationType: 'group', isPublic: true };
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    filter.groupName = { $regex: escapeRegex(cleanLine(req.query.q).slice(0, 50)), $options: 'i' };
  }
  const rooms = await Conversation.find(filter).sort({ updatedAt: -1 }).limit(50);

  res.json({
    success: true,
    rooms: rooms.map((room) => ({
      id: String(room._id),
      groupName: room.groupName,
      memberCount: room.participants.length,
      joined: chat.isParticipant(room, req.user._id),
      createdAt: room.createdAt,
    })),
  });
});

/** POST /api/conversations/:id/join */
const joinRoom = asyncHandler(async (req, res) => {
  const { conversation, joined, systemMessage } = await chat.joinGroup(req.params.id, req.user._id);
  realtime.joinUsersToConversation([String(req.user._id)], conversation._id);
  if (joined) {
    realtime.emitToConversation(conversation._id, 'room:member_joined', {
      conversationId: String(conversation._id),
      user: { id: String(req.user._id), username: req.user.username, profilePicture: req.user.profilePicture || '', status: 'online' },
    });
    await realtime.publishMessage(conversation, serializeMessage(systemMessage));
  }
  res.json({ success: true, joined, conversation: await chat.getConversationDTO(conversation._id, req.user._id) });
});

/** POST /api/conversations/:id/leave */
const leaveRoom = asyncHandler(async (req, res) => {
  const result = await chat.leaveGroup(req.params.id, req.user._id);
  realtime.removeUsersFromConversation([String(req.user._id)], req.params.id);
  if (!result.deleted) {
    realtime.emitToConversation(result.conversation._id, 'room:member_left', {
      conversationId: String(result.conversation._id),
      userId: String(req.user._id),
      groupAdmin: result.conversation.groupAdmin ? String(result.conversation.groupAdmin) : null,
    });
    await realtime.publishMessage(result.conversation, serializeMessage(result.systemMessage));
  }
  res.json({ success: true, message: 'You left the room' });
});

/** POST /api/conversations/:id/members - the room admin adds members. */
const addMembers = asyncHandler(async (req, res) => {
  const userIds = validateMemberIds(req.body);
  const { conversation, added, systemMessage } = await chat.addGroupMembers(req.params.id, req.user._id, userIds);

  if (added.length) {
    const dto = await chat.getConversationDTO(conversation._id, null);
    realtime.notifyConversationCreated(added.map((u) => String(u._id)), conversation._id, dto);
    realtime.emitToConversation(conversation._id, 'room:members_added', { conversationId: String(conversation._id), userIds: added.map((u) => String(u._id)) });
    await realtime.publishMessage(conversation, serializeMessage(systemMessage));
  }
  res.json({ success: true, conversation: await chat.getConversationDTO(conversation._id, req.user._id) });
});

module.exports = { createPrivate, listConversations, getConversation, createGroup, listPublicRooms, joinRoom, leaveRoom, addMembers };

// Re-exported for tests that need to assert the shape of errors raised here.
module.exports.AppError = AppError;
