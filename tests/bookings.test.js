// tests/bookings.test.js
//
// POST /bookings and GET /bookings/:id, Levels 1 and 2.
//   Level 1: book a slot (201, status "confirmed") and look the booking up.
//   Level 2: bad details are turned away: 400 for invalid input or a slot that has
//            already started, 404 for a slot that doesn't exist. name and email are
//            trimmed and email is stored in lower case.
//
// The clock is FIXED, so "already started" is tested without waiting.

const request = require('supertest');
const { makeTestContext } = require('./helpers');

const NOW = new Date('2026-12-10T09:30:00Z');
const ctx = makeTestContext({ now: () => NOW });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };

const slot = (id, start, end) => ({ id, provider: 'Dr Ade', start, end });
const SLOTS = [
    slot('f1', '2026-12-11T09:00:00Z', '2026-12-11T09:30:00Z'),  // in the future
    slot('f2', '2026-12-11T10:00:00Z', '2026-12-11T10:30:00Z'),  // in the future
    slot('p1', '2026-12-10T09:00:00Z', '2026-12-10T09:30:00Z'),  // started 30 minutes ago
    slot('b1', '2026-12-10T09:30:00Z', '2026-12-10T10:00:00Z'),  // starts exactly now
];

const valid = { slot_id: 'f1', name: 'Ada Obi', email: 'ada@example.com' };

const reset = (slots = SLOTS) => request(ctx.app).post('/reset').set(auth).send({ slots });
const book = (body) => request(ctx.app).post('/bookings').set(auth).send(body);
const getBooking = (id) => request(ctx.app).get(`/bookings/${id}`).set(auth);
const slotsList = () => request(ctx.app).get('/slots').set(auth);
const rowCount = async () =>
    Number((await ctx.pool.query('SELECT count(*) FROM bookings')).rows[0].count);

function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(Object.keys(res.body)).toEqual(['error']);
}

beforeEach(() => reset());

describe('POST /bookings: happy path (Level 1)', () => {
    test('returns 201 with a confirmed booking and exactly the spec fields', async () => {
        const res = await book(valid);

        expect(res.status).toBe(201);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(Object.keys(res.body).sort()).toEqual(
            ['created_at', 'email', 'id', 'name', 'slot_id', 'status']
        ); // no internal columns such as seq
        expect(res.body).toMatchObject({
            slot_id: 'f1',
            name: 'Ada Obi',
            email: 'ada@example.com',
            status: 'confirmed',
        });
        expect(typeof res.body.id).toBe('string');
        expect(res.body.id.length).toBeGreaterThan(0);
    });

    test('created_at comes from the injected clock, in the same format as slots', async () => {
        const res = await book(valid);

        expect(res.body.created_at).toBe('2026-12-10T09:30:00Z');
    });

    test('every booking gets its own id', async () => {
        const a = await book(valid);
        const b = await book({ ...valid, slot_id: 'f2' });

        expect(a.body.id).not.toBe(b.body.id);
    });

    test('the booking is stored in the database', async () => {
        const res = await book(valid);
        const { rows } = await ctx.pool.query('SELECT * FROM bookings WHERE id = $1', [res.body.id]);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            slot_id: 'f1', name: 'Ada Obi', email: 'ada@example.com', status: 'confirmed',
        });
    });

    test('the slot is no longer available afterwards, and other slots are', async () => {
        await book(valid);
        const list = (await slotsList()).body.slots;

        expect(list.find((s) => s.id === 'f1').available).toBe(false);
        expect(list.find((s) => s.id === 'f2').available).toBe(true);
    });

    test('fields the caller should not control are ignored', async () => {
        const res = await book({ ...valid, id: 'hacked', status: 'cancelled', created_at: '2000-01-01T00:00:00Z' });

        expect(res.status).toBe(201);
        expect(res.body.id).not.toBe('hacked');
        expect(res.body.status).toBe('confirmed');
        expect(res.body.created_at).toBe('2026-12-10T09:30:00Z');
    });

    test('names with accents and symbols are accepted as they are', async () => {
        const res = await book({ ...valid, name: "Zoë Ñ O'Brien-Okafor" });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe("Zoë Ñ O'Brien-Okafor");
    });

    test('a name of exactly 200 characters is accepted', async () => {
        const res = await book({ ...valid, name: 'x'.repeat(200) });

        expect(res.status).toBe(201);
    });

    // Level 3 (milestone 4) will add the database rule that makes this pass.
    test.todo('booking a slot that already has a confirmed booking returns 409');
});

