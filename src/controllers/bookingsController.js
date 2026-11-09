// src/controllers/bookingsController.js
const { randomUUID } = require('crypto');
const AppError = require('../utils/appError');
const notImplemented = require('../utils/notImplemented');
const { parse } = require('../utils/validate');
const { toBooking } = require('../utils/serializers');
const { newBookingSchema } = require('../schemas/bookingSchema');

const FIND_SLOT = 'SELECT id, start_at FROM slots WHERE id = $1';

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

// ON CONFLICT ... DO NOTHING works with the partial unique index (one_confirmed_per_slot):
// if a confirmed booking already holds the slot, nothing is inserted and no row comes back.
// That is a normal result (not a database error), so the transaction is never poisoned and
// the caller simply gets a 409.
const INSERT_BOOKING = `
    INSERT INTO bookings (id, slot_id, name, email, status, created_at)
    VALUES ($1, $2, $3, $4, 'confirmed', $5)
    ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
    RETURNING ${BOOKING_COLUMNS}
`;

const FIND_BOOKING = `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`;

// One atomic statement: it only changes a booking that is STILL confirmed. Ten simultaneous
// cancels therefore produce one winner; the rest find nothing to update.
const CANCEL_BOOKING = `
    UPDATE bookings SET status = 'cancelled'
    WHERE id = $1 AND status = 'confirmed'
    RETURNING ${BOOKING_COLUMNS}
`;

const BOOKING_EXISTS = 'SELECT 1 FROM bookings WHERE id = $1';

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

        // 4. Try to take the slot. The database decides the winner when requests collide.
        let booking;
        try {
            ({ rows: [booking] } = await pool.query(INSERT_BOOKING, [
                randomUUID(), slot_id, name, email, now,
            ]));
        } catch (err) {
            // 23503 = foreign key violation: /reset deleted the slot after step 3.
            if (err.code === '23503') throw new AppError('slot not found', 404);
            throw err;
        }
        if (!booking) throw new AppError('slot is already booked', 409);

        res.status(201).json(toBooking(booking));
    },

    getBooking: async (req, res) => {
        const { rows: [booking] } = await pool.query(FIND_BOOKING, [req.params.id]);
        if (!booking) throw new AppError('booking not found', 404);

        res.json(toBooking(booking));
    },

    deleteBooking: async (req, res) => {
        const { rows: [cancelled] } = await pool.query(CANCEL_BOOKING, [req.params.id]);
        if (cancelled) return res.json(toBooking(cancelled));

        // Nothing was updated. Either there is no such booking, or it was already cancelled.
        const { rowCount } = await pool.query(BOOKING_EXISTS, [req.params.id]);
        if (rowCount === 0) throw new AppError('booking not found', 404);
        throw new AppError('booking is already cancelled', 409);
    },

    getAllBookings: notImplemented, // Level 4
});