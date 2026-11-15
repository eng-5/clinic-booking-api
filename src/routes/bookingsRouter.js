// src/routes/bookingsRouter.js
//
// Also a factory: createApp calls bookingsRouter({ pool, clock }) and mounts the result.
// Paths here are relative to the mount point, so '/' means /bookings and '/:id' means /bookings/:id.

const express = require('express');
const bookingsController = require('../controllers/bookingsController');
const requireAdmin = require('../middleware/requireAdmin');

module.exports = ({ pool, clock }) => {
    const router = express.Router();
    const { bookSlot, getAllBookings, getBooking, deleteBooking } = bookingsController({ pool, clock });

    router.route('/')
        .post(bookSlot)          // Book a slot (levels 1-5)
        .get(requireAdmin, getAllBookings);    // Level 4: list a person's bookings (admin only: personal data)

    router.route('/:id')
        .get(requireAdmin, getBooking)         // Level 1: get a booking (admin only)
        .delete(requireAdmin, deleteBooking);  // Level 3: cancel a booking (admin only)

    return router;
};