describe('GET /bookings/:id (Level 1)', () => {
    test('returns the booking that was created', async () => {
        const created = await book(valid);
        const res = await getBooking(created.body.id);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(created.body);
    });

    test('an unknown id returns 404 with the error shape', async () => {
        const res = await getBooking('does-not-exist');

        expectErrorShape(res, 404);
    });

    test('a cancelled booking can still be looked up and shows its status', async () => {
        await ctx.pool.query(
            "INSERT INTO bookings (id, slot_id, name, email, status) VALUES ('old', 'f1', 'Ada Obi', 'ada@example.com', 'cancelled')"
        );
        const res = await getBooking('old');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('cancelled');
    });

    test('an id with characters that are special in SQL is just text', async () => {
        const res = await getBooking(encodeURIComponent("x' OR '1'='1"));

        expectErrorShape(res, 404);
    });
});

describe('POST /bookings: validation (Level 2)', () => {
    const badValues = {
        'missing': undefined,
        'empty': '',
        'whitespace-only': '   ',
        'a number': 123,
        'null': null,
        'an object': {},
        'an array': ['x'],
        'a boolean': true,
    };

    describe.each(['slot_id', 'name', 'email'])('%s', (field) => {
        test.each(Object.entries(badValues))('%s returns 400', async (label, value) => {
            const res = await book({ ...valid, [field]: value });

            expectErrorShape(res, 400);
        });
    });

    test.each([
        ['no body at all', undefined],
        ['an empty object', {}],
        ['a JSON array', []],
    ])('%s returns 400', async (label, body) => {
        const req = request(ctx.app).post('/bookings').set(auth);
        const res = await (body === undefined ? req : req.send(body));

        expectErrorShape(res, 400);
    });

    test('a body that is not JSON returns 400', async () => {
        const res = await request(ctx.app)
            .post('/bookings').set(auth).type('form')
            .send('slot_id=f1&name=Ada&email=ada@example.com');

        expectErrorShape(res, 400);
    });

    test.each([
        'abc', 'a@b', '@example.com', 'ada@', 'ada @example.com', 'ada@@example.com',
        'ada@example', 'x'.repeat(250) + '@example.com',
    ])('the invalid email %p returns 400', async (email) => {
        const res = await book({ ...valid, email });

        expectErrorShape(res, 400);
    });

    test('a name longer than 200 characters returns 400', async () => {
        const res = await book({ ...valid, name: 'x'.repeat(201) });

        expectErrorShape(res, 400);
    });

    test('name and email are trimmed, and email is stored in lower case', async () => {
        const res = await book({ ...valid, name: '  Ada Obi  ', email: '  ADA@Example.COM ' });
        const { rows } = await ctx.pool.query('SELECT name, email FROM bookings WHERE id = $1', [res.body.id]);

        expect(res.status).toBe(201);
        expect(res.body.name).toBe('Ada Obi');
        expect(res.body.email).toBe('ada@example.com');
        expect(rows[0]).toEqual({ name: 'Ada Obi', email: 'ada@example.com' });
    });

    test('every rejected request creates no booking', async () => {
        // Assert the statuses too: "no row" alone would also be true if nothing worked at all.
        const statuses = [
            (await book({ ...valid, name: '' })).status,
            (await book({ ...valid, email: 'nope' })).status,
            (await book({ ...valid, slot_id: 'missing-slot' })).status,
            (await book({ ...valid, slot_id: 'p1' })).status,
        ];

        expect(statuses).toEqual([400, 400, 404, 400]);
        expect(await rowCount()).toBe(0);
    });
});

describe('POST /bookings: slot rules (Level 2)', () => {
    test('a slot that does not exist returns 404', async () => {
        const res = await book({ ...valid, slot_id: 'nope' });

        expectErrorShape(res, 404);
    });

    test('a slot id with characters that are special in SQL returns 404, not a crash', async () => {
        const res = await book({ ...valid, slot_id: "x' OR '1'='1" });

        expectErrorShape(res, 404);
    });

    test('a slot that has already started returns 400', async () => {
        const res = await book({ ...valid, slot_id: 'p1' });

        expectErrorShape(res, 400);
        expect(res.body.error).toMatch(/started/i);
    });

    test('a slot that starts exactly now counts as started', async () => {
        const res = await book({ ...valid, slot_id: 'b1' });

        expectErrorShape(res, 400);
        expect(res.body.error).toMatch(/started/i);
    });

    test('a slot in the future can be booked', async () => {
        const res = await book({ ...valid, slot_id: 'f2' });

        expect(res.status).toBe(201);
    });
});

describe('POST /bookings: order of checks', () => {
    test('invalid input is rejected with 400 before the slot is looked up (not 404)', async () => {
        const res = await book({ slot_id: 'nope', name: 'Ada', email: 'not-an-email' });

        expectErrorShape(res, 400);
    });

    test('a missing slot is reported as 404 even when the details are valid', async () => {
        const res = await book({ ...valid, slot_id: 'nope' });

        expectErrorShape(res, 404);
    });

    test('a missing key is rejected with 401 before anything else', async () => {
        const res = await request(ctx.app).post('/bookings').send({});

        expectErrorShape(res, 401);
    });
});