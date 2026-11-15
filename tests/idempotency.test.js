// tests/idempotency.test.js
//
// Level 4: "A retried request never creates a duplicate booking."
// Optional Idempotency-Key header on POST /bookings:
//   same key + same body      -> the SAME response (same status, same booking id), no new booking
//   same key + different body -> 422

jest.setTimeout(60000);
const request = require('supertest');
const { makeTestContext } = require('./helpers');
const { createApp } = require('../src/app');

const NOW = new Date('2026-12-10T09:30:00Z');
const ctx = makeTestContext({ now: () => NOW });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };
const SLOTS = ['f1', 'f2', 'f3'].map((id, i) => ({
    id, provider: 'Dr Ade',
    start: `2026-12-11T${String(9 + i).padStart(2, '0')}:00:00Z`, end: `2026-12-11T${String(9 + i).padStart(2, '0')}:30:00Z`,
}));

const body = (slot_id = 'f1', n = 1) => ({ slot_id, name: `Patient ${n}`, email: `patient${n}@example.com` });
const book = (payload, key) => {
    const req = request(ctx.app).post('/bookings').set(auth);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(payload);
};
const cancel = (id) => request(ctx.app).delete(`/bookings/${id}`).set(auth);
const bookingCount = async () => Number((await ctx.pool.query('SELECT count(*) FROM bookings')).rows[0].count);
const keyCount = async () => Number((await ctx.pool.query('SELECT count(*) FROM idempotency_keys')).rows[0].count);
const count = (rs, status) => rs.filter((r) => r.status === status).length;

function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
}

beforeEach(async () => {
    const res = await request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS });
    expect(res.status).toBe(200); // a bad fixture must fail loudly, not leave stale data behind
});

describe('without a key, nothing changes', () => {
    test('the same request twice: 201, then 409 (the normal rule)', async () => {
        expect((await book(body())).status).toBe(201);
        expectErrorShape(await book(body()), 409);
    });
});

describe('same key and same body: a replay', () => {
    test('returns the same status and the same booking, and creates only one booking', async () => {
        const first = await book(body(), 'key-1');
        const second = await book(body(), 'key-1');

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.body).toEqual(first.body);
        expect(await bookingCount()).toBe(1);
    });

    test('a replay is marked, the first answer is not', async () => {
        const first = await book(body(), 'key-1');
        const second = await book(body(), 'key-1');

        expect(first.headers['idempotent-replayed']).toBeUndefined();
        expect(second.headers['idempotent-replayed']).toBe('true');
    });

    test('a replay stores nothing new', async () => {
        await book(body(), 'key-1');
        await book(body(), 'key-1');
        await book(body(), 'key-1');

        expect(await keyCount()).toBe(1);
        expect(await bookingCount()).toBe(1);
    });

    test('JSON key order does not matter', async () => {
        const first = await request(ctx.app).post('/bookings').set(auth).set('Idempotency-Key', 'k')
            .set('Content-Type', 'application/json')
            .send('{"slot_id":"f1","name":"Patient 1","email":"patient1@example.com"}');
        const second = await request(ctx.app).post('/bookings').set(auth).set('Idempotency-Key', 'k')
            .set('Content-Type', 'application/json')
            .send('{"email":"patient1@example.com","name":"Patient 1","slot_id":"f1"}');

        expect(second.status).toBe(201);
        expect(second.body.id).toBe(first.body.id);
        expect(await bookingCount()).toBe(1);
    });

    test('the original answer is returned even after the slot was taken by someone else', async () => {
        const first = await book(body('f1', 1), 'key-1');
        await cancel(first.body.id);
        expect((await book(body('f1', 2))).status).toBe(201); // someone else now holds f1

        const replay = await book(body('f1', 1), 'key-1');

        expect(replay.status).toBe(201);
        expect(replay.body.id).toBe(first.body.id);
    });

    test('the original answer is returned even after the booking was cancelled', async () => {
        const first = await book(body(), 'key-1');
        await cancel(first.body.id);

        const replay = await book(body(), 'key-1');

        expect(replay.status).toBe(201);
        expect(replay.body).toEqual(first.body);
    });

    test('a refused request (slot taken) is replayed as the same 409', async () => {
        const other = await book(body('f1', 2));
        const first = await book(body('f1', 1), 'key-1');
        expect(first.status).toBe(409);
        await cancel(other.body.id); // the slot is free now

        const replay = await book(body('f1', 1), 'key-1');

        expect(replay.status).toBe(409);
        expect(replay.body).toEqual(first.body);
        expect(await bookingCount()).toBe(1); // only the cancelled one: the keyed request made nothing
    });

    test('an unknown slot is replayed as the same 404', async () => {
        const first = await book(body('nope'), 'key-1');
        const replay = await book(body('nope'), 'key-1');

        expectErrorShape(first, 404);
        expect(replay.status).toBe(404);
        expect(replay.body).toEqual(first.body);
        expect(await keyCount()).toBe(1); // proof it was REMEMBERED, not just answered the same way twice
    });
});

