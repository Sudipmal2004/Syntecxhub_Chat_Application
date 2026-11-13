const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const User = require('../models/User');

const { api } = h;
let alice; let bob; let carol;

test.before(async () => {
  await h.startServer();
});
test.after(() => h.stopServer());

test('health endpoint reports a connected MongoDB', async () => {
  const res = await api('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.database, 'connected');
});

test.describe('registration', () => {
  test('registers a user, returns a token and never returns the password', async () => {
    const res = await api('POST', '/auth/register', { body: { username: 'Alice_01', email: 'Alice@Example.com', password: 'Secret123' } });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, 'alice@example.com'); // normalised
    assert.equal(res.body.user.password, undefined);
    alice = { ...res.body.user, token: res.body.token };
  });

  test('stores a bcrypt hash, never the plain-text password', async () => {
    const doc = await User.findById(alice.id).select('+password');
    assert.notEqual(doc.password, 'Secret123');
    assert.match(doc.password, /^\$2[aby]\$\d{2}\$/);
    assert.ok(await doc.comparePassword('Secret123'));
  });

  test('rejects a duplicate email (409)', async () => {
    const res = await api('POST', '/auth/register', { body: { username: 'other_name', email: 'alice@example.com', password: 'Secret123' } });
    assert.equal(res.status, 409);
  });

  test('rejects a duplicate username regardless of case (409)', async () => {
    const res = await api('POST', '/auth/register', { body: { username: 'ALICE_01', email: 'x@example.com', password: 'Secret123' } });
    assert.equal(res.status, 409);
  });

  const invalid = [
    ['short password', { username: 'validname', email: 'v@example.com', password: 'a1' }],
    ['password without a number', { username: 'validname', email: 'v@example.com', password: 'onlyletters' }],
    ['invalid email', { username: 'validname', email: 'not-an-email', password: 'Secret123' }],
    ['username with spaces', { username: 'bad name!', email: 'v@example.com', password: 'Secret123' }],
    ['username too short', { username: 'ab', email: 'v@example.com', password: 'Secret123' }],
    ['non-string fields (NoSQL injection attempt)', { username: { $ne: 1 }, email: { $gt: '' }, password: { $ne: 1 } }],
    ['empty body', {}],
  ];
  for (const [name, body] of invalid) {
    test(`rejects ${name} (400)`, async () => {
      const res = await api('POST', '/auth/register', { body });
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
    });
  }

  test('rejects malformed JSON (400)', async () => {
    const res = await api('POST', '/auth/register', { raw: '{"username": ' });
    assert.equal(res.status, 400);
  });
});

