// src/utils/time.js

// Postgres hands back JS Dates, and JSON.stringify writes them as 2026-12-10T09:00:00.000Z.
// The API spec's examples have no fractional seconds (2026-12-10T09:00:00Z), and a checker
// may compare strings, so whole seconds are written the way the spec shows them.
// Fractional seconds are kept when they are not zero.
function toIso(date) {
    return date.toISOString().replace('.000Z', 'Z');
}

module.exports = { toIso };