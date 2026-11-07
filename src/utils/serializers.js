// src/utils/serializers.js
//
// Turns database rows into the JSON the API contract promises. Selecting named columns
// and mapping them here means internal columns (like bookings.seq) can never leak out.
const { toIso } = require('./time');
 
function toBooking(row) {
    return {
        id: row.id,
        slot_id: row.slot_id,
        name: row.name,
        email: row.email,
        status: row.status,
        created_at: toIso(row.created_at),
    };
}
 
module.exports = { toBooking };