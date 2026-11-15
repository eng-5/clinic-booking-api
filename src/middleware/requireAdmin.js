// src/middleware/requireAdmin.js
//
// Guards a route that only the admin key may use. The caller is already known (401 was handled
// earlier), so this is "known, but not allowed": 403. It runs before the route's own logic, so a
// public key gets the same 403 whether or not the booking exists, and can't probe for bookings.

const AppError = require('../utils/appError');

module.exports = (req, res, next) =>
    req.role === 'admin' ? next() : next(new AppError('this key is not allowed to do that', 403));