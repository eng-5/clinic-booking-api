// src/utils/pagination.js
//
// Cursor ("keyset") pagination for GET /bookings. The cursor is the seq of the last booking
// on the page, base64url-encoded so callers treat it as opaque. Why not OFFSET? A booking
// created between two page requests would shift every later row by one and cause skipped or
// repeated results; "seq greater than the cursor" can't be disturbed that way.

const AppError = require('./appError');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const encodeCursor = (seq) => Buffer.from(String(seq)).toString('base64url');

function decodeCursor(cursor) {
    const bad = () => new AppError('invalid cursor', 400);
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    // A positive whole number of at most 16 digits (fits Postgres bigint). It must also
    // re-encode to exactly the same text, so only cursors WE issued are accepted.
    if (!/^[1-9]\d{0,15}$/.test(text) || encodeCursor(text) !== cursor) throw bad();
    return text; // kept as a string: Postgres casts it to bigint, no precision lost
}

function parseListQuery({ email, limit, cursor }) {
    if (typeof email !== 'string' || email.trim() === '') {
        throw new AppError('email is required', 400);
    }

    let pageSize = DEFAULT_LIMIT;
    if (limit !== undefined) {
        // typeof check: ?limit=5&limit=6 arrives as an array
        if (typeof limit !== 'string' || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) {
            throw new AppError(`limit must be a whole number from 1 to ${MAX_LIMIT}`, 400);
        }
        pageSize = Number(limit);
    }

    if (cursor !== undefined && typeof cursor !== 'string') throw new AppError('invalid cursor', 400);

    return {
        email: email.trim().toLowerCase(),
        limit: pageSize,
        after: cursor === undefined ? null : decodeCursor(cursor),
    };
}

module.exports = { parseListQuery, encodeCursor, decodeCursor };
const LIST_BOOKINGS = `
    SELECT seq, ${BOOKING_COLUMNS}
    FROM bookings
    WHERE lower(email) = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
    ORDER BY seq ASC
    LIMIT $3
`;