test.describe('login, session and logout', () => {
  test('logs in with valid credentials', async () => {
    const res = await api('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'Secret123' } });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    alice.token = res.body.token;
  });

  test('wrong password and unknown email return the same 401 message', async () => {
    const wrong = await api('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'WrongPass1' } });
    const unknown = await api('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'WrongPass1' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, unknown.body.message);
  });

  test('rejects an operator-injection login (400)', async () => {
    const res = await api('POST', '/auth/login', { body: { email: { $ne: null }, password: { $ne: null } } });
    assert.equal(res.status, 400);
  });

  test('GET /auth/me requires a valid token', async () => {
    assert.equal((await api('GET', '/auth/me')).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: 'garbage' })).status, 401);
    const ok = await api('GET', '/auth/me', { token: alice.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.username, 'Alice_01');
    assert.equal(ok.body.user.password, undefined);
  });

  test('logout revokes the token', async () => {
    const temp = await h.registerUser('temp');
    assert.equal((await api('GET', '/auth/me', { token: temp.token })).status, 200);
    assert.equal((await api('POST', '/auth/logout', { token: temp.token })).status, 200);
    assert.equal((await api('GET', '/auth/me', { token: temp.token })).status, 401);
  });
});

test.describe('users', () => {
  test.before(async () => {
    bob = await h.registerUser('bob');
    carol = await h.registerUser('carol');
  });

  test('GET /users lists other users with pagination and without secrets', async () => {
    const res = await api('GET', '/users?limit=2', { token: alice.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length <= 2);
    assert.ok(res.body.users.every((u) => u.id !== alice.id && u.password === undefined && u.email === undefined));
    assert.ok(res.body.pagination.total >= 2);
  });

  test('GET /users rejects an invalid limit (400)', async () => {
    assert.equal((await api('GET', '/users?limit=-5', { token: alice.token })).status, 400);
  });

  test('search finds users case-insensitively and excludes the caller', async () => {
    const res = await api('GET', `/users/search?q=${bob.username.toUpperCase()}`, { token: alice.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.users.map((u) => u.id), [bob.id]);
    const self = await api('GET', '/users/search?q=alice', { token: alice.token });
    assert.equal(self.body.users.length, 0);
  });

  test('search treats input as text, not as a regular expression', async () => {
    const res = await api('GET', `/users/search?q=${encodeURIComponent('.*')}`, { token: alice.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 0);
  });

  test('search requires q (400) and a token (401)', async () => {
    assert.equal((await api('GET', '/users/search', { token: alice.token })).status, 400);
    assert.equal((await api('GET', '/users/search?q=bob')).status, 401);
  });

  test('GET /users/:id returns a public profile, 404 and 400 otherwise', async () => {
    const ok = await api('GET', `/users/${bob.id}`, { token: alice.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.username, bob.username);
    assert.equal(ok.body.user.email, undefined);
    assert.equal((await api('GET', '/users/64b64b64b64b64b64b64b64b', { token: alice.token })).status, 404);
    assert.equal((await api('GET', '/users/not-an-id', { token: alice.token })).status, 400);
  });

  test('PUT /users/profile updates bio and username', async () => {
    const res = await api('PUT', '/users/profile', { token: alice.token, body: { bio: 'Hello <b>world</b>', username: 'Alice_Renamed' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'Alice_Renamed');
    assert.equal(res.body.user.bio, 'Hello <b>world</b>'); // stored as text; the UI renders it with textContent
  });

  test('PUT /users/profile rejects a taken username (409) and invalid input (400)', async () => {
    assert.equal((await api('PUT', '/users/profile', { token: alice.token, body: { username: bob.username } })).status, 409);
    assert.equal((await api('PUT', '/users/profile', { token: alice.token, body: { username: 'x' } })).status, 400);
    assert.equal((await api('PUT', '/users/profile', { token: alice.token, body: { bio: 'a'.repeat(200) } })).status, 400);
  });

  test('changing the password needs the current password and revokes old tokens', async () => {
    const user = await h.registerUser('pw');
    const bad = await api('PUT', '/users/profile', { token: user.token, body: { currentPassword: 'wrong-one1', newPassword: 'Brand-new1' } });
    assert.equal(bad.status, 400);
    const good = await api('PUT', '/users/profile', { token: user.token, body: { currentPassword: user.password, newPassword: 'Brand-new1' } });
    assert.equal(good.status, 200);
    assert.ok(good.body.token);
    assert.equal((await api('GET', '/auth/me', { token: user.token })).status, 401); // old token revoked
    assert.equal((await api('GET', '/auth/me', { token: good.body.token })).status, 200);
    const login = await api('POST', '/auth/login', { body: { email: user.email, password: 'Brand-new1' } });
    assert.equal(login.status, 200);
  });
});

let privateConv;
test.describe('conversations', () => {
  test('creates a private conversation once and then returns the same one', async () => {
    const first = await api('POST', '/conversations', { token: alice.token, body: { participantId: bob.id } });
    assert.equal(first.status, 201);
    assert.equal(first.body.conversation.conversationType, 'private');
    const second = await api('POST', '/conversations', { token: bob.token, body: { participantId: alice.id } });
    assert.equal(second.status, 200);
    assert.equal(second.body.conversation.id, first.body.conversation.id);
    privateConv = first.body.conversation;
  });

  test('concurrent creation never produces duplicates', async () => {
    const dave = await h.registerUser('dave');
    const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/conversations', { token: alice.token, body: { participantId: dave.id } })));
    assert.equal(new Set(results.map((r) => r.body.conversation.id)).size, 1);
  });

  test('rejects chatting with yourself (400), unknown users (404) and bad ids (400)', async () => {
    assert.equal((await api('POST', '/conversations', { token: alice.token, body: { participantId: alice.id } })).status, 400);
    assert.equal((await api('POST', '/conversations', { token: alice.token, body: { participantId: '64b64b64b64b64b64b64b64b' } })).status, 404);
    assert.equal((await api('POST', '/conversations', { token: alice.token, body: { participantId: 'zzz' } })).status, 400);
  });

  test('empty private chats are hidden from the list until a message exists', async () => {
    const list = await api('GET', '/conversations', { token: bob.token });
    assert.equal(list.body.conversations.filter((c) => c.id === privateConv.id).length, 0);
  });

  test('only participants can read a conversation (403)', async () => {
    assert.equal((await api('GET', `/conversations/${privateConv.id}`, { token: carol.token })).status, 403);
    assert.equal((await api('GET', `/conversations/${privateConv.id}`, { token: alice.token })).status, 200);
    assert.equal((await api('GET', '/conversations/64b64b64b64b64b64b64b64b', { token: alice.token })).status, 404);
  });

  let room;
  test('creates a group, lists public rooms, enforces join rules and leave', async () => {
    const created = await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Study Group', participantIds: [bob.id], isPublic: true } });
    assert.equal(created.status, 201);
    room = created.body.conversation;
    assert.equal(room.groupAdmin, alice.id);
    assert.equal(room.participants.length, 2);

    const rooms = await api('GET', '/conversations/rooms/public?q=study', { token: carol.token });
    assert.ok(rooms.body.rooms.some((r) => r.id === room.id && r.joined === false));

    assert.equal((await api('POST', `/conversations/${room.id}/join`, { token: carol.token })).status, 200);
    assert.equal((await api('GET', `/conversations/${room.id}`, { token: carol.token })).status, 200);
    assert.equal((await api('POST', `/conversations/${room.id}/leave`, { token: carol.token })).status, 200);
    assert.equal((await api('GET', `/conversations/${room.id}`, { token: carol.token })).status, 403);
  });

  test('private rooms cannot be joined; only the admin can add members', async () => {
    const created = await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Secret Room', participantIds: [], isPublic: false } });
    const id = created.body.conversation.id;
    assert.equal((await api('POST', `/conversations/${id}/join`, { token: carol.token })).status, 403);
    assert.equal((await api('POST', `/conversations/${id}/members`, { token: bob.token, body: { userIds: [carol.id] } })).status, 403);
    const added = await api('POST', `/conversations/${id}/members`, { token: alice.token, body: { userIds: [carol.id] } });
    assert.equal(added.status, 200);
    assert.equal(added.body.conversation.participants.length, 2);
  });

  test('group validation: name length, bad ids, unknown users', async () => {
    assert.equal((await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'x' } })).status, 400);
    assert.equal((await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Valid', participantIds: ['nope'] } })).status, 400);
    assert.equal((await api('POST', '/conversations/group', { token: alice.token, body: { groupName: 'Valid', participantIds: ['64b64b64b64b64b64b64b64b'] } })).status, 404);
  });
});

test.describe('messages', () => {
  let sent;
  test('sends a message, saves it and returns it (201)', async () => {
    const res = await api('POST', '/messages', { token: alice.token, body: { conversationId: privateConv.id, content: '  Hello Bob  ' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.message.content, 'Hello Bob');
    assert.equal(res.body.message.sender.id, alice.id);
    assert.deepEqual(res.body.message.readBy, [alice.id]);
    sent = res.body.message;
  });

  test('the conversation now appears in both users\' lists with unread counts', async () => {
    const bobList = await api('GET', '/conversations', { token: bob.token });
    const entry = bobList.body.conversations.find((c) => c.id === privateConv.id);
    assert.ok(entry);
    assert.equal(entry.unreadCount, 1);
    assert.equal(entry.lastMessage.content, 'Hello Bob');
    const aliceList = await api('GET', '/conversations', { token: alice.token });
    assert.equal(aliceList.body.conversations.find((c) => c.id === privateConv.id).unreadCount, 0);
  });

  test('validates content, type and ids', async () => {
    const send = (body) => api('POST', '/messages', { token: alice.token, body });
    assert.equal((await send({ conversationId: privateConv.id, content: '   ' })).status, 400);
    assert.equal((await send({ conversationId: privateConv.id, content: 'x'.repeat(2001) })).status, 400);
    assert.equal((await send({ conversationId: privateConv.id, content: { $ne: 1 } })).status, 400);
    assert.equal((await send({ conversationId: privateConv.id, content: 'hi', messageType: 'system' })).status, 400);
    assert.equal((await send({ conversationId: 'bad', content: 'hi' })).status, 400);
    assert.equal((await send({ conversationId: '64b64b64b64b64b64b64b64b', content: 'hi' })).status, 404);
  });

  test('non-participants cannot send or read (403)', async () => {
    assert.equal((await api('POST', '/messages', { token: carol.token, body: { conversationId: privateConv.id, content: 'sneaky' } })).status, 403);
    assert.equal((await api('GET', `/messages/${privateConv.id}`, { token: carol.token })).status, 403);
    assert.equal((await api('PUT', `/messages/${sent.id}/read`, { token: carol.token })).status, 403);
  });

  test('retrying with the same clientId does not duplicate the message', async () => {
    const body = { conversationId: privateConv.id, content: 'idempotent', clientId: 'client-abc-1' };
    const a = await api('POST', '/messages', { token: alice.token, body });
    const b = await api('POST', '/messages', { token: alice.token, body });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.message.id, b.body.message.id);
  });

  test('history is paginated oldest-first with before/after cursors', async () => {
    const conv = (await api('POST', '/conversations', { token: bob.token, body: { participantId: carol.id } })).body.conversation;
    for (let i = 1; i <= 7; i += 1) await api('POST', '/messages', { token: bob.token, body: { conversationId: conv.id, content: `msg ${i}` } });

    const page1 = await api('GET', `/messages/${conv.id}?limit=3`, { token: carol.token });
    assert.deepEqual(page1.body.messages.map((m) => m.content), ['msg 5', 'msg 6', 'msg 7']);
    assert.equal(page1.body.pagination.hasMore, true);

    const page2 = await api('GET', `/messages/${conv.id}?limit=3&before=${page1.body.pagination.nextCursor}`, { token: carol.token });
    assert.deepEqual(page2.body.messages.map((m) => m.content), ['msg 2', 'msg 3', 'msg 4']);

    const page3 = await api('GET', `/messages/${conv.id}?limit=3&before=${page2.body.pagination.nextCursor}`, { token: carol.token });
    assert.deepEqual(page3.body.messages.map((m) => m.content), ['msg 1']);
    assert.equal(page3.body.pagination.hasMore, false);

    const newer = await api('GET', `/messages/${conv.id}?after=${page2.body.messages[0].id}&limit=2`, { token: carol.token });
    assert.deepEqual(newer.body.messages.map((m) => m.content), ['msg 3', 'msg 4']);
    assert.equal(newer.body.pagination.hasMore, true);

    assert.equal((await api('GET', `/messages/${conv.id}?limit=0`, { token: carol.token })).status, 400);
    assert.equal((await api('GET', `/messages/${conv.id}?before=bad`, { token: carol.token })).status, 400);
  });

  test('PUT /messages/:id/read marks the message read for the caller', async () => {
    const res = await api('PUT', `/messages/${sent.id}/read`, { token: bob.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.readBy.includes(bob.id));
    const list = await api('GET', '/conversations', { token: bob.token });
    assert.equal(list.body.conversations.find((c) => c.id === privateConv.id).unreadCount, 1); // only the idempotent one is left
    assert.equal((await api('PUT', '/messages/64b64b64b64b64b64b64b64b/read', { token: bob.token })).status, 404);
  });

  test('only the sender can delete a message; deletion blanks the content', async () => {
    assert.equal((await api('DELETE', `/messages/${sent.id}`, { token: bob.token })).status, 403);
    assert.equal((await api('DELETE', `/messages/${sent.id}`, { token: alice.token })).status, 200);
    const history = await api('GET', `/messages/${privateConv.id}`, { token: bob.token });
    const gone = history.body.messages.find((m) => m.id === sent.id);
    assert.equal(gone.isDeleted, true);
    assert.equal(gone.content, '');
  });
});

test.describe('platform behaviour', () => {
  test('unknown API routes return a JSON 404', async () => {
    const res = await api('GET', '/does-not-exist', { token: alice.token });
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });

  test('protected routes reject missing tokens (401)', async () => {
    for (const [method, path] of [['GET', '/users'], ['GET', '/conversations'], ['POST', '/messages'], ['GET', '/messages/64b64b64b64b64b64b64b64b']]) {
      assert.equal((await api(method, path)).status, 401, `${method} ${path}`);
    }
  });

  test('responses carry security headers and hide the framework', async () => {
    const res = await fetch(`${h.baseUrl()}/api/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  });

  test('CORS only allows configured origins', async () => {
    const allowed = await fetch(`${h.baseUrl()}/api/health`, { headers: { Origin: 'http://localhost:3000' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const denied = await fetch(`${h.baseUrl()}/api/health`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});
