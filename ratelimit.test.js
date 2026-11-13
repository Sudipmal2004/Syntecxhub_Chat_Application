process.env.LOGIN_RATE_LIMIT_MAX = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.before(() => h.startServer());
test.after(() => h.stopServer());

test('login is rate limited after repeated failures, while successful logins do not count', async () => {
  const user = await h.registerUser('limited');
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await h.api('POST', '/auth/login', { body: { email: user.email, password: user.password } })).status, 200);
  }
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await h.api('POST', '/auth/login', { body: { email: user.email, password: 'WrongPass9' } })).status);
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(statuses[4], 429);
  // Even the correct password is blocked while the limit is active.
  assert.equal((await h.api('POST', '/auth/login', { body: { email: user.email, password: user.password } })).status, 429);
});
