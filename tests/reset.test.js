// tests/reset.test.js
//
// POST /reset replaces everything: it deletes every booking and swaps all slots for the
// ones sent, including slots in the past. The graders call it before each check, so it must
// be reliable and atomic.

const request = require('supertest');
const { makeTestContext } = require('./helpers');

const ctx = makeTestContext();
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };

const slot = (id, provider, start, end) => ({ id, provider, start, end });
const s1 = slot('s1', 'Dr Ade', '2026-12-10T09:00:00Z', '2026-12-10T09:30:00Z');
const s2 = slot('s2', 'Dr Ade', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z');
const s3 = slot('s3', 'Dr Bola', '2026-12-10T08:00:00Z', '2026-12-10T08:30:00Z');
const past = slot('s4', 'Dr Ade', '2020-01-01T09:00:00Z', '2020-01-01T09:30:00Z');

const reset = (slots) => request(ctx.app).post('/reset').set(auth).send({ slots });
const list = () => request(ctx.app).get('/slots').set(auth);
const ids = (res) => res.body.slots.map((s) => s.id);
const bookingCount = async () =>
    Number((await ctx.pool.query('SELECT count(*) FROM bookings')).rows[0].count);

// Bookings can't be created through the API yet, so insert one straight into the table.
const insertBooking = (id, slotId, status = 'confirmed') =>
    ctx.pool.query(
        'INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1, $2, $3, $4, $5)',
        [id, slotId, 'Ada Obi', 'ada@example.com', status]
    );

describe('POST /reset: behaviour', () => {
    test('returns 200 with a JSON body', async () => {
        const res = await reset([s1]);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
    });

    test('replaces existing slots instead of adding to them', async () => {
        await reset([s1, s2]);
        await reset([s3]);

        expect(ids(await list())).toEqual(['s3']);
    });

    test('accepts slots in the past', async () => {
        await reset([past]);

        expect(ids(await list())).toEqual(['s4']);
    });

    test('an empty list clears every slot', async () => {
        await reset([s1]);
        await reset([]);

        expect(ids(await list())).toEqual([]);
    });

    test('deletes every booking', async () => {
        await reset([s1]);
        await insertBooking('b1', 's1');
        await insertBooking('b2', 's1', 'cancelled');
        expect(await bookingCount()).toBe(2);

        await reset([s1]);

        expect(await bookingCount()).toBe(0);
    });

    test('running it twice with the same slots gives the same state', async () => {
        await reset([s1, s2]);
        const first = await list();
        await reset([s1, s2]);
        const second = await list();

        expect(ids(first)).toEqual(['s1', 's2']); // not just "equal": equal AND correct
        expect(second.body).toEqual(first.body);
    });

    test('10 simultaneous resets all succeed and leave one consistent state', async () => {
        // Without serialising resets, two of them can both try to insert the same slot id
        // and one dies with a primary-key violation (a 500).
        const responses = await Promise.all(Array.from({ length: 10 }, () => reset([s1, s2])));

        expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
        expect(ids(await list())).toEqual(['s1', 's2']);
    });
});

describe('POST /reset: validation (400 with the error shape, and nothing changes)', () => {
    const bad = {
        'no body at all': undefined,
        'an empty object': {},
        'slots is not an array': { slots: 'nope' },
        'slots is null': { slots: null },
        'a slot that is not an object': { slots: ['s1'] },
        'a slot missing id': { slots: [{ provider: 'Dr Ade', start: s1.start, end: s1.end }] },
        'a slot missing provider': { slots: [{ id: 'x', start: s1.start, end: s1.end }] },
        'a slot missing start': { slots: [{ id: 'x', provider: 'Dr Ade', end: s1.end }] },
        'a slot missing end': { slots: [{ id: 'x', provider: 'Dr Ade', start: s1.start }] },
        'a non-string id': { slots: [{ ...s1, id: 123 }] },
        'an empty id': { slots: [{ ...s1, id: '' }] },
        'an empty provider': { slots: [{ ...s1, provider: '' }] },
        'a start that is not a date': { slots: [{ ...s1, start: 'tomorrow' }] },
        'an impossible calendar date': { slots: [{ ...s1, start: '2026-02-30T00:00:00Z' }] },
        'a date with no time': { slots: [{ ...s1, end: '2026-12-10' }] },
        'duplicate slot ids': { slots: [s1, { ...s2, id: 's1' }] },
    };

    test.each(Object.entries(bad))('%s returns 400', async (name, body) => {
        const req = request(ctx.app).post('/reset').set(auth);
        const res = await (body === undefined ? req : req.send(body));

        expect(res.status).toBe(400);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
        expect(Object.keys(res.body)).toEqual(['error']);
    });

    test('a rejected reset changes nothing', async () => {
        await reset([s1, s2]);
        await insertBooking('b1', 's1');

        const res = await reset([s1, { ...s2, start: 'not-a-date' }]);

        expect(res.status).toBe(400);
        expect(ids(await list())).toEqual(['s1', 's2']);
        expect(await bookingCount()).toBe(1);
    });
});