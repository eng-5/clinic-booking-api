// src/controllers/slotsController.js
const AppError = require('../utils/appError');
const { toIso } = require('../utils/time');

// `available` is derived, never stored: a slot is available unless a CONFIRMED booking
// exists for it. Cancelling a booking therefore frees the slot with no extra bookkeeping.
// start_at/end_at are renamed to start/end here, which is what the API contract calls them.
const LIST_SLOTS = `
    SELECT s.id,
           s.provider,
           s.start_at AS "start",
           s.end_at   AS "end",
           NOT EXISTS (
               SELECT 1 FROM bookings b
               WHERE b.slot_id = s.id AND b.status = 'confirmed'
           ) AS available
    FROM slots s
    WHERE ($1::text IS NULL OR s.provider = $1)
    ORDER BY s.start_at ASC, s.id ASC
`;

module.exports = ({ pool }) => ({
    getSlots: async (req, res) => {
        const { provider } = req.query;
        if (provider !== undefined && typeof provider !== 'string') {
            // ?provider=a&provider=b arrives as an array
            throw new AppError('provider must be a single value', 400);
        }

        // $1 is a bound parameter, never glued into the SQL text, so input like
        // x' OR '1'='1 is only ever compared as a plain string.
        const { rows } = await pool.query(LIST_SLOTS, [provider ?? null]);

        res.json({
            slots: rows.map((row) => ({
                id: row.id,
                provider: row.provider,
                start: toIso(row.start),
                end: toIso(row.end),
                available: row.available,
            })),
        });
    },
});