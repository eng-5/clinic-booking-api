// tests/roles.test.js
//
// Two keys, two roles.
//   admin key  (API_KEY)        : everything. This is the key submitted to the graders.
//   public key (PUBLIC_API_KEY) : only what the web page needs (list slots, book a slot).
// A valid key that is not allowed to do something gets 403. A missing or wrong key is 401.

const request = require('supertest');
const { makeTestContext } = require('./helpers');
const { createApp } = require('../src/app');

const ctx = makeTestContext();
afterAll(() => ctx.close());

const send = (method, path, key, body) => {
    let req = request(ctx.app)[method](path);
    if (key) req = req.set('X-API-Key', key);
    return body === undefined ? req : req.send(body);
};

function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
}

// method, path, body, then the expected status for: admin key, public key, no key.
// "400" for POST /bookings means "the request got through to validation", i.e. it is allowed.
const matrix = [
    ['post', '/reset', { slots: [] }, 200, 403, 401],
    ['get', '/slots', undefined, 200, 200, 401],
    ['post', '/bookings', {}, 400, 400, 401],
    ['get', '/bookings?email=ada%40example.com', undefined, 200, 403, 401],
    ['get', '/bookings/abc', undefined, 404, 403, 401],
    ['delete', '/bookings/abc', undefined, 404, 403, 401],
];

describe.each(matrix)('%s %s', (method, path, body, adminStatus, publicStatus, noneStatus) => {
    test(`admin key -> ${adminStatus}`, async () => {
        expect((await send(method, path, ctx.apiKey, body)).status).toBe(adminStatus);
    });

    test(`public key -> ${publicStatus}`, async () => {
        const res = await send(method, path, ctx.publicKey, body);

        expect(res.status).toBe(publicStatus);
        if (publicStatus === 403) expectErrorShape(res, 403);
    });

    test(`no key -> ${noneStatus}`, async () => {
        expectErrorShape(await send(method, path, undefined, body), noneStatus);
    });
});

describe('what the public key can do', () => {
    const slot = { id: 'f1', provider: 'Dr Ade', start: '2099-01-01T09:00:00Z', end: '2099-01-01T09:30:00Z' };

    test('it can complete a whole booking: see the slot, book it, see it taken', async () => {
        await send('post', '/reset', ctx.apiKey, { slots: [slot] });

        const listed = await send('get', '/slots', ctx.publicKey);
        const booked = await send('post', '/bookings', ctx.publicKey, {
            slot_id: 'f1', name: 'Ada Obi', email: 'ada@example.com',
        });
        const after = await send('get', '/slots', ctx.publicKey);

        expect(listed.body.slots[0].available).toBe(true);
        expect(booked.status).toBe(201);
        expect(after.body.slots[0].available).toBe(false);
    });
});

describe('what the public key must never do', () => {
    test('it cannot wipe the data, and the data is still there afterwards', async () => {
        await send('post', '/reset', ctx.apiKey, {
            slots: [{ id: 'keep', provider: 'Dr Ade', start: '2099-01-01T09:00:00Z', end: '2099-01-01T09:30:00Z' }],
        });

        const attempt = await send('post', '/reset', ctx.publicKey, { slots: [] });

        expect(attempt.status).toBe(403); // refused for being NOT ALLOWED (not just "unknown key")
        expect((await send('get', '/slots', ctx.apiKey)).body.slots).toHaveLength(1);
    });

    test('it is refused (403) before the route is even looked at, so it cannot probe for bookings', async () => {
        const real = await send('delete', '/bookings/abc', ctx.publicKey);
        const unreal = await send('delete', '/bookings/anything-else', ctx.publicKey);

        expect(real.status).toBe(403);
        expect(unreal.body).toEqual(real.body); // identical: no difference to learn from
    });

    test('a request cannot award itself a role with a header', async () => {
        const res = await request(ctx.app).post('/reset').set('X-API-Key', ctx.publicKey)
            .set('X-Role', 'admin').set('X-User-Role', 'admin').send({ slots: [] });

        expect(res.status).toBe(403);
    });
});

describe('the keys themselves', () => {
    test.each([
        ['a wrong key', 'definitely-wrong'],
        ['the admin key with one character changed', ctx.apiKey.slice(0, -1) + 'z'],
        ['the public key with one character changed', ctx.publicKey.slice(0, -1) + 'z'],
        ['the public key in capitals', ctx.publicKey.toUpperCase()],
        ['an empty key', ''],
    ])('%s is 401, not 403', async (label, key) => {
        const res = await request(ctx.app).get('/slots').set('X-API-Key', key);

        expectErrorShape(res, 401);
    });

    test('with NO public key configured, a visitor key is simply a wrong key (401)', async () => {
        const app = createApp({ pool: ctx.pool, clock: () => new Date(), apiKey: ctx.apiKey });

        expect((await request(app).get('/slots').set('X-API-Key', ctx.publicKey)).status).toBe(401);
        expect((await request(app).get('/slots').set('X-API-Key', ctx.apiKey)).status).toBe(200);
    });
});