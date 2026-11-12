// src/controllers/bookingsController.js
const AppError = require('../utils/appError');
const { parse } = require('../utils/validate');
const { toBooking } = require('../utils/serializers');
const { newBookingSchema, emailSchema } = require('../schemas/bookingSchema');
const { parseListQuery, encodeCursor } = require('../utils/pagination');
const { withTransaction } = require('../db/transaction');
const { consumeAttempt } = require('../db/rateLimit');
const idempotency = require('../db/idempotency');
const { attemptBooking } = require('../services/bookingService');

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';
const FIND_BOOKING = `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`;

// One atomic statement: it only changes a booking that is STILL confirmed. Ten simultaneous
// cancels therefore produce one winner; the rest find nothing to update.
const CANCEL_BOOKING = `
    UPDATE bookings SET status = 'cancelled'
    WHERE id = $1 AND status = 'confirmed'
    RETURNING ${BOOKING_COLUMNS}
`;
const BOOKING_EXISTS = 'SELECT 1 FROM bookings WHERE id = $1';

// seq is the creation order and the cursor position. It is selected here but never returned.
const LIST_BOOKINGS = `
    SELECT seq, ${BOOKING_COLUMNS}
    FROM bookings
    WHERE lower(email) = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
    ORDER BY seq ASC
    LIMIT $3
`;

const MAX_KEY_LENGTH = 255;
const send = (res, { status, body }) => res.status(status).json(body);

// The email to rate-limit on: the body's email, normalised EXACTLY as booking validation
// normalises it (trim, lower-case). If there is no usable email there is nobody to limit.
function rateLimitKey(body) {
    const parsed = emailSchema.safeParse(body && body.email);
    return parsed.success ? parsed.data : null;
}

function readIdempotencyKey(req) {
    const raw = req.get('Idempotency-Key');
    if (raw === undefined) return null;
    if (raw.trim() === '' || raw.length > MAX_KEY_LENGTH) {
        throw new AppError(`Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} characters`, 400);
    }
    return raw;
}

module.exports = ({ pool, clock }) => ({
    // Order of checks (the first failure wins):
    //   API key and JSON parsing (middleware) -> rate limit -> Idempotency-Key header
    //   -> [replay or 422 if the key was seen] -> body validation -> slot rules -> insert
    bookSlot: async (req, res) => {
        const now = clock(); // read ONCE: every rule below and created_at use the same instant

        // 1. Rate limit. Counted before validation, so failed and invalid attempts count too.
        const who = rateLimitKey(req.body);
        if (who) {
            const verdict = await consumeAttempt(pool, who, now);
            if (!verdict.allowed) {
                res.set('Retry-After', String(verdict.retryAfter));
                throw new AppError('too many booking attempts, try again later', 429);
            }
        }

        // 2. No key: the ordinary path.
        const key = readIdempotencyKey(req);
        if (key === null) {
            const input = parse(newBookingSchema, req.body);
            return send(res, await attemptBooking(pool, input, now));
        }

        // 3. With a key: look up, decide and save in ONE transaction, holding this key's lock.
        const { outcome, replayed } = await withTransaction(pool, async (client) => {
            await idempotency.lock(client, key);

            const fp = idempotency.fingerprint(req.body);
            const seen = await idempotency.find(client, key);
            if (seen) {
                if (seen.fingerprint !== fp) {
                    throw new AppError('Idempotency-Key was already used with a different request body', 422);
                }
                return { outcome: { status: seen.status_code, body: seen.response }, replayed: true };
            }

            // First time: validate (a 400 here rolls back, so nothing is remembered),
            // do the work, and remember the answer.
            const input = parse(newBookingSchema, req.body);
            const result = await attemptBooking(client, input, now);
            await idempotency.store(client, key, fp, result, now);
            return { outcome: result, replayed: false };
        });

        if (replayed) res.set('Idempotent-Replayed', 'true');
        send(res, outcome);
    },

    getBooking: async (req, res) => {
        const { rows: [booking] } = await pool.query(FIND_BOOKING, [req.params.id]);
        if (!booking) throw new AppError('booking not found', 404);

        res.json(toBooking(booking));
    },

    getAllBookings: async (req, res) => {
        const { email, limit, after } = parseListQuery(req.query);

        // Ask for ONE extra row. If it exists there is another page, and we never have to
        // run a second query (or guess) to know whether the last page was exactly full.
        const { rows } = await pool.query(LIST_BOOKINGS, [email, after, limit + 1]);
        const page = rows.slice(0, limit);

        res.json({
            bookings: page.map(toBooking),
            next_cursor: rows.length > limit ? encodeCursor(page[limit - 1].seq) : null,
        });
    },

    deleteBooking: async (req, res) => {
        const { rows: [cancelled] } = await pool.query(CANCEL_BOOKING, [req.params.id]);
        if (cancelled) return res.json(toBooking(cancelled));

        // Nothing was updated. Either there is no such booking, or it was already cancelled.
        const { rowCount } = await pool.query(BOOKING_EXISTS, [req.params.id]);
        if (rowCount === 0) throw new AppError('booking not found', 404);
        throw new AppError('booking is already cancelled', 409);
    },
});