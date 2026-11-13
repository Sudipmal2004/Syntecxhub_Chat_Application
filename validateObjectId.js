const { validateObjectId } = require('../utils/validators');

/**
 * Router param callback: rejects malformed ids with a 400 before any database
 * query runs. Usage: router.param('id', validateIdParam)
 */
function validateIdParam(req, res, next, value, name) {
  try {
    validateObjectId(value, name);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = validateIdParam;
