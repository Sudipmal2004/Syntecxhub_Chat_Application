const http = require('http');
const config = require('./config/env');
const connectDB = require('./config/db');
const app = require('./app');
const { initSocket, resetPresence } = require('./sockets/socketHandler');

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error(`\n[mongo] Could not connect to MongoDB at ${config.mongoUri}`);
    console.error(`[mongo] ${err.message}`);
    console.error('[mongo] Make sure MongoDB is running (e.g. "mongod" or the MongoDB Windows service) and MONGO_URI in .env is correct.\n');
    process.exit(1);
  }

  await resetPresence();

  const server = http.createServer(app);
  const io = initSocket(server);

  server.listen(config.port, () => {
    console.log(`[server] Chat application running at http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down...`);
    io.close(() => {
      server.close(async () => {
        await require('mongoose').disconnect();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
