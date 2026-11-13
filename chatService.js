const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AppError = require('../utils/AppError');
const config = require('../config/env');
const { serializeConversation } = require('../utils/serializers');

const PUBLIC_USER_FIELDS = 'username profilePicture bio status lastSeen createdAt';
const SENDER_FIELDS = 'username profilePicture';

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const isParticipant = (conversation, userId) => conversation.participants.some((p) => String(p._id || p) === String(userId));

/** Loads a conversation and enforces that the user belongs to it. */
async function getConversationForUser(conversationId, userId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversation not found', 404);
  if (!isParticipant(conversation, userId)) throw new AppError('You are not a participant in this conversation', 403);
  return conversation;
}

function populateConversation(query) {
  return query
    .populate('participants', PUBLIC_USER_FIELDS)
    .populate({ path: 'lastMessage', populate: { path: 'sender', select: SENDER_FIELDS } });
}

async function getUnreadCounts(userId, conversationIds) {
  if (!conversationIds.length) return new Map();
  const me = toObjectId(userId);
  const rows = await Message.aggregate([
    {
      $match: {
        conversation: { $in: conversationIds },
        sender: { $ne: me },
        readBy: { $ne: me },
        messageType: 'text',
        isDeleted: false,
      },
    },
    { $group: { _id: '$conversation', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

/** One conversation shaped for the API. Pass userId = null to skip unread counting. */
async function getConversationDTO(conversationId, userId = null) {
  const conversation = await populateConversation(Conversation.findById(conversationId));
  if (!conversation) throw new AppError('Conversation not found', 404);
  const unread = userId ? await getUnreadCounts(userId, [conversation._id]) : new Map();
  return serializeConversation(conversation, { unreadCount: unread.get(String(conversation._id)) || 0 });
}

/**
 * The sidebar list: every group the user is in, plus private chats that already
 * contain at least one message (so empty chats never clutter the recipient's list).
 */
async function listConversationDTOs(userId) {
  const conversations = await populateConversation(
    Conversation.find({
      participants: userId,
      $or: [{ conversationType: 'group' }, { lastMessage: { $ne: null } }],
    })
      .sort({ updatedAt: -1 })
      .limit(200)
  );
  const unread = await getUnreadCounts(userId, conversations.map((c) => c._id));
  return conversations.map((c) => serializeConversation(c, { unreadCount: unread.get(String(c._id)) || 0 }));
}

/**
 * Persists a message and bumps the conversation. If the client retries a send with
 * the same clientId, the original message is returned instead of creating a duplicate.
 */
async function createMessage({ conversation, senderId, content, messageType = 'text', clientId }) {
  try {
    const message = await Message.create({
      sender: senderId,
      conversation: conversation._id,
      content,
      messageType,
      clientId: clientId || undefined,
      clientKey: clientId ? `${senderId}:${clientId}` : undefined,
      readBy: messageType === 'text' ? [senderId] : [],
      deliveredTo: [],
    });
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { lastMessage: message._id, updatedAt: message.createdAt } },
      { timestamps: false }
    );
    await message.populate('sender', SENDER_FIELDS);
    return { message, duplicate: false };
  } catch (err) {
    if (err.code === 11000 && clientId) {
      const existing = await Message.findOne({ sender: senderId, clientId }).populate('sender', SENDER_FIELDS);
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
  }
}

/** Marks every unread message from other users in a conversation as read. Returns how many changed. */
async function markConversationRead(conversationId, userId) {
  const result = await Message.updateMany(
    { conversation: conversationId, sender: { $ne: userId }, readBy: { $ne: userId }, messageType: 'text', isDeleted: false },
    { $addToSet: { readBy: userId, deliveredTo: userId } }
  );
  return result.modifiedCount || 0;
}

async function getOrCreatePrivateConversation(userId, otherUserId) {
  if (String(userId) === String(otherUserId)) throw new AppError('You cannot start a conversation with yourself', 400);
  const other = await User.exists({ _id: otherUserId });
  if (!other) throw new AppError('User not found', 404);

  const participantsKey = Conversation.makePrivateKey(userId, otherUserId);
  const existing = await Conversation.findOne({ participantsKey });
  if (existing) return { conversation: existing, created: false };

  try {
    const conversation = await Conversation.create({
      participants: [userId, otherUserId],
      conversationType: 'private',
      participantsKey,
    });
    return { conversation, created: true };
  } catch (err) {
    // Two requests raced to create the same chat: the unique index rejected the loser.
    if (err.code === 11000) return { conversation: await Conversation.findOne({ participantsKey }), created: false };
    throw err;
  }
}

async function postSystemMessage(conversation, actorId, content) {
  const { message } = await createMessage({ conversation, senderId: actorId, content, messageType: 'system' });
  return message;
}

async function createGroupConversation({ adminId, groupName, participantIds, isPublic }) {
  const memberIds = [...new Set([String(adminId), ...participantIds.map(String)])];
  if (memberIds.length > config.maxGroupMembers) throw new AppError(`A group can have at most ${config.maxGroupMembers} members`, 400);

  const found = await User.countDocuments({ _id: { $in: memberIds } });
  if (found !== memberIds.length) throw new AppError('One or more selected users do not exist', 404);

  const conversation = await Conversation.create({
    participants: memberIds,
    conversationType: 'group',
    groupName,
    groupAdmin: adminId,
    isPublic,
  });
  const admin = await User.findById(adminId).select('username');
  const systemMessage = await postSystemMessage(conversation, adminId, `${admin.username} created the room "${groupName}"`);
  return { conversation, systemMessage };
}

async function findGroup(conversationId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversation not found', 404);
  if (conversation.conversationType !== 'group') throw new AppError('This action is only available for group conversations', 400);
  return conversation;
}

async function joinGroup(conversationId, userId) {
  const conversation = await findGroup(conversationId);
  if (isParticipant(conversation, userId)) return { conversation, joined: false };
  if (!conversation.isPublic) throw new AppError('This room is private. Ask a room admin to add you.', 403);
  if (conversation.participants.length >= config.maxGroupMembers) throw new AppError('This room is full', 409);

  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $addToSet: { participants: userId } },
    { returnDocument: 'after' }
  );
  const user = await User.findById(userId).select('username');
  const systemMessage = await postSystemMessage(updated, userId, `${user.username} joined the room`);
  return { conversation: updated, joined: true, systemMessage };
}

async function leaveGroup(conversationId, userId) {
  const conversation = await findGroup(conversationId);
  if (!isParticipant(conversation, userId)) throw new AppError('You are not a member of this room', 403);

  const user = await User.findById(userId).select('username');
  const remaining = conversation.participants.filter((p) => String(p) !== String(userId));

  if (!remaining.length) {
    await Message.deleteMany({ conversation: conversation._id });
    await Conversation.deleteOne({ _id: conversation._id });
    return { deleted: true, conversation };
  }

  const update = { $pull: { participants: userId } };
  if (String(conversation.groupAdmin) === String(userId)) update.$set = { groupAdmin: remaining[0] };
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id }, update, { returnDocument: 'after' });
  const systemMessage = await postSystemMessage(updated, userId, `${user.username} left the room`);
  return { deleted: false, conversation: updated, systemMessage };
}

