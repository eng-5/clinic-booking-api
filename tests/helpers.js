// tests/helpers.js
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { createApp } = require('../src/app');

// Builds an app wired to the TEST database. `now` lets a test pass a fixed clock,
// for example () => new Date('2026-12-10T09:30:00Z'), to test "slot already started".
function makeTestContext({ now = () => new Date() } = {}) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    if (url === process.env.DATABASE_URL) {
        // /reset deletes everything, so tests must never touch the dev database.
        throw new Error('Refusing to run tests against the dev database');
    }
    const apiKey = 'test-key';
    const pool = new Pool({ connectionString: url, max: 25 }); // room for concurrency tests

    const app = createApp({ pool, clock: now, apiKey });
    return { app, pool, apiKey, close: () => pool.end() };
}

module.exports = { makeTestContext };