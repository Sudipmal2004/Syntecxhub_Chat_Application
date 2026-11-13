/* Shared test utilities: boots the real app on a random port with an isolated database. */
const http = require('http');
const { io: ioClient } = require('socket.io-client');

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/chat_application_test';
process.env.JWT_SECRET = 'test_secret_test_secret_test_secret_test_secret_1234';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests only
process.env.PRESENCE_GRACE_MS = '250';
process.env.LOGIN_RATE_LIMIT_MAX = process.env.LOGIN_RATE_LIMIT_MAX || '1000';
process.env.REGISTER_RATE_LIMIT_MAX = process.env.REGISTER_RATE_LIMIT_MAX || '1000';
process.env.API_RATE_LIMIT_MAX = '5000';

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const app = require('../app');
const { initSocket } = require('../sockets/socketHandler');

let server;
let baseUrl;
const openSockets = new Set();

async function startServer() {
  await connectDB();
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // build indexes on the fresh DB
  server = http.createServer(app);
  initSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  openSockets.forEach((s) => s.disconnect());
  openSockets.clear();
  await sleep(Number(process.env.PRESENCE_GRACE_MS) + 150); // let pending offline timers finish before the DB closes
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}/api${path}`, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: data };
}

let counter = 0;
async function registerUser(name) {
  counter += 1;
  const username = `${name}${counter}`;
  const res = await api('POST', '/auth/register', { body: { username, email: `${username}@example.com`, password: 'Passw0rd!x' } });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.user, token: res.body.token, username, password: 'Passw0rd!x' };
}

/** Connects a socket and resolves once the server finished its per-connection setup (presence:snapshot). */
function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    openSockets.add(socket);
    socket.once('presence:snapshot', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 4000);
  });
}

function nextEvent(socket, event, predicate = () => true, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`timeout waiting for "${event}"`)); }, ms);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Resolves true if the event does NOT arrive within `ms` (used for "must not receive" assertions). */
function neverEvent(socket, event, predicate = () => true, ms = 600) {
  return new Promise((resolve) => {
    const handler = (payload) => { if (predicate(payload)) { clearTimeout(timer); socket.off(event, handler); resolve(false); } };
    const timer = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.on(event, handler);
  });
}

const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const baseUrlOf = () => baseUrl;

module.exports = { baseUrl: baseUrlOf, startServer, stopServer, api, registerUser, connectSocket, nextEvent, neverEvent, emitAck, sleep, mongoose };
