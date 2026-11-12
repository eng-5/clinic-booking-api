const { randomUUID } = require('crypto');
const AppError = require('../utils/appError');
const { toBooking } = require('../utils/serializers');

const FIND_SLOT = 'SELECT id, start_at FROM slots WHERE id = $1';
const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

// ON CONFLICT ... DO NOTHING works with the partial unique index (one_confirmed_per_slot):
// if a confirmed booking already holds the slot, nothing is inserted and no row comes back.
// That is a normal result, not a database error, so a surrounding transaction is never aborted.
const INSERT_BOOKING = `
    INSERT INTO bookings (id, slot_id, name, email, status, created_at)
    VALUES ($1, $2, $3, $4, 'confirmed', $5)
    ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
    RETURNING ${BOOKING_COLUMNS}
`;

const refused = (status, message) => ({ status, body: { error: message } });

// Tries to book a slot and RETURNS the outcome as { status, body } (it does not throw for
// the expected refusals). Returning it is what lets an idempotent request save the answer.
// `db` is the pool for a plain request, or a transaction's client for an idempotent one.
async function attemptBooking(db, { slot_id, name, email }, now) {
    const { rows: [slot] } = await db.query(FIND_SLOT, [slot_id]);
    if (!slot) return refused(404, 'slot not found');
    if (slot.start_at <= now) return refused(400, 'slot has already started');

    let booking;
    try {
        ({ rows: [booking] } = await db.query(INSERT_BOOKING, [randomUUID(), slot_id, name, email, now]));
    } catch (err) {
        // 23503 = foreign key violation: /reset deleted the slot after the check above.
        // Thrown (not returned) on purpose: inside a transaction the failed statement has
        // already poisoned it, so nothing could be saved. The retry will simply see no slot.
        if (err.code === '23503') throw new AppError('slot not found', 404);
        throw err;
    }
    if (!booking) return refused(409, 'slot is already booked');

    return { status: 201, body: toBooking(booking) };
}

module.exports = { attemptBooking };