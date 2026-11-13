/* Generates postman/chat-application.postman_collection.json (run: node scripts/build-postman.js). */
const fs = require('fs');
const path = require('path');

const json = (body) => ({ mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } });
const url = (p, query) => ({ raw: `{{baseUrl}}/api${p}${query ? `?${query.map((q) => q.join('=')).join('&')}` : ''}`, host: ['{{baseUrl}}'], path: ['api', ...p.split('/').filter(Boolean)], query: query ? query.map(([key, value]) => ({ key, value })) : undefined });
const auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] };
const script = (lines) => [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];

function req(name, method, p, { body, query, tests = [], noAuth, formdata } = {}) {
  const status = tests.find((t) => typeof t === 'number');
  const lines = [`pm.test('status is ${status || 200}', () => pm.response.to.have.status(${status || 200}));`, ...tests.filter((t) => typeof t === 'string')];
  return {
    name,
    request: { method, header: [], ...(noAuth ? { auth: { type: 'noauth' } } : {}), url: url(p, query), ...(body ? { body: json(body) } : {}), ...(formdata ? { body: { mode: 'formdata', formdata } } : {}) },
    event: script(lines),
  };
}

const saveUser = (tokenVar, idVar) => [
  'const j = pm.response.json();',
  `pm.collectionVariables.set('${tokenVar}', j.token);`,
  `pm.collectionVariables.set('${idVar}', j.user.id);`,
];

const collection = {
  info: { name: 'Pulse Chat API', description: 'Run the folders top to bottom (or use the Collection Runner). Start the server first: npm run dev', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth,
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'runId', value: '' },
    { key: 'token', value: '' }, { key: 'userId', value: '' },
    { key: 'token2', value: '' }, { key: 'userId2', value: '' },
    { key: 'conversationId', value: '' }, { key: 'groupId', value: '' }, { key: 'messageId', value: '' },
  ],
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["if (!pm.collectionVariables.get('runId')) pm.collectionVariables.set('runId', Date.now().toString(36));"] } }],
  item: [
    {
      name: '1. Authentication',
      item: [
        req('Register user A', 'POST', '/auth/register', { noAuth: true, body: { username: 'alice_{{runId}}', email: 'alice_{{runId}}@example.com', password: 'Passw0rd!x' }, tests: [201, "pm.test('no password in response', () => pm.expect(pm.response.text()).to.not.include('Passw0rd'));", ...saveUser('token', 'userId')] }),
        req('Register user B', 'POST', '/auth/register', { noAuth: true, body: { username: 'bob_{{runId}}', email: 'bob_{{runId}}@example.com', password: 'Passw0rd!x' }, tests: [201, ...saveUser('token2', 'userId2')] }),
        req('Register - duplicate email (409)', 'POST', '/auth/register', { noAuth: true, body: { username: 'other_{{runId}}', email: 'alice_{{runId}}@example.com', password: 'Passw0rd!x' }, tests: [409] }),
        req('Register - weak password (400)', 'POST', '/auth/register', { noAuth: true, body: { username: 'weak_{{runId}}', email: 'weak_{{runId}}@example.com', password: '123' }, tests: [400] }),
        req('Login', 'POST', '/auth/login', { noAuth: true, body: { email: 'alice_{{runId}}@example.com', password: 'Passw0rd!x' }, tests: [200, "pm.collectionVariables.set('token', pm.response.json().token);"] }),
        req('Login - wrong password (401)', 'POST', '/auth/login', { noAuth: true, body: { email: 'alice_{{runId}}@example.com', password: 'WrongPass1' }, tests: [401] }),
        req('Current user (GET /auth/me)', 'GET', '/auth/me', { tests: [200, "pm.test('returns own email', () => pm.expect(pm.response.json().user.email).to.include('alice_'));"] }),
        req('Current user without token (401)', 'GET', '/auth/me', { noAuth: true, tests: [401] }),
      ],
    },
    {
      name: '2. Users',
      item: [
        req('List users', 'GET', '/users', { query: [['limit', '10']], tests: [200] }),
        req('Search users', 'GET', '/users/search', { query: [['q', 'bob_']], tests: [200, "pm.test('finds bob', () => pm.expect(pm.response.json().users.length).to.be.above(0));"] }),
        req('Get user by id', 'GET', '/users/{{userId2}}', { tests: [200] }),
        req('Get user - invalid id (400)', 'GET', '/users/not-an-id', { tests: [400] }),
        req('Update profile', 'PUT', '/users/profile', { body: { bio: 'Hello from Postman' }, tests: [200, "pm.test('bio saved', () => pm.expect(pm.response.json().user.bio).to.eql('Hello from Postman'));"] }),
      ],
    },
    {
      name: '3. Conversations',
      item: [
        req('Start private conversation', 'POST', '/conversations', { body: { participantId: '{{userId2}}' }, tests: [201, "pm.collectionVariables.set('conversationId', pm.response.json().conversation.id);"] }),
        req('Same request returns the existing one (200)', 'POST', '/conversations', { body: { participantId: '{{userId2}}' }, tests: [200] }),
        req('Create group room', 'POST', '/conversations/group', { body: { groupName: 'Postman Room {{runId}}', participantIds: ['{{userId2}}'], isPublic: true }, tests: [201, "pm.collectionVariables.set('groupId', pm.response.json().conversation.id);"] }),
        req('List my conversations', 'GET', '/conversations', { tests: [200] }),
        req('Get conversation', 'GET', '/conversations/{{conversationId}}', { tests: [200] }),
        req('Discover public rooms', 'GET', '/conversations/rooms/public', { query: [['q', 'postman']], tests: [200] }),
        req('Participant can read their conversation', 'GET', '/conversations/{{conversationId}}', { tests: [200] }),
      ],
    },
    {
      name: '4. Messages',
      item: [
        req('Send message', 'POST', '/messages', { body: { conversationId: '{{conversationId}}', content: 'Hello from Postman!' }, tests: [201, "pm.collectionVariables.set('messageId', pm.response.json().message.id);"] }),
        req('Send empty message (400)', 'POST', '/messages', { body: { conversationId: '{{conversationId}}', content: '   ' }, tests: [400] }),
        req('Get history (paginated)', 'GET', '/messages/{{conversationId}}', { query: [['limit', '20']], tests: [200, "pm.test('has pagination', () => pm.expect(pm.response.json().pagination).to.have.property('hasMore'));"] }),
        req('Mark message as read', 'PUT', '/messages/{{messageId}}/read', { tests: [200] }),
        req('Delete own message', 'DELETE', '/messages/{{messageId}}', { tests: [200] }),
      ],
    },
    { name: '5. Logout', item: [req('Logout (revokes the token)', 'POST', '/auth/logout', { tests: [200] }), req('Old token is rejected (401)', 'GET', '/auth/me', { tests: [401] })] },
  ],
};

const target = path.join(__dirname, '..', 'postman', 'chat-application.postman_collection.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`wrote ${target}`);
