const express = require('express');
const { register, login, logout, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/logout', protect, logout);
router.get('/me', protect, me);

module.exports = router;
