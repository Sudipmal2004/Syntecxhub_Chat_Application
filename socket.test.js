const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const h = require('./helpers');
const Message = require('../models/Message');
const User = require('../models/User');

const { api, nextEvent, neverEvent, emitAck, connectSocket, sleep } = h;
let alice; let bob; let carol; let aSock; let bSock; let conv;

test.before(async () => {
  await h.startServer();
  [alice, bob, carol] = [await h.registerUser('alice'), await h.registerUser('bob'), await h.registerUser('carol')];
  conv = (await api('POST', '/conversations', { token: alice.token, body: { participantId: bob.id } })).body.conversation;
});
test.after(() => h.stopServer());

test.describe('socket authentication', () => {
  const attempt = (auth) => new Promise((resolve) => {
    const s = ioClient(h.baseUrl(), { auth, transports: ['websocket'], reconnection: false, forceNew: true });
    s.once('connect', () => { s.disconnect(); resolve('connected'); });
    s.once('connect_error', (err) => { s.disconnect(); resolve(err.message); });
  });

  test('rejects a connection without a token', async () => {
    assert.match(await attempt({}), /authentication required/i);
  });
  test('rejects a forged token', async () => {
    assert.match(await attempt({ token: 'abc.def.ghi' }), /invalid/i);
  });
  test('accepts a valid token', async () => {
    assert.equal(await attempt({ token: alice.token }), 'connected');
  });
  test('rejects a token that was revoked by logout', async () => {
    const user = await h.registerUser('revoked');
    await api('POST', '/auth/logout', { token: user.token });
    assert.match(await attempt({ token: user.token }), /no longer valid/i);
  });
});

test.describe('presence', () => {
  test('contacts see a user go online, then offline (and the database follows)', async () => {
    aSock = await connectSocket(alice.token);
    const goesOnline = nextEvent(aSock, 'presence:update', (p) => p.userId === bob.id && p.status === 'online');
    bSock = await connectSocket(bob.token);
    await goesOnline;
    assert.equal((await User.findById(bob.id)).status, 'online');

    // A new connection announces who is already online.
    const late = await connectSocket(alice.token);
    late.disconnect();

    const goesOffline = nextEvent(aSock, 'presence:update', (p) => p.userId === bob.id && p.status === 'offline');
    bSock.disconnect();
    const update = await goesOffline;
    assert.ok(update.lastSeen);
    assert.equal((await User.findById(bob.id)).status, 'offline');
  });

  test('a quick reconnect (page refresh) does not flash offline', async () => {
    bSock = await connectSocket(bob.token);
    const flicker = neverEvent(aSock, 'presence:update', (p) => p.userId === bob.id && p.status === 'offline', 900);
    bSock.disconnect();
    await sleep(60);
    bSock = await connectSocket(bob.token);
    assert.equal(await flicker, true);
  });
});

