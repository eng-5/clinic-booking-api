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
    ['delete', '/bookings/abc']
]

describe('API key required', () => {
    test.each(routes)('%s %s with no key returns 401', async (method, path) => {
        const { app } = ctx;
        const res = await request(app)[method](path);

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    test.each(routes)('%s %s with empty key returns 401', async (method, path) => {
        const { app } = ctx;
        const res = await request(app)[method](path)
            .set('x-api-key', '');

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    test.each(routes)('%s %s with the wrong key returns 401', async (method, path) => {
        const { app } = ctx;
        const res = await request(app)[method](path)
            .set('x-api-key', 'wrong-key');

        expect(res.statusCode).toBe(401);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    })
})

test('Correct key is accepted', async () => {
    const { app, apiKey } = ctx;
    const res = await request(app)
        .get('/slots')
        .set('x-api-key', apiKey);

    expect(res.statusCode).not.toBe(401);
})
test('Broken body with no key should be rejected with a 401', async () => {
    const { app, apiKey } = ctx;
    const res = await request(app)
        .post('/bookings')
        .set('Content-Type', 'application/json')
        .send('{bad');

    expect(res.statusCode).toBe(401);
})