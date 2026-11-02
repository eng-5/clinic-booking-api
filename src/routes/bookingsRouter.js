const express = require('express');
const router = express.Router();
const {
    bookSlot,
    getAllBookings,
    getBooking,
    deleteBooking
} = require('../controllers/bookingsController');

router.route('/')
    .post(bookSlot)
    .get(getAllBookings);


router.route('/:id')
    .get(getBooking)
    .delete(deleteBooking);
// POST
// /bookings
// Book a slot (levels 1–5)

// GET
// /bookings
// Level 4 · List a person's bookings

// GET
// /bookings/{id}
// Level 1 · Get a booking

// DELETE
// /bookings/{id}
// Level 3 · Cancel a booking





module.exports = router;