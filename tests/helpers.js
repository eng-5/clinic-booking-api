require('dotenv').config();
const { Pool } = require('pg');
const { createApp } = require('../src/app');

function makeTestContext({ now = () => new Date() } = {}) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    if (url === process.env.DATABASE_URL) {
        throw new Error('Refusing to run test againt the dev database');
    }
    const apiKey = 'test-key';
    const pool = new Pool({ connectionString: url, max: 25 }); // room for concurrency tests

    const app = createApp({ pool, clock: now, apiKey });
    return { app, pool, apiKey, close: () => pool.end() };
}
module.exports = { makeTestContext }