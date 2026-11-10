// src/controllers/resetController.js
const { withTransaction } = require('../db/transaction');
const { resetBodySchema } = require('../schemas/resetSchema');
const { parse } = require('../utils/validate');

// One INSERT for any number of slots: the four arrays are unpacked row by row by Postgres.
const INSERT_SLOTS = `
    INSERT INTO slots (id, provider, start_at, end_at)
    SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])
`;

module.exports = ({ pool }) => ({
    resetAllSlots: async (req, res) => {
        // Validate first, so a bad request never touches the database.
        const { slots } = parse(resetBodySchema, req.body);

        await withTransaction(pool, async (client) => {
            // Make resets take turns. Two overlapping resets would otherwise both try to
            // insert the same slot id, and one would fail with a primary-key violation.
            // The lock is released automatically when the transaction ends.
            await client.query("SELECT pg_advisory_xact_lock(hashtext('reset'))");

            // Bookings reference slots, so they must go first.
            await client.query('DELETE FROM bookings');
            await client.query('DELETE FROM slots');

            if (slots.length > 0) {
                await client.query(INSERT_SLOTS, [
                    slots.map((s) => s.id),
                    slots.map((s) => s.provider),
                    slots.map((s) => s.start),
                    slots.map((s) => s.end),
                ]);
            }
        });

        res.status(200).json({ slots: slots.length });
    },
});