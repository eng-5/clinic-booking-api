// src/db/rateLimit.js
//
// "At most 5 attempts per email per minute, failed attempts included."
// A sliding window kept in Postgres, so it is shared by every instance and survives restarts.

const { withTransaction } = require('./transaction');

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

// One statement removes this email's expired attempts and reads what is left. The extra
// "attempted_at > $2" matters: a statement does not see its own deletes, so the filter makes
// the count correct even though the DELETE and the SELECT run together.
const PRUNE_AND_COUNT = `
    WITH expired AS (
        DELETE FROM booking_attempts WHERE email = $1 AND attempted_at <= $2
    )
    SELECT count(*) AS count, min(attempted_at) AS oldest
    FROM booking_attempts
    WHERE email = $1 AND attempted_at > $2
`;
const RECORD = 'INSERT INTO booking_attempts (email, attempted_at) VALUES ($1, $2)';

// Returns { allowed: true } and records the attempt, or { allowed: false, retryAfter }
// (whole seconds) WITHOUT recording it, so blocked requests can't extend their own block.
// `now` is the injected clock, so tests can move time instead of waiting.
async function consumeAttempt(pool, email, now) {
    return withTransaction(pool, async (client) => {
        // Make attempts for the same email take turns. Without this, ten simultaneous
        // requests would all read "0 attempts so far" and all be let through.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rl:${email}`]);

        const windowStart = new Date(now.getTime() - WINDOW_MS);
        const { rows: [{ count, oldest }] } = await client.query(PRUNE_AND_COUNT, [email, windowStart]);

        if (Number(count) >= MAX_ATTEMPTS) {
            // The block ends when the OLDEST attempt leaves the window. Round UP, never 0.
            const msLeft = oldest.getTime() + WINDOW_MS - now.getTime();
            return { allowed: false, retryAfter: Math.max(1, Math.ceil(msLeft / 1000)) };
        }

        await client.query(RECORD, [email, now]);
        return { allowed: true };
    });
}

module.exports = { consumeAttempt, WINDOW_MS, MAX_ATTEMPTS };