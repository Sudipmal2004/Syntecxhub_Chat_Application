/* Chat dashboard: conversation list, private + group chat, presence, typing, delivery ticks.
   State lives in one object; every view is re-rendered from it, so the UI cannot drift from the data. */

import { api, session } from './api.js';
import { connectSocket, getSocket, disconnectSocket, emitAck } from './socket.js';
import {
  $, h, icon, hydrateIcons, createAvatar, debounce, uid, toast, openModal, confirmDialog,
  formatTime, formatDayLabel, formatListTime, formatLastSeen, formatMemberSince,
} from './utils.js';

const PAGE_SIZE = 30;
const TYPING_EXPIRE_MS = 4500;
const TYPING_IDLE_MS = 1800;

const state = {
  me: null,
  conversations: new Map(), // id -> conversation DTO
  messages: new Map(), // conversationId -> { items: [], hasMore: boolean, loaded: boolean }
  presence: new Map(), // userId -> { status, lastSeen }
  typing: new Map(), // conversationId -> Map(userId -> { username, timer })
  activeId: null,
  tab: 'chats',
  searchTerm: '',
  searchResults: null,
  rooms: null,
  infoOpen: false,
  newIds: new Set(),
};

const el = {
  shell: $('#shell'),
  listBody: $('#listBody'),
  sidebarSub: $('#sidebarSub'),
  search: $('#userSearch'),
  clearSearch: $('#clearSearch'),
  chatEmpty: $('#chatEmpty'),
  chatView: $('#chatView'),
  headerAvatar: $('#headerAvatar'),
  chatTitle: $('#chatTitle'),
  chatSubtitle: $('#chatSubtitle'),
  messages: $('#messages'),
  composer: $('#composer'),
  input: $('#messageInput'),
  sendBtn: $('#sendBtn'),
  infoPanel: $('#infoPanel'),
  infoBtn: $('#infoBtn'),
  banner: $('#connectionBanner'),
  navUnread: $('#navUnread'),
  navMe: $('#navMe'),
};

/* ------------------------------------------------------------ small helpers */

const myId = () => state.me.id;
const activeConv = () => state.conversations.get(state.activeId) || null;
const otherUser = (conv) => conv.participants.find((p) => p.id !== myId()) || null;
const convTitle = (conv) => (conv.conversationType === 'group' ? conv.groupName : (otherUser(conv) || {}).username || 'Unknown user');
const bucket = (id) => {
  if (!state.messages.has(id)) state.messages.set(id, { items: [], hasMore: false, loaded: false });
  return state.messages.get(id);
};
const presenceOf = (userId) => state.presence.get(userId) || { status: 'offline', lastSeen: null };
const isOnline = (userId) => presenceOf(userId).status === 'online';
const isNearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 140;

