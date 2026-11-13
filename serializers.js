/**
 * Serializers define exactly which fields leave the server. Using explicit
 * allow-lists (instead of returning documents) guarantees that password hashes,
 * token versions and other internals can never leak through an API response.
 */

const idOf = (value) => (value && value._id ? String(value._id) : String(value));
const isPopulated = (value) => value && typeof value === 'object' && value._id && value.username !== undefined;

function serializePublicUser(user) {
  if (!user) return null;
  return {
    id: idOf(user),
    username: user.username,
    profilePicture: user.profilePicture || '',
    bio: user.bio || '',
    status: user.status || 'offline',
    lastSeen: user.lastSeen || null,
    createdAt: user.createdAt || null,
  };
}

/** The signed-in user's own profile (includes email). */
function serializeCurrentUser(user) {
  return { ...serializePublicUser(user), email: user.email };
}

function serializeMessage(message) {
  const sender = isPopulated(message.sender)
    ? { id: idOf(message.sender), username: message.sender.username, profilePicture: message.sender.profilePicture || '' }
    : { id: idOf(message.sender), username: null, profilePicture: '' };

  return {
    id: idOf(message),
    conversation: idOf(message.conversation),
    sender,
    content: message.isDeleted ? '' : message.content,
    messageType: message.messageType,
    isDeleted: Boolean(message.isDeleted),
    readBy: (message.readBy || []).map(idOf),
    deliveredTo: (message.deliveredTo || []).map(idOf),
    clientId: message.clientId || null,
    createdAt: message.createdAt,
  };
}

function serializeConversation(conversation, { unreadCount = 0 } = {}) {
  const last = conversation.lastMessage;
  return {
    id: idOf(conversation),
    conversationType: conversation.conversationType,
    groupName: conversation.groupName || null,
    groupAdmin: conversation.groupAdmin ? idOf(conversation.groupAdmin) : null,
    isPublic: Boolean(conversation.isPublic),
    participants: conversation.participants.map((p) => (isPopulated(p) ? serializePublicUser(p) : { id: idOf(p) })),
    lastMessage: last && last._id && last.content !== undefined ? serializeMessage(last) : null,
    unreadCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

module.exports = { idOf, serializePublicUser, serializeCurrentUser, serializeMessage, serializeConversation };