async function addGroupMembers(conversationId, adminId, userIds) {
  const conversation = await findGroup(conversationId);
  if (String(conversation.groupAdmin) !== String(adminId)) throw new AppError('Only the room admin can add members', 403);

  const newIds = userIds.filter((id) => !isParticipant(conversation, id));
  if (!newIds.length) return { conversation, added: [] };
  if (conversation.participants.length + newIds.length > config.maxGroupMembers) throw new AppError('This room would exceed the member limit', 409);

  const users = await User.find({ _id: { $in: newIds } }).select('username');
  if (users.length !== newIds.length) throw new AppError('One or more selected users do not exist', 404);

  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $addToSet: { participants: { $each: newIds } } },
    { returnDocument: 'after' }
  );
  const systemMessage = await postSystemMessage(updated, adminId, `${users.map((u) => u.username).join(', ')} added to the room`);
  return { conversation: updated, added: users, systemMessage };
}

module.exports = {
  PUBLIC_USER_FIELDS,
  SENDER_FIELDS,
  isParticipant,
  getConversationForUser,
  getConversationDTO,
  listConversationDTOs,
  createMessage,
  markConversationRead,
  getOrCreatePrivateConversation,
  createGroupConversation,
  joinGroup,
  leaveGroup,
  addGroupMembers,
};
