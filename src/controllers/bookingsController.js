// src/controllers/bookingsController.js
const { randomUUID } = require('crypto');
const AppError = require('../utils/appError');
const notImplemented = require('../utils/notImplemented');
const { parse } = require('../utils/validate');
const { toBooking } = require('../utils/serializers');
const { newBookingSchema } = require('../schemas/bookingSchema');

const FIND_SLOT = 'SELECT id, start_at FROM slots WHERE id = $1';

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

const INSERT_BOOKING = `
    INSERT INTO bookings (id, slot_id, name, email, status, created_at)
    VALUES ($1, $2, $3, $4, 'confirmed', $5)
    RETURNING ${BOOKING_COLUMNS}
`;

const FIND_BOOKING = `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`;

module.exports = ({ pool, clock }) => ({
    bookSlot: async (req, res) => {
        // 1. Validate the body. Nothing below runs, and the database is not touched, if it is bad.
        const { slot_id, name, email } = parse(newBookingSchema, req.body);

        // 2. Read the clock ONCE, so "has it started?" and created_at use the same instant.
        const now = clock();

        // 3. Does the slot exist? Is it still in the future?
        const { rows: [slot] } = await pool.query(FIND_SLOT, [slot_id]);
        if (!slot) throw new AppError('slot not found', 404);
        if (slot.start_at <= now) throw new AppError('slot has already started', 400);

        // 4. Create the booking. The id is generated here, never taken from the caller.
        const { rows: [booking] } = await pool.query(INSERT_BOOKING, [
            randomUUID(), slot_id, name, email, now,
        ]);

        res.status(201).json(toBooking(booking));
    },

    getBooking: async (req, res) => {
        const { rows: [booking] } = await pool.query(FIND_BOOKING, [req.params.id]);
        if (!booking) throw new AppError('booking not found', 404);

        res.json(toBooking(booking));
    },

    getAllBookings: notImplemented, // Level 4
    deleteBooking: notImplemented,  // Level 3
});