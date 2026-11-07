// src/schemas/bookingSchema.js
const { z } = require('zod');

// slot_id is an identifier, so it is NOT trimmed or changed (the same id sent to /reset must
// work here). A value that is only spaces is still rejected as blank.
const slotId = z.string().min(1).max(200).refine((s) => s.trim().length > 0, 'must not be blank');

// The order matters: trim first (so "   " becomes "" and fails min(1)), then lower-case,
// then check the length, then check it really is an email address.
const email = z.string().trim().toLowerCase().min(1).max(254).pipe(z.email());

const name = z.string().trim().min(1).max(200);

// z.object() drops fields it doesn't know about. A caller cannot set id, status or
// created_at by sending them: only these three values ever reach the database.
const newBookingSchema = z.object({
    slot_id: slotId,
    name,
    email,
});

module.exports = { newBookingSchema };