describe('same key and a different body: 422', () => {
    test.each([
        ['a different slot', body('f2', 1)],
        ['a different email', body('f1', 2)],
        ['a different name', { ...body('f1', 1), name: 'Someone Else' }],
    ])('%s returns 422 and creates nothing', async (label, other) => {
        await book(body('f1', 1), 'key-1');

        const res = await book(other, 'key-1');

        expectErrorShape(res, 422);
        expect(await bookingCount()).toBe(1);
    });

    test('a different body that is also invalid is still 422 (the key was used for another request)', async () => {
        await book(body(), 'key-1');

        expectErrorShape(await book({ ...body(), email: 'nope' }, 'key-1'), 422);
    });

    test('different keys with the same body are independent: the second gets the normal 409', async () => {
        await book(body(), 'key-1');

        expectErrorShape(await book(body(), 'key-2'), 409);
    });
});

describe('what is NOT remembered', () => {
    test('an invalid request stores nothing, so the key can be used again with a corrected body', async () => {
        const bad = await book({ ...body(), email: 'nope' }, 'key-1');
        expectErrorShape(bad, 400);
        expect(await keyCount()).toBe(0);

        const good = await book(body(), 'key-1');

        expect(good.status).toBe(201);
    });

    test('reset forgets every key', async () => {
        const first = await book(body(), 'key-1');
        await request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS });

        const again = await book(body(), 'key-1');
        const different = await request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS })
            .then(() => book(body('f2', 3), 'key-1'));

        expect(again.status).toBe(201);
        expect(again.body.id).not.toBe(first.body.id); // a fresh booking, not a replay
        expect(different.status).toBe(201);            // and no 422 from the forgotten key
        expect(await keyCount()).toBe(1);
    });
});

describe('the header itself', () => {
    test.each([['empty', ''], ['only spaces', '   '], ['256 characters', 'k'.repeat(256)]])(
        'a key that is %s returns 400', async (label, key) => {
            expectErrorShape(await book(body(), key), 400);
        }
    );

    test('a key of exactly 255 characters is accepted', async () => {
        expect((await book(body(), 'k'.repeat(255))).status).toBe(201);
    });
});

// A wrapper around the real pool that makes the key lookup SLOW. Rate limiting spaces
// simultaneous requests a few milliseconds apart, so left alone they rarely overlap at the
// moment the per-key lock protects. Slowing that one statement forces the overlap, so the
// race happens every time instead of depending on timing luck.
function poolWithSlowKeyLookup(realPool, ms) {
    return {
        query: (sql, params) => realPool.query(sql, params),
        connect: async () => {
            const client = await realPool.connect();
            return {
                query: async (sql, params) => {
                    const result = await client.query(sql, params);
                    if (/FROM idempotency_keys/i.test(sql)) await new Promise((r) => setTimeout(r, ms));
                    return result;
                },
                release: (err) => client.release(err),
            };
        },
    };
}

describe('simultaneous retries', () => {
    test('with the overlap FORCED (slow key lookup), 5 identical requests still make one booking and one answer', async () => {
        const app = createApp({ pool: poolWithSlowKeyLookup(ctx.pool, 150), clock: () => NOW, apiKey: ctx.apiKey });
        const send = () => request(app).post('/bookings').set(auth).set('Idempotency-Key', 'key-1').send(body());

        const responses = await Promise.all(Array.from({ length: 5 }, send));

        expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
        expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
        expect(await bookingCount()).toBe(1);
        expect(await keyCount()).toBe(1);
    });

    test('5 identical requests with one key: one booking, five identical answers', async () => {
        const responses = await Promise.all(Array.from({ length: 5 }, () => book(body(), 'key-1')));

        expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
        expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
        expect(await bookingCount()).toBe(1);
        expect(await keyCount()).toBe(1);
    });

    test('3 requests with one key and body A, 3 with the same key and body B: one booking, 3 x 201 and 3 x 422', async () => {
        const responses = await Promise.all([
            ...Array.from({ length: 3 }, () => book(body('f1', 1), 'key-1')),
            ...Array.from({ length: 3 }, () => book(body('f2', 2), 'key-1')),
        ]);

        expect(count(responses, 201)).toBe(3);
        expect(count(responses, 422)).toBe(3);
        expect(new Set(responses.filter((r) => r.status === 201).map((r) => r.body.id)).size).toBe(1);
        expect(await bookingCount()).toBe(1);
    });

    test('20 different keys for one slot: still exactly one booking (the database rule holds)', async () => {
        const responses = await Promise.all(
            Array.from({ length: 20 }, (_, i) => book(body('f1', i + 1), `key-${i}`))
        );

        expect(count(responses, 201)).toBe(1);
        expect(count(responses, 409)).toBe(19);
        expect(await bookingCount()).toBe(1);
    });
});