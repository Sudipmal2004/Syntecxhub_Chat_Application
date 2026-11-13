const express = require('express');
const { listUsers, searchUsers, getUser, updateProfile } = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const { avatarUpload } = require('../middleware/upload');
const validateIdParam = require('../middleware/validateObjectId');

const router = express.Router();

router.param('id', validateIdParam);
router.use(protect);

router.get('/', listUsers);
router.get('/search', searchUsers); // must be declared before "/:id"
router.put('/profile', avatarUpload, updateProfile);
router.get('/:id', getUser);

module.exports = router;