function scrollToBottom(smooth = false) {
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function rememberUsers(users) {
  users.forEach((u) => {
    if (u && u.username !== undefined && u.id !== myId()) {
      const known = state.presence.get(u.id);
      if (!known) state.presence.set(u.id, { status: u.status || 'offline', lastSeen: u.lastSeen || null });
    }
  });
}

function upsertConversation(conv) {
  rememberUsers(conv.participants);
  state.conversations.set(conv.id, conv);
}

function sortedConversations() {
  return [...state.conversations.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

const totalUnread = () => [...state.conversations.values()].reduce((sum, c) => sum + (c.unreadCount || 0), 0);

function previewText(conv) {
  const last = conv.lastMessage;
  if (!last) return conv.conversationType === 'group' ? 'No messages yet' : 'Say hello';
  if (last.isDeleted) return 'Message deleted';
  if (last.messageType === 'system') return last.content;
  const mine = last.sender.id === myId();
  const prefix = mine ? 'You: ' : conv.conversationType === 'group' && last.sender.username ? `${last.sender.username}: ` : '';
  return prefix + last.content.replace(/\s+/g, ' ');
}

function typingNames(convId) {
  const map = state.typing.get(convId);
  return map ? [...map.values()].map((t) => t.username) : [];
}

function clearTyping(convId, userId) {
  const map = state.typing.get(convId);
  if (!map || !map.has(userId)) return;
  clearTimeout(map.get(userId).timer);
  map.delete(userId);
}

/* ----------------------------------------------------------------- sidebar */

function skeletonRows(count = 6) {
  return Array.from({ length: count }, () => h('div', { class: 'skeleton-row' }, h('span', { class: 'skeleton' }), h('div', {}, h('span', { class: 'skeleton skeleton--title' }), h('span', { class: 'skeleton skeleton--text' }))));
}

function emptyState(iconName, title, text) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty__art' }, icon(iconName)), h('h3', { text: title }), h('p', { text }));
}

function renderConversationRow(conv) {
  const group = conv.conversationType === 'group';
  const other = group ? null : otherUser(conv);
  const typers = typingNames(conv.id);
  const unread = conv.unreadCount || 0;
  const avatar = group ? createAvatar({ groupName: conv.groupName }, { group: true }) : createAvatar(other, { status: isOnline(other.id) ? 'online' : 'offline' });

  return h(
    'button',
    {
      class: `conv${conv.id === state.activeId ? ' is-active' : ''}${unread ? ' has-unread' : ''}`,
      type: 'button',
      dataset: { id: conv.id },
      'aria-label': `${convTitle(conv)}${unread ? `, ${unread} unread` : ''}`,
      onClick: () => openConversation(conv.id),
    },
    avatar,
    h(
      'div',
      { class: 'conv__main' },
      h('div', { class: 'conv__row' }, h('span', { class: 'conv__name', text: convTitle(conv) }), h('span', { class: 'conv__time', text: formatListTime(conv.lastMessage ? conv.lastMessage.createdAt : conv.createdAt) })),
      h(
        'div',
        { class: 'conv__preview' },
        h('span', { class: `conv__text${typers.length ? ' is-typing' : ''}`, text: typers.length ? (group ? `${typers[0]} is typing...` : 'typing...') : previewText(conv) }),
        unread ? h('span', { class: 'badge', text: unread > 99 ? '99+' : String(unread) }) : null
      )
    )
  );
}

function renderPersonRow(user) {
  return h(
    'button',
    { class: 'person', type: 'button', onClick: () => startPrivateChat(user.id), 'aria-label': `Start a chat with ${user.username}` },
    createAvatar(user, { status: isOnline(user.id) || user.status === 'online' ? 'online' : 'offline' }),
    h('div', { class: 'person__main' }, h('div', { class: 'person__name', text: user.username }), h('div', { class: 'person__sub', text: user.bio || (user.status === 'online' || isOnline(user.id) ? 'Online' : formatLastSeen(user.lastSeen)) })),
    h('span', { class: 'person__action' }, icon('chat'))
  );
}

function renderRoomRow(room) {
  const button = h('button', { class: `btn btn--sm ${room.joined ? 'btn--ghost' : 'btn--primary'}`, type: 'button', text: room.joined ? 'Open' : 'Join', 'aria-label': `${room.joined ? 'Open' : 'Join'} ${room.groupName}` });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (room.joined && state.conversations.has(room.id)) return openConversation(room.id);
      await joinRoom(room.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
    return undefined;
  });
  return h('div', { class: 'room' }, createAvatar({ groupName: room.groupName }, { group: true }), h('div', {}, h('div', { class: 'room__name', text: room.groupName }), h('div', { class: 'room__meta', text: `${room.memberCount} member${room.memberCount === 1 ? '' : 's'}` })), button);
}

function renderSidebar() {
  const unread = totalUnread();
  el.navUnread.hidden = unread === 0;
  document.title = `${unread ? `(${unread}) ` : ''}Chats - Pulse Chat`;

  const searching = state.searchTerm.length > 0;
  el.clearSearch.hidden = !searching;
  $('#tabs').hidden = searching;

  const nodes = [];
  if (searching) {
    nodes.push(h('div', { class: 'list__heading', text: 'People' }));
    if (state.searchResults === null) nodes.push(...skeletonRows(3));
    else if (!state.searchResults.length) nodes.push(emptyState('search', 'No people found', `No one matches "${state.searchTerm}". Check the spelling and try again.`));
    else nodes.push(...state.searchResults.map(renderPersonRow));
    el.sidebarSub.textContent = 'Search results';
  } else if (state.tab === 'rooms') {
    el.sidebarSub.textContent = 'Public rooms you can join';
    if (state.rooms === null) nodes.push(...skeletonRows(4));
    else if (!state.rooms.length) nodes.push(emptyState('hash', 'No public rooms yet', 'Create the first one with the + button.'));
    else nodes.push(...state.rooms.map(renderRoomRow));
  } else {
    const convs = sortedConversations();
    el.sidebarSub.textContent = convs.length ? `${convs.length} conversation${convs.length === 1 ? '' : 's'}${unread ? ` - ${unread} unread` : ''}` : 'No conversations yet';
    if (!convs.length) nodes.push(emptyState('chat', 'No conversations yet', 'Search for someone by username above to start chatting, or discover a public room.'));
    else nodes.push(...convs.map(renderConversationRow));
  }
  el.listBody.replaceChildren(...nodes);
}

function setTab(tab) {
  state.tab = tab;
  $('#tabChats').classList.toggle('is-active', tab === 'chats');
  $('#tabChats').setAttribute('aria-selected', String(tab === 'chats'));
  $('#tabRooms').classList.toggle('is-active', tab === 'rooms');
  $('#tabRooms').setAttribute('aria-selected', String(tab === 'rooms'));
  $('#navChats').classList.toggle('is-active', tab === 'chats');
  $('#navRooms').classList.toggle('is-active', tab === 'rooms');
  if (tab === 'rooms') loadRooms();
  renderSidebar();
}

async function loadRooms() {
  try {
    state.rooms = (await api.conversations.publicRooms()).rooms;
  } catch (err) {
    state.rooms = [];
    toast(err.message, 'error');
  }
  if (state.tab === 'rooms') renderSidebar();
}

const runSearch = debounce(async () => {
  const term = state.searchTerm;
  if (!term) return;
  try {
    const { users } = await api.users.search(term);
    if (term !== state.searchTerm) return; // a newer query superseded this one
    rememberUsers(users);
    state.searchResults = users;
  } catch (err) {
    state.searchResults = [];
    toast(err.message, 'error');
  }
  renderSidebar();
}, 280);

function onSearchInput() {
  state.searchTerm = el.search.value.trim();
  state.searchResults = state.searchTerm ? null : undefined;
  renderSidebar();
  runSearch();
}

function clearSearch() {
  el.search.value = '';
  state.searchTerm = '';
  state.searchResults = null;
  renderSidebar();
}

/* ------------------------------------------------------------ chat header */

function renderHeader() {
  const conv = activeConv();
  if (!conv) return;
  const group = conv.conversationType === 'group';
  const other = group ? null : otherUser(conv);

  el.headerAvatar.replaceChildren(group ? createAvatar({ groupName: conv.groupName }, { group: true }) : createAvatar(other, { status: isOnline(other.id) ? 'online' : 'offline' }));
  el.chatTitle.textContent = convTitle(conv);

  const typers = typingNames(conv.id);
  let text;
  let cls = 'chat__subtitle';
  if (typers.length) {
    text = group ? `${typers.slice(0, 2).join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing...` : 'typing...';
    cls += ' is-typing';
  } else if (group) {
    const online = conv.participants.filter((p) => p.id === myId() || isOnline(p.id)).length;
    text = `${conv.isPublic ? 'Public room' : 'Private room'} - ${conv.participants.length} members, ${online} online`;
  } else if (isOnline(other.id)) {
    text = 'Online';
    cls += ' is-online';
  } else {
    text = formatLastSeen(presenceOf(other.id).lastSeen || other.lastSeen);
  }
  el.chatSubtitle.className = cls;
  el.chatSubtitle.textContent = text;
}

/* ---------------------------------------------------------------- messages */

function ticksFor(message, conv) {
  const others = (list) => list.filter((id) => id !== myId());
  const read = others(message.readBy).length > 0;
  const delivered = read || others(message.deliveredTo).length > 0;
  const label = read ? 'Read' : delivered ? 'Delivered' : 'Sent';
  const wrap = h('span', { class: `ticks${read ? ' is-read' : ''}`, title: label, role: 'img', 'aria-label': label });
  wrap.append(icon(delivered ? 'checks' : 'check'));
  return wrap;
}

function renderMessageNode(message, index, items, conv) {
  const prev = items[index - 1];
  const next = items[index + 1];
  const group = conv.conversationType === 'group';
  const mine = message.sender.id === myId();
  const sameRun = (a, b) => a && b && a.messageType !== 'system' && b.messageType !== 'system' && a.sender.id === b.sender.id && new Date(b.createdAt) - new Date(a.createdAt) < 5 * 60 * 1000 && new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString();

  if (message.messageType === 'system') return h('div', { class: 'sys' }, h('span', { text: message.content }));

  const first = !sameRun(prev, message);
  const last = !sameRun(message, next);
  const classes = ['msg', mine ? 'msg--mine' : 'msg--theirs'];
  if (first) classes.push('is-first');
  if (state.newIds.has(message.id)) classes.push('is-new');
  if (message.isDeleted) classes.push('is-deleted');
  if (message.pending) classes.push('is-pending');
  if (message.failed) classes.push('is-failed');

  const meta = h('div', { class: 'bubble__meta' });
  if (!message.isDeleted) meta.append(h('time', { datetime: message.createdAt, title: new Date(message.createdAt).toLocaleString(), text: formatTime(message.createdAt) }));
  if (mine && !message.isDeleted) {
    if (message.failed) meta.append(h('button', { class: 'retry', type: 'button', text: 'Not sent - retry', onClick: () => retrySend(message) }));
    else if (message.pending) meta.append(h('span', { class: 'mini-spinner', role: 'img', 'aria-label': 'Sending' }));
    else meta.append(ticksFor(message, conv));
  }

  const bubble = h(
    'div',
    { class: 'bubble' },
    group && !mine && first && !message.isDeleted ? h('div', { class: 'bubble__author', text: message.sender.username || 'Unknown' }) : null,
    h('div', { class: 'bubble__text', text: message.isDeleted ? 'This message was deleted' : message.content }),
    meta
  );

  const avatarSlot = h('div', { class: 'msg__avatar' }, group && !mine && last ? createAvatar(message.sender, { size: 'xs' }) : null);
  const row = h('div', { class: classes.join(' '), dataset: { id: message.id } }, group && !mine ? avatarSlot : null, h('div', { class: 'msg__body' }, bubble));

  if (mine && !message.isDeleted && !message.pending && !message.failed) {
    const del = h('button', { class: 'msg__delete', type: 'button', 'aria-label': 'Delete message', title: 'Delete message', onClick: () => deleteMessage(message) });
    del.append(icon('trash'));
    row.append(del);
  }
  return row;
}

function typingRowNode(conv) {
  const names = typingNames(conv.id);
  if (!names.length) return null;
  return h('div', { class: 'typing-row', id: 'typingRow', role: 'status' }, h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { text: conv.conversationType === 'group' ? `${names.slice(0, 2).join(', ')} typing...` : `${convTitle(conv)} is typing...` }));
}

