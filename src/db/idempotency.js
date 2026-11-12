// src/db/idempotency.js
//
// Helpers for the Idempotency-Key header on POST /bookings.
// The idea: a retried request must get the SAME answer and must not do the work twice.
// For each key we remember (1) a fingerprint of the request body, so we can tell a true
// retry from a different request that reuses the key, and (2) the answer we gave.

const crypto = require('crypto');

// JSON with object keys sorted at every level, so {"a":1,"b":2} and {"b":2,"a":1}
// produce the same text and therefore the same fingerprint.
function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null'; // undefined (no body at all) becomes null
}

const fingerprint = (body) =>
    crypto.createHash('sha256').update(canonicalize(body)).digest('hex');

// Takes turns per key: two simultaneous requests with the same key line up behind this lock
// (it is released automatically when the transaction ends), so the second one finds the
// first one's saved answer instead of racing it.
const LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';
const FIND = 'SELECT fingerprint, status_code, response FROM idempotency_keys WHERE key = $1';
const STORE = `
    INSERT INTO idempotency_keys (key, fingerprint, status_code, response, created_at)
    VALUES ($1, $2, $3, $4, $5)
`;

const lock = (client, key) => client.query(LOCK, [`idem:${key}`]);
const find = async (client, key) => (await client.query(FIND, [key])).rows[0];
const store = (client, key, fp, { status, body }, now) =>
    client.query(STORE, [key, fp, status, body, now]);

module.exports = { fingerprint, canonicalize, lock, find, store };