const express = require('express');
const ctrl = require('../controllers/messageController');
const { protect } = require('../middleware/authMiddleware');
const validateIdParam = require('../middleware/validateObjectId');

const router = express.Router();

router.param('id', validateIdParam);
router.param('conversationId', validateIdParam);
router.use(protect);

router.post('/', ctrl.sendMessage);
router.get('/:conversationId', ctrl.getMessages);
router.put('/:id/read', ctrl.markRead);
router.delete('/:id', ctrl.deleteMessage);

module.exports = router;