function renderMessages({ keepScroll = false, stickBottom = false } = {}) {
  const conv = activeConv();
  if (!conv) return;
  const data = bucket(conv.id);
  const previousHeight = el.messages.scrollHeight;
  const previousTop = el.messages.scrollTop;
  const wasNearBottom = isNearBottom();
  const nodes = [];

  if (!data.loaded) {
    nodes.push(h('div', { class: 'msg-skeleton', 'aria-label': 'Loading messages' }, Array.from({ length: 6 }, () => h('div', { class: 'skeleton' }))));
  } else {
    if (data.hasMore) {
      const more = h('button', { class: 'btn btn--soft btn--sm', type: 'button', text: 'Load earlier messages' });
      more.addEventListener('click', () => loadOlder(more));
      nodes.push(h('div', { class: 'history-more' }, more));
    } else if (data.items.length) {
      nodes.push(h('p', { class: 'history-start', text: 'Beginning of the conversation' }));
    }

    let lastDay = '';
    data.items.forEach((message, index) => {
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        nodes.push(h('div', { class: 'day' }, h('span', { text: formatDayLabel(message.createdAt) })));
      }
      nodes.push(renderMessageNode(message, index, data.items, conv));
    });

    if (!data.items.length) {
      nodes.push(h('div', { class: 'chat-empty-state' }, h('strong', { text: conv.conversationType === 'group' ? 'No messages in this room yet' : `Start your conversation with ${convTitle(conv)}` }), h('span', { text: 'Messages you send here are saved, so you can pick up where you left off.' })));
    }
    const typingNode = typingRowNode(conv);
    if (typingNode) nodes.push(typingNode);
  }

  el.messages.replaceChildren(...nodes);
  state.newIds.clear();

  if (stickBottom || (!keepScroll && wasNearBottom)) scrollToBottom();
  else if (keepScroll) el.messages.scrollTop = previousTop + (el.messages.scrollHeight - previousHeight);
  else el.messages.scrollTop = previousTop;
}

