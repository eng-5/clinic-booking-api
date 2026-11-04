// src/controllers/bookingsController.js
//
// A factory: it RECEIVES its dependencies instead of importing globals.
// That is what lets tests pass a fixed clock and a test database.
// pool and clock are unused until the real handlers replace these stubs.

const notImplemented = require('../utils/notImplemented');

module.exports = ({ pool, clock }) => ({
    bookSlot: notImplemented,
    getAllBookings: notImplemented,
    getBooking: notImplemented,
    deleteBooking: notImplemented,
});