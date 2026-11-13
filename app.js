const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const mongoose = require('mongoose');

const config = require('./config/env');
const AppError = require('./utils/AppError');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { apiLimiter } = require('./middleware/rateLimiters');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const messageRoutes = require('./routes/messageRoutes');

const app = express();

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// Security headers. The strict CSP is possible because the front end ships no inline scripts or styles.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: config.isProd,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS: same-origin requests need nothing; other origins must be listed in CLIENT_ORIGIN.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.get('/api/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const database = states[mongoose.connection.readyState] || 'unknown';
  res.status(database === 'connected' ? 200 : 503).json({ success: database === 'connected', status: 'ok', database, uptime: Math.round(process.uptime()) });
});

app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api', (req, res, next) => next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404)));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
app.use(notFound);
app.use(errorHandler);

module.exports = app;
