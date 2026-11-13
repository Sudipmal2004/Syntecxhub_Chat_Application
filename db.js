const mongoose = require('mongoose');
const config = require('./env');

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[mongo] reconnected'));
  mongoose.connection.on('error', (err) => console.error('[mongo] error:', err.message));
}

/**
 * Connects Mongoose to MongoDB. Throws if the server cannot be reached so the
 * caller can decide how to fail (server.js exits with a helpful message).
 */
async function connectDB(uri = config.mongoUri) {
  attachConnectionListeners();
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const { host, port, name } = mongoose.connection;
  console.log(`[mongo] connected to ${host}:${port}/${name}`);
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.disconnectDB = disconnectDB;
