// tests/helpers.js
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { createApp } = require('../src/app');

// The ONE place that decides which database tests may use. Every test file that touches
// the database goes through this, so each one loads .env and gets the same safety check.
function testDatabaseUrl() {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    if (url === process.env.DATABASE_URL) {
        // /reset and the tests delete rows, so tests must never touch the dev database.
        throw new Error('Refusing to run tests against the dev database');
    }
    return url;
}

// Builds an app wired to the TEST database. `now` lets a test pass a fixed clock.
// There are two keys: apiKey is the ADMIN key (what the graders use); publicKey is the
// limited key the web page carries. They must not overlap (neither contains the other),
// so a test can check that one never leaks into the other.
function makeTestContext({ now = () => new Date(), publicKey = 'visitor-key-abc' } = {}) {
    const apiKey = 'test-key';
    const pool = new Pool({ connectionString: testDatabaseUrl(), max: 25 }); // room for concurrency tests

    const app = createApp({ pool, clock: now, apiKey, publicKey });
    return { app, pool, apiKey, publicKey, close: () => pool.end() };
}

module.exports = { makeTestContext, testDatabaseUrl };