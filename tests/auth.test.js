// tests/auth.test.js
//
// Contract: every request needs the X-API-Key header. Missing or wrong means 401 with
// {"error": "..."}. This applies to every route, including /reset and unknown routes.

const { makeTestContext } = require('./helpers');
const request = require('supertest');

const ctx = makeTestContext();

afterAll(() => ctx.close());

const routes = [
    ['post', '/reset'],
    ['get', '/slots'],
    ['post', '/bookings'],
    ['get', '/bookings'],
    ['get', '/bookings/abc'],
    ['delete', '/bookings/abc'],
];

describe('API key required', () => {
    test.each(routes)('%s %s with no key returns 401', async (method, path) => {
        const res = await request(ctx.app)[method](path);

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    test.each(routes)('%s %s with empty key returns 401', async (method, path) => {
        const res = await request(ctx.app)[method](path).set('x-api-key', '');

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    test.each(routes)('%s %s with the wrong key returns 401', async (method, path) => {
        const res = await request(ctx.app)[method](path).set('x-api-key', 'wrong-key');

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });
});

test('a wrong key of the SAME length as the real one is rejected', async () => {
    // 'wrong-key' has a different length from 'test-key', so the tests above would still pass
    // for a check that only compared lengths. This one forces a real comparison.
    const almost = ctx.apiKey.slice(0, -1) + 'z';
    expect(almost).toHaveLength(ctx.apiKey.length);
    expect(almost).not.toBe(ctx.apiKey);

    const res = await request(ctx.app).get('/slots').set('x-api-key', almost);

    expect(res.statusCode).toBe(401);
});

test('the correct key is accepted', async () => {
    const res = await request(ctx.app).get('/slots').set('x-api-key', ctx.apiKey);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.slots)).toBe(true);
});

test('a broken body with no key is rejected with 401, not 400', async () => {
    // Proves the key check runs BEFORE the body parser.
    const res = await request(ctx.app)
        .post('/bookings')
        .set('Content-Type', 'application/json')
        .send('{bad');

    expect(res.statusCode).toBe(401);
});