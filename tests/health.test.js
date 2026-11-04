// tests/health.test.js
//
// /health needs no key, queries the database, and turns a database failure into a
// controlled 503 {"error": ...}. A fake pool lets us test the failure without breaking Neon.

const request = require('supertest');
const { createApp } = require('../src/app');

const clock = () => new Date();

describe('GET /health', () => {
    test('needs no key and returns 200 when the database answers', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) };
        const app = createApp({ pool, clock, apiKey: 'k' });

        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    });

    test('returns 503 with the error shape when the database is down, without leaking details', async () => {
        const pool = { query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432')) };
        const app = createApp({ pool, clock, apiKey: 'k' });

        const res = await request(app).get('/health');

        expect(res.status).toBe(503);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toEqual({ error: 'database unavailable' });
    });
});