test.describe('private messaging', () => {
  test('delivers a message in real time, saves it, and reports delivery', async () => {
    const received = nextEvent(bSock, 'message:new');
    const delivered = nextEvent(aSock, 'message:delivered', (p) => p.userIds.includes(bob.id));
    const ack = await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'hi bob, live!', clientId: 'c-1' });

    assert.equal(ack.ok, true);
    const msg = await received;
    assert.equal(msg.content, 'hi bob, live!');
    assert.equal(msg.sender.id, alice.id);
    assert.equal(msg.clientId, 'c-1');
    await delivered;

    const stored = await Message.findById(ack.message.id);
    assert.equal(stored.content, 'hi bob, live!'); // saved before the ack was sent
    assert.ok(stored.deliveredTo.map(String).includes(bob.id));
  });

  test('a duplicate send (same clientId) is acknowledged but not re-broadcast or re-saved', async () => {
    const before = await Message.countDocuments({ conversation: conv.id });
    const echo = neverEvent(bSock, 'message:new', (m) => m.content === 'dup-check');
    const first = await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'dup-check', clientId: 'c-dup' });
    const second = await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'dup-check', clientId: 'c-dup' });
    assert.equal(first.message.id, second.message.id);
    assert.equal(await Message.countDocuments({ conversation: conv.id }), before + 1);
    await echo; // the first send was broadcast once; the retry added nothing
  });

  test('typing indicators reach the other participant only', async () => {
    const start = nextEvent(bSock, 'typing', (p) => p.isTyping === true);
    aSock.emit('typing:start', { conversationId: conv.id });
    const evt = await start;
    assert.equal(evt.userId, alice.id);
    assert.equal(evt.username, alice.username);
    const stop = nextEvent(bSock, 'typing', (p) => p.isTyping === false);
    aSock.emit('typing:stop', { conversationId: conv.id });
    await stop;
  });

  test('read receipts are pushed to the sender', async () => {
    const read = nextEvent(aSock, 'message:read', (p) => p.userId === bob.id);
    const ack = await emitAck(bSock, 'message:read', { conversationId: conv.id });
    assert.equal(ack.ok, true);
    assert.ok(ack.count >= 1);
    await read;
    const msgs = await api('GET', `/messages/${conv.id}`, { token: alice.token });
    assert.ok(msgs.body.messages.filter((m) => m.sender.id === alice.id).every((m) => m.readBy.includes(bob.id)));
  });

  test('outsiders receive nothing and cannot send or type into the conversation', async () => {
    const cSock = await connectSocket(carol.token);
    const leak = neverEvent(cSock, 'message:new');
    const typingLeak = neverEvent(cSock, 'typing');
    const denied = await emitAck(cSock, 'message:send', { conversationId: conv.id, content: 'let me in' });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    const deniedTyping = await emitAck(cSock, 'typing:start', { conversationId: conv.id });
    assert.equal(deniedTyping.ok, false);

    await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'private words' });
    assert.equal(await leak, true);
    assert.equal(await typingLeak, true);
    cSock.disconnect();
  });

  test('invalid payloads get an error acknowledgement instead of crashing', async () => {
    for (const payload of [null, {}, { conversationId: 'bad', content: 'x' }, { conversationId: conv.id, content: '' }, { conversationId: conv.id, content: 'x'.repeat(2001) }, { conversationId: conv.id, content: { $ne: 1 } }]) {
      const ack = await emitAck(aSock, 'message:send', payload);
      assert.equal(ack.ok, false, JSON.stringify(payload));
      assert.ok([400, 404].includes(ack.status));
    }
  });

  test('messages sent while the recipient is offline are stored and marked delivered when they reconnect', async () => {
    bSock.disconnect();
    await nextEvent(aSock, 'presence:update', (p) => p.userId === bob.id && p.status === 'offline');
    const ack = await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'while you were away' });
    assert.equal(ack.ok, true);
    assert.equal((await Message.findById(ack.message.id)).deliveredTo.length, 0);

    const delivered = nextEvent(aSock, 'message:delivered', (p) => p.messageIds.includes(ack.message.id));
    bSock = await connectSocket(bob.token);
    await delivered;
    assert.equal((await Message.findById(ack.message.id)).deliveredTo.map(String).includes(bob.id), true);
  });

  test('history sync after reconnect: ?after=<lastSeenId> returns exactly the missed messages', async () => {
    const last = (await api('GET', `/messages/${conv.id}?limit=1`, { token: bob.token })).body.messages[0];
    await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'missed 1' });
    await emitAck(aSock, 'message:send', { conversationId: conv.id, content: 'missed 2' });
    const sync = await api('GET', `/messages/${conv.id}?after=${last.id}`, { token: bob.token });
    assert.deepEqual(sync.body.messages.map((m) => m.content), ['missed 1', 'missed 2']);
  });

  test('REST-sent messages are pushed over the socket too, and deletes are broadcast', async () => {
    const received = nextEvent(bSock, 'message:new', (m) => m.content === 'via rest');
    const res = await api('POST', '/messages', { token: alice.token, body: { conversationId: conv.id, content: 'via rest' } });
    assert.equal(res.status, 201);
    await received;
    const deleted = nextEvent(bSock, 'message:deleted', (p) => p.messageId === res.body.message.id);
    await api('DELETE', `/messages/${res.body.message.id}`, { token: alice.token });
    await deleted;
  });

  test('logging out disconnects the user\'s sockets', async () => {
    const user = await h.registerUser('lo');
    const s = await connectSocket(user.token);
    const closed = new Promise((resolve) => s.once('disconnect', resolve));
    await api('POST', '/auth/logout', { token: user.token });
    assert.ok(await closed);
  });
});

