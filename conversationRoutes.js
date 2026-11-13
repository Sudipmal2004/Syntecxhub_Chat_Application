const express = require('express');
const ctrl = require('../controllers/conversationController');
const { protect } = require('../middleware/authMiddleware');
const validateIdParam = require('../middleware/validateObjectId');

const router = express.Router();

router.param('id', validateIdParam);
router.use(protect);

router.route('/').post(ctrl.createPrivate).get(ctrl.listConversations);
router.post('/group', ctrl.createGroup);
router.get('/rooms/public', ctrl.listPublicRooms);
router.post('/:id/join', ctrl.joinRoom);
router.post('/:id/leave', ctrl.leaveRoom);
router.post('/:id/members', ctrl.addMembers);
router.get('/:id', ctrl.getConversation);

module.exports = router;