function syncTypingRow() {
  const conv = activeConv();
  if (!conv) return;
  const near = isNearBottom();
  const existing = $('#typingRow', el.messages);
  const fresh = typingRowNode(conv);
  if (existing) existing.remove();
  if (fresh) el.messages.append(fresh);
  if (fresh && near) scrollToBottom(true);
}

async function loadMessages(convId) {
  const data = bucket(convId);
  try {
    const { messages, pagination } = await api.messages.list(convId, { limit: PAGE_SIZE });
    const pending = data.items.filter((m) => m.pending || m.failed);
    data.items = [...messages, ...pending];
    data.hasMore = pagination.hasMore;
    data.loaded = true;
  } catch (err) {
    data.loaded = true;
    toast(err.message, 'error');
  }
  if (state.activeId === convId) {
    renderMessages({ stickBottom: true });
    markActiveRead();
  }
}

async function loadOlder(button) {
  const conv = activeConv();
  if (!conv) return;
  const data = bucket(conv.id);
  const oldest = data.items.find((m) => !m.pending && !m.failed);
  if (!oldest) return;
  button.disabled = true;
  button.textContent = 'Loading...';
  try {
    const { messages, pagination } = await api.messages.list(conv.id, { before: oldest.id, limit: PAGE_SIZE });
    data.items = [...messages, ...data.items];
    data.hasMore = pagination.hasMore;
    renderMessages({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = 'Load earlier messages';
  }
}

/** After a reconnect: fetch whatever was missed while offline (cursor = newest confirmed message). */
async function syncActiveConversation() {
  const conv = activeConv();
  if (!conv) return;
  const data = bucket(conv.id);
  const newest = [...data.items].reverse().find((m) => !m.pending && !m.failed);
  try {
    let cursor = newest && newest.id;
    for (let guard = 0; guard < 10; guard += 1) {
      const { messages, pagination } = await api.messages.list(conv.id, cursor ? { after: cursor, limit: 100 } : { limit: PAGE_SIZE });
      messages.forEach((m) => mergeMessage(conv.id, m));
      if (!pagination.hasMore || !messages.length) break;
      cursor = messages[messages.length - 1].id;
    }
    if (state.activeId === conv.id) {
      renderMessages();
      markActiveRead();
    }
  } catch {
    /* the next reconnect or manual reload will try again */
  }
}

/** Inserts or updates a server message in the local list. Returns true when it was new to this client. */
function mergeMessage(convId, message) {
  const data = bucket(convId);
  const byId = data.items.findIndex((m) => m.id === message.id);
  if (byId >= 0) {
    data.items[byId] = { ...data.items[byId], ...message, pending: false, failed: false };
    return false;
  }
  const byClient = message.clientId ? data.items.findIndex((m) => m.clientId === message.clientId && (m.pending || m.failed)) : -1;
  if (byClient >= 0) {
    data.items[byClient] = message;
    return false;
  }
  data.items.push(message);
  state.newIds.add(message.id);
  return true;
}

function touchConversation(convId, message) {
  const conv = state.conversations.get(convId);
  if (!conv) return;
  conv.lastMessage = message;
  conv.updatedAt = message.createdAt;
}

/* ----------------------------------------------------------------- sending */

function isTypingEmitted() {
  return Boolean(state.localTypingTimer);
}

function emitTyping(on) {
  const socket = getSocket();
  if (!socket || !socket.connected || !state.activeId) return;
  socket.emit(on ? 'typing:start' : 'typing:stop', { conversationId: state.activeId });
}

function onComposerInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
  const hasText = el.input.value.trim().length > 0;
  el.sendBtn.disabled = !hasText;
  if (!hasText) return stopTyping();
  if (!isTypingEmitted()) emitTyping(true);
  clearTimeout(state.localTypingTimer);
  state.localTypingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  return undefined;
}

function stopTyping() {
  if (isTypingEmitted()) emitTyping(false);
  clearTimeout(state.localTypingTimer);
  state.localTypingTimer = null;
}

async function deliver(convId, message) {
  const socket = getSocket();
  const payload = { conversationId: convId, content: message.content, clientId: message.clientId };
  try {
    // Prefer the socket (lowest latency). While it is down, the REST API accepts the same payload.
    const response = socket && socket.connected ? (await emitAck('message:send', payload)).message : (await api.messages.send(payload)).message;
    mergeMessage(convId, response);
    touchConversation(convId, response);
  } catch (err) {
    const data = bucket(convId);
    const local = data.items.find((m) => m.clientId === message.clientId);
    if (local) {
      local.pending = false;
      local.failed = true;
    }
    if (err.status === 429 || err.status === 403) toast(err.message, 'error');
  }
  if (state.activeId === convId) renderMessages({ stickBottom: true });
  renderSidebar();
}

function sendCurrentMessage() {
  const conv = activeConv();
  const content = el.input.value.replace(/\r\n?/g, '\n').trim();
  if (!conv || !content) return;
  if (content.length > 2000) return toast('Messages can be at most 2000 characters.', 'error');

  stopTyping();
  const local = {
    id: `local-${uid()}`,
    clientId: uid().replace(/[^\w-]/g, ''),
    conversation: conv.id,
    sender: { id: myId(), username: state.me.username, profilePicture: state.me.profilePicture },
    content,
    messageType: 'text',
    isDeleted: false,
    readBy: [myId()],
    deliveredTo: [],
    createdAt: new Date().toISOString(),
    pending: true,
  };
  bucket(conv.id).items.push(local);
  state.newIds.add(local.id);
  touchConversation(conv.id, local);

  el.input.value = '';
  onComposerInput();
  renderMessages({ stickBottom: true });
  renderSidebar();
  return deliver(conv.id, local);
}

function retrySend(message) {
  message.failed = false;
  message.pending = true;
  renderMessages({ stickBottom: true });
  deliver(message.conversation, message);
}

async function deleteMessage(message) {
  const ok = await confirmDialog({ title: 'Delete this message?', message: 'It will be removed for everyone in this conversation.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.messages.remove(message.id);
    applyDeleted(message.conversation, message.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function applyDeleted(convId, messageId) {
  const item = bucket(convId).items.find((m) => m.id === messageId);
  if (item) {
    item.isDeleted = true;
    item.content = '';
  }
  const conv = state.conversations.get(convId);
  if (conv && conv.lastMessage && conv.lastMessage.id === messageId) {
    conv.lastMessage = { ...conv.lastMessage, isDeleted: true, content: '' };
  }
  if (state.activeId === convId) renderMessages();
  renderSidebar();
}

/* ----------------------------------------------------- opening conversations */

function markActiveRead() {
  const conv = activeConv();
  if (!conv || document.visibilityState !== 'visible') return;
  const data = bucket(conv.id);
  const hasUnread = data.items.some((m) => m.messageType === 'text' && m.sender.id !== myId() && !m.readBy.includes(myId()) && !m.isDeleted);
  if (!conv.unreadCount && !hasUnread) return;
  conv.unreadCount = 0;
  data.items.forEach((m) => {
    if (m.sender.id !== myId() && !m.readBy.includes(myId())) m.readBy.push(myId());
  });
  renderSidebar();
  const socket = getSocket();
  if (socket && socket.connected) socket.emit('message:read', { conversationId: conv.id }, () => {});
}

function setView(view) {
  el.shell.dataset.view = view;
}

async function openConversation(id) {
  const conv = state.conversations.get(id);
  if (!conv) return;
  if (state.activeId && state.activeId !== id) stopTyping();
  state.activeId = id;
  if (state.searchTerm) clearSearch();
  if (state.tab !== 'chats') setTab('chats');

  el.chatEmpty.hidden = true;
  el.chatView.hidden = false;
  setView('chat');
  renderHeader();
  renderSidebar();
  renderInfo();
  el.input.value = '';
  onComposerInput();

  const data = bucket(id);
  renderMessages({ stickBottom: true });
  await loadMessages(id);
  if (window.matchMedia('(min-width: 821px)').matches && state.activeId === id) el.input.focus();
}

function closeConversation() {
  stopTyping();
  state.activeId = null;
  el.chatView.hidden = true;
  el.chatEmpty.hidden = false;
  setView('list');
  closeInfo();
  renderSidebar();
}

async function startPrivateChat(userId) {
  try {
    const { conversation } = await api.conversations.startPrivate(userId);
    upsertConversation(conversation);
    await openConversation(conversation.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function joinRoom(id) {
  const { conversation } = await api.conversations.join(id);
  upsertConversation(conversation);
  state.rooms = null;
  await openConversation(conversation.id);
  toast(`You joined ${conversation.groupName}`, 'success');
}

async function leaveRoom(conv) {
  const ok = await confirmDialog({ title: `Leave "${conv.groupName}"?`, message: 'You will stop receiving messages from this room.', confirmLabel: 'Leave room', danger: true });
  if (!ok) return;
  try {
    await api.conversations.leave(conv.id);
    removeConversation(conv.id);
    toast('You left the room', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function removeConversation(id) {
  state.conversations.delete(id);
  state.messages.delete(id);
  if (state.activeId === id) closeConversation();
  state.rooms = null;
  if (state.tab === 'rooms') loadRooms();
  renderSidebar();
}

/* -------------------------------------------------------------- user picker */

/** Search-as-you-type multi select used by the "new room" and "add members" dialogs. */
function createUserPicker({ exclude = [], onChange = () => {} } = {}) {
  const selected = new Map();
  const chips = h('div', { class: 'picker__chips' });
  const results = h('div', { class: 'picker__results' });
  const input = h('input', { type: 'search', id: 'pickerSearch', placeholder: 'Search people by username', autocomplete: 'off', maxlength: '50' });
  const field = h('div', { class: 'field' }, h('label', { for: 'pickerSearch', text: 'Add people' }), input);

  const drawChips = () => {
    chips.replaceChildren(...[...selected.values()].map((u) => {
      const remove = h('button', { type: 'button', 'aria-label': `Remove ${u.username}`, onClick: () => { selected.delete(u.id); drawChips(); onChange([...selected.values()]); } });
      remove.append(icon('close'));
      return h('span', { class: 'chip' }, u.username, remove);
    }));
  };

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return results.replaceChildren();
    try {
      const { users } = await api.users.search(q);
      const rows = users.filter((u) => !exclude.includes(u.id) && !selected.has(u.id));
      results.replaceChildren(...(rows.length ? rows.map((u) => {
        const row = h('button', { class: 'picker__row', type: 'button', onClick: () => { selected.set(u.id, u); input.value = ''; results.replaceChildren(); drawChips(); onChange([...selected.values()]); input.focus(); } }, createAvatar(u, { size: 'xs' }), h('span', { text: u.username }));
        return row;
      }) : [h('div', { class: 'picker__note', text: 'No matching people' })]));
    } catch (err) {
      results.replaceChildren(h('div', { class: 'picker__note', text: err.message }));
    }
  }, 250);
  input.addEventListener('input', search);

  return { node: h('div', {}, field, chips, results), get ids() { return [...selected.keys()]; } };
}

function openNewRoomDialog() {
  const nameInput = h('input', { type: 'text', id: 'roomName', maxlength: '50', placeholder: 'e.g. Project Phoenix', autocomplete: 'off', required: true });
  const nameError = h('div', { class: 'field__error', role: 'alert', hidden: true });
  const picker = createUserPicker();
  const choice = h(
    'div',
    { class: 'choice', role: 'radiogroup', 'aria-label': 'Room visibility' },
    h('label', {}, h('input', { type: 'radio', name: 'visibility', value: 'public', checked: true }), h('strong', { text: 'Public' }), h('span', { text: 'Anyone can find and join' })),
    h('label', {}, h('input', { type: 'radio', name: 'visibility', value: 'private' }), h('strong', { text: 'Private' }), h('span', { text: 'Invite only' }))
  );
  const content = h('form', { novalidate: true }, h('div', { class: 'field' }, h('label', { for: 'roomName', text: 'Room name' }), nameInput, nameError), choice, picker.node);
  content.addEventListener('submit', (e) => e.preventDefault());

  openModal({
    title: 'Create a room',
    description: 'Group conversations for teams, classes or friends.',
    content,
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Create room',
        variant: 'primary',
        async onClick() {
          const groupName = nameInput.value.trim();
          if (groupName.length < 2) {
            nameError.textContent = 'Room name must be 2-50 characters';
            nameError.hidden = false;
            nameInput.setAttribute('aria-invalid', 'true');
            nameInput.focus();
            return false;
          }
          const isPublic = content.querySelector('input[name="visibility"]:checked').value === 'public';
          const { conversation } = await api.conversations.createGroup({ groupName, isPublic, participantIds: picker.ids });
          upsertConversation(conversation);
          await openConversation(conversation.id);
          toast(`Room "${groupName}" created`, 'success');
          return undefined;
        },
      },
    ],
  });
}

function openAddMembersDialog(conv) {
  const picker = createUserPicker({ exclude: conv.participants.map((p) => p.id) });
  openModal({
    title: 'Add members',
    description: `Invite people to ${conv.groupName}.`,
    content: picker.node,
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Add',
        variant: 'primary',
        async onClick() {
          if (!picker.ids.length) return false;
          const { conversation } = await api.conversations.addMembers(conv.id, picker.ids);
          upsertConversation(conversation);
          renderHeader();
          renderInfo();
          toast('Members added', 'success');
          return undefined;
        },
      },
    ],
  });
}

/* -------------------------------------------------------------- info panel */

function closeInfo() {
  state.infoOpen = false;
  el.infoPanel.hidden = true;
  el.shell.classList.remove('has-info');
  el.infoBtn.setAttribute('aria-pressed', 'false');
}

function renderInfo() {
  const conv = activeConv();
  if (!conv || !state.infoOpen) return;
  el.shell.classList.add('has-info');
  el.infoPanel.hidden = false;
  el.infoBtn.setAttribute('aria-pressed', 'true');

  const close = h('button', { class: 'icon-btn info__close', type: 'button', 'aria-label': 'Close details', onClick: closeInfo });
  close.append(icon('close'));
  const nodes = [close];

  if (conv.conversationType === 'group') {
    const admin = conv.participants.find((p) => p.id === conv.groupAdmin);
    nodes.push(
      h('div', { class: 'info__hero' }, createAvatar({ groupName: conv.groupName }, { group: true, size: 'xl' }), h('h2', { class: 'info__name', text: conv.groupName }), h('p', { class: 'info__status', text: `${conv.isPublic ? 'Public' : 'Private'} room - ${conv.participants.length} members` })),
      h('div', { class: 'info__section' }, h('h3', { text: 'About' }), h('dl', { class: 'info__facts' }, h('div', {}, h('dt', { text: 'Created' }), h('dd', { text: formatMemberSince(conv.createdAt) })), h('div', {}, h('dt', { text: 'Admin' }), h('dd', { text: admin ? admin.username : 'Unknown' })))),
      h(
        'div',
        { class: 'info__section' },
        h('h3', { text: `Members (${conv.participants.length})` }),
        ...conv.participants.map((p) => h('div', { class: 'member' }, createAvatar(p, { size: 'sm', status: p.id === myId() || isOnline(p.id) ? 'online' : 'offline' }), h('div', {}, h('div', { class: 'member__name', text: p.id === myId() ? `${p.username} (you)` : p.username }), h('div', { class: 'member__sub', text: p.id === myId() || isOnline(p.id) ? 'Online' : formatLastSeen(presenceOf(p.id).lastSeen || p.lastSeen) })), p.id === conv.groupAdmin ? h('span', { class: 'tag', text: 'Admin' }) : null))
      )
    );
    const actions = h('div', { class: 'info__actions' });
    if (conv.groupAdmin === myId()) actions.append(h('button', { class: 'btn btn--soft', type: 'button', text: 'Add members', onClick: () => openAddMembersDialog(conv) }));
    actions.append(h('button', { class: 'btn btn--danger-soft', type: 'button', text: 'Leave room', onClick: () => leaveRoom(conv) }));
    nodes.push(actions);
  } else {
    const other = otherUser(conv);
    const online = isOnline(other.id);
    nodes.push(
      h('div', { class: 'info__hero' }, createAvatar(other, { size: 'xl', status: online ? 'online' : 'offline' }), h('h2', { class: 'info__name', text: other.username }), h('p', { class: `info__status${online ? ' is-online' : ''}`, text: online ? 'Online' : formatLastSeen(presenceOf(other.id).lastSeen || other.lastSeen) }), other.bio ? h('p', { class: 'info__bio', text: other.bio }) : null),
      h('div', { class: 'info__section' }, h('h3', { text: 'Details' }), h('dl', { class: 'info__facts' }, h('div', {}, h('dt', { text: 'Member since' }), h('dd', { text: other.createdAt ? formatMemberSince(other.createdAt) : '-' })), h('div', {}, h('dt', { text: 'Chat started' }), h('dd', { text: formatMemberSince(conv.createdAt) }))))
    );
  }
  el.infoPanel.replaceChildren(...nodes);
}

function toggleInfo() {
  if (state.infoOpen) return closeInfo();
  state.infoOpen = true;
  renderInfo();
  return undefined;
}

/* --------------------------------------------------------- realtime events */

async function ensureConversation(id) {
  if (state.conversations.has(id)) return true;
  try {
    const { conversation } = await api.conversations.get(id);
    upsertConversation(conversation);
    return true;
  } catch {
    return false;
  }
}

async function onMessageNew(message) {
  const convId = message.conversation;
  if (!(await ensureConversation(convId))) return;
  const isNew = mergeMessage(convId, message);
  touchConversation(convId, message);
  clearTyping(convId, message.sender.id);

  const conv = state.conversations.get(convId);
  const fromOther = message.sender.id !== myId() && message.messageType === 'text';
  if (isNew && fromOther) {
    if (convId === state.activeId && document.visibilityState === 'visible') {
      markActiveRead();
    } else {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }
  }
  if (convId === state.activeId) {
    const stick = isNearBottom() || message.sender.id === myId();
    renderMessages({ stickBottom: stick });
  }
  renderSidebar();
}

function patchMessages(convId, predicate, patch) {
  const data = state.messages.get(convId);
  if (!data) return false;
  let changed = false;
  data.items.forEach((m) => {
    if (predicate(m)) {
      patch(m);
      changed = true;
    }
  });
  return changed;
}

function bindSocket(socket) {
  let hasConnectedBefore = false;

  socket.on('connect', () => {
    el.banner.hidden = true;
    if (hasConnectedBefore) {
      // Reconnected: resynchronise everything that may have changed while we were offline.
      loadConversations().then(syncActiveConversation);
    }
    hasConnectedBefore = true;
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') return;
    el.banner.textContent = 'Connection lost. Reconnecting...';
    el.banner.className = 'conn-banner is-error';
    el.banner.hidden = false;
  });
  socket.on('connect_error', (err) => {
    if (err && err.data && err.data.code === 401) return forceLogout('expired');
    el.banner.textContent = 'Cannot reach the server. Retrying...';
    el.banner.className = 'conn-banner is-error';
    el.banner.hidden = false;
    return undefined;
  });

  socket.on('presence:snapshot', ({ online }) => {
    const onlineSet = new Set(online);
    state.presence.forEach((value, userId) => {
      if (!onlineSet.has(userId)) state.presence.set(userId, { status: 'offline', lastSeen: value.lastSeen });
    });
    online.forEach((userId) => state.presence.set(userId, { status: 'online', lastSeen: null }));
    refreshPresenceViews();
  });
  socket.on('presence:update', ({ userId, status, lastSeen }) => {
    if (userId === myId()) return;
    state.presence.set(userId, { status, lastSeen: lastSeen || null });
    refreshPresenceViews();
  });

  socket.on('message:new', onMessageNew);
  socket.on('message:delivered', ({ conversationId, messageIds, userIds }) => {
    const ids = new Set(messageIds);
    const changed = patchMessages(conversationId, (m) => ids.has(m.id), (m) => {
      m.deliveredTo = [...new Set([...(m.deliveredTo || []), ...userIds])];
    });
    if (changed && conversationId === state.activeId) renderMessages();
  });
  socket.on('message:read', ({ conversationId, userId, messageIds }) => {
    if (userId === myId()) return;
    const ids = messageIds ? new Set(messageIds) : null;
    const changed = patchMessages(conversationId, (m) => m.sender.id !== userId && m.messageType === 'text' && (!ids || ids.has(m.id)), (m) => {
      m.readBy = [...new Set([...(m.readBy || []), userId])];
      m.deliveredTo = [...new Set([...(m.deliveredTo || []), userId])];
    });
    if (changed && conversationId === state.activeId) renderMessages();
  });
  socket.on('message:deleted', ({ conversationId, messageId }) => applyDeleted(conversationId, messageId));

  socket.on('typing', ({ conversationId, userId, username, isTyping }) => {
    if (userId === myId()) return;
    clearTyping(conversationId, userId);
    if (isTyping) {
      const map = state.typing.get(conversationId) || new Map();
      const timer = setTimeout(() => {
        clearTyping(conversationId, userId);
        typingChanged(conversationId);
      }, TYPING_EXPIRE_MS);
      map.set(userId, { username, timer });
      state.typing.set(conversationId, map);
    }
    typingChanged(conversationId);
  });

  socket.on('conversation:new', (conv) => {
    upsertConversation(conv);
    renderSidebar();
  });
  socket.on('room:member_joined', async ({ conversationId }) => refreshConversation(conversationId));
  socket.on('room:members_added', async ({ conversationId }) => refreshConversation(conversationId));
  socket.on('room:member_left', async ({ conversationId, userId }) => {
    if (userId === myId()) return removeConversation(conversationId);
    return refreshConversation(conversationId);
  });
  socket.on('user:updated', (user) => {
    state.conversations.forEach((conv) => {
      const idx = conv.participants.findIndex((p) => p.id === user.id);
      if (idx >= 0) conv.participants[idx] = { ...conv.participants[idx], ...user };
    });
    renderSidebar();
    renderHeader();
    renderInfo();
  });
}

function typingChanged(convId) {
  renderSidebar();
  if (convId === state.activeId) {
    renderHeader();
    syncTypingRow();
  }
}

function refreshPresenceViews() {
  renderSidebar();
  renderHeader();
  renderInfo();
}

async function refreshConversation(id) {
  if (!state.conversations.has(id)) return;
  try {
    const { conversation } = await api.conversations.get(id);
    const previous = state.conversations.get(id);
    upsertConversation({ ...conversation, unreadCount: previous ? previous.unreadCount : conversation.unreadCount });
    renderSidebar();
    if (id === state.activeId) {
      renderHeader();
      renderInfo();
    }
  } catch {
    /* membership may have changed; the next full sync fixes it */
  }
}

/* ---------------------------------------------------------- session + boot */

async function forceLogout(reason) {
  disconnectSocket();
  session.clear();
  location.replace(`login.html${reason ? `?${reason}=1` : ''}`);
}

async function logout() {
  try {
    await api.auth.logout();
  } catch {
    /* even if the request fails we still clear the local session */
  }
  forceLogout('loggedout');
}

async function loadConversations() {
  try {
    const { conversations } = await api.conversations.list();
    const fresh = new Map();
    conversations.forEach((c) => {
      rememberUsers(c.participants);
      fresh.set(c.id, c);
    });
    state.conversations = fresh;
    if (state.activeId && !fresh.has(state.activeId)) closeConversation();
  } catch (err) {
    toast(err.message, 'error');
  }
  renderSidebar();
}

function bindUi() {
  el.search.addEventListener('input', onSearchInput);
  el.search.addEventListener('keydown', (e) => e.key === 'Escape' && clearSearch());
  el.clearSearch.addEventListener('click', () => { clearSearch(); el.search.focus(); });
  $('#tabChats').addEventListener('click', () => setTab('chats'));
  $('#tabRooms').addEventListener('click', () => setTab('rooms'));
  $('#navChats').addEventListener('click', () => { setTab('chats'); if (state.activeId) closeConversation(); });
  $('#navRooms').addEventListener('click', () => { setView('list'); setTab('rooms'); });
  $('#newRoomBtn').addEventListener('click', openNewRoomDialog);
  $('#emptyNewRoom').addEventListener('click', openNewRoomDialog);
  $('#logoutBtn').addEventListener('click', logout);
  $('#backBtn').addEventListener('click', closeConversation);
  el.infoBtn.addEventListener('click', toggleInfo);

  el.composer.addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });
  el.input.addEventListener('input', onComposerInput);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendCurrentMessage();
    }
  });
  el.input.addEventListener('blur', stopTyping);

  document.addEventListener('visibilitychange', markActiveRead);
  window.addEventListener('focus', markActiveRead);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.infoOpen && !$('.modal')) closeInfo();
  });
  setInterval(renderHeader, 60000); // keeps "last seen 5 min ago" fresh
}

async function init() {
  hydrateIcons();
  if (!session.getToken()) return forceLogout();

  try {
    state.me = (await api.auth.me()).user;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    return undefined;
  }

  el.navMe.replaceChildren(createAvatar(state.me, { size: 'sm' }));
  el.navMe.setAttribute('aria-label', `Your profile (${state.me.username})`);
  bindUi();
  el.listBody.replaceChildren(...skeletonRows());

  const socket = connectSocket();
  bindSocket(socket);
  await loadConversations();
  return undefined;
}

init();