test.describe('group rooms', () => {
  let room; let cSock;
  test('group messages reach every member in real time', async () => {
    cSock = await connectSocket(carol.token);
    const created = await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Team Chat', participantIds: [bob.id, carol.id], isPublic: false } });
    assert.equal(created.status, 201);
    room = created.body.conversation;

    const toBob = nextEvent(bSock, 'message:new', (m) => m.content === 'hello team');
    const toCarol = nextEvent(cSock, 'message:new', (m) => m.content === 'hello team');
    const ack = await emitAck(aSock, 'message:send', { conversationId: room.id, content: 'hello team' });
    assert.equal(ack.ok, true);
    const [b, c] = await Promise.all([toBob, toCarol]);
    assert.equal(b.sender.username, alice.username);
    assert.equal(c.conversation, room.id);
  });

  test('members added after connecting get the room instantly (conversation:new)', async () => {
    const dave = await h.registerUser('dave');
    const dSock = await connectSocket(dave.token);
    const announced = nextEvent(dSock, 'conversation:new', (c) => c.id === room.id);
    await api('POST', `/conversations/${room.id}/members`, { token: alice.token, body: { userIds: [dave.id] } });
    await announced;
    const got = nextEvent(dSock, 'message:new', (m) => m.content === 'welcome dave');
    await emitAck(bSock, 'message:send', { conversationId: room.id, content: 'welcome dave' });
    await got;
    dSock.disconnect();
  });

  test('group typing indicator is shown to all other members', async () => {
    const seen = nextEvent(cSock, 'typing', (p) => p.userId === bob.id && p.isTyping);
    bSock.emit('typing:start', { conversationId: room.id });
    await seen;
  });

  test('joining a public room over the socket and leaving it', async () => {
    const pub = (await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Open House', participantIds: [], isPublic: true } })).body.conversation;

    const joinedEvt = nextEvent(aSock, 'room:member_joined', (p) => p.conversationId === pub.id);
    const join = await emitAck(bSock, 'room:join', { conversationId: pub.id });
    assert.equal(join.ok, true);
    assert.equal(join.joined, true);
    await joinedEvt;

    const live = nextEvent(bSock, 'message:new', (m) => m.content === 'now you can hear me');
    await emitAck(aSock, 'message:send', { conversationId: pub.id, content: 'now you can hear me' });
    await live;

    const leftEvt = nextEvent(aSock, 'room:member_left', (p) => p.userId === bob.id);
    const leave = await emitAck(bSock, 'room:leave', { conversationId: pub.id });
    assert.equal(leave.ok, true);
    await leftEvt;

    const silent = neverEvent(bSock, 'message:new', (m) => m.content === 'after you left');
    await emitAck(aSock, 'message:send', { conversationId: pub.id, content: 'after you left' });
    assert.equal(await silent, true);
  });

  test('leaving via REST also stops live delivery', async () => {
    const pub = (await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'REST Leave', participantIds: [bob.id], isPublic: true } })).body.conversation;
    assert.equal((await api('POST', `/conversations/${pub.id}/leave`, { token: bob.token })).status, 200);
    const silent = neverEvent(bSock, 'message:new', (m) => m.content === 'ghost');
    await emitAck(aSock, 'message:send', { conversationId: pub.id, content: 'ghost' });
    assert.equal(await silent, true);
  });

  test('private rooms cannot be joined over the socket', async () => {
    const denied = await emitAck(cSock, 'room:join', { conversationId: (await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Hidden', participantIds: [] } })).body.conversation.id });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
  });

  test('flooding is rate limited per socket', async () => {
    const flood = await connectSocket(alice.token);
    const acks = [];
    for (let i = 0; i < 25; i += 1) acks.push(await emitAck(flood, 'message:send', { conversationId: conv.id, content: `flood ${i}` }));
    assert.ok(acks.some((a) => a.status === 429));
    flood.disconnect();
  });
});
