// tests/slots.test.js
//
// GET /slots lists every slot, earliest start first, each with an `available` flag.
// ?provider= filters by exact match. The JSON uses start and end, not the column names.

const request = require('supertest');
const { makeTestContext } = require('./helpers');

const ctx = makeTestContext();
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };

const slot = (id, provider, start, end) => ({ id, provider, start, end });
const s1 = slot('s1', 'Dr Ade', '2026-12-10T09:00:00Z', '2026-12-10T09:30:00Z');
const s2 = slot('s2', 'Dr Ade', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z');
const s3 = slot('s3', 'Dr Bola', '2026-12-10T08:00:00Z', '2026-12-10T08:30:00Z');

const reset = (slots) => request(ctx.app).post('/reset').set(auth).send({ slots });
const list = (query = '') => request(ctx.app).get(`/slots${query}`).set(auth);
const ids = (res) => res.body.slots.map((s) => s.id);
const bySlot = (res, id) => res.body.slots.find((s) => s.id === id);

// Bookings can't be created through the API yet, so insert one straight into the table.
const insertBooking = (id, slotId, status) =>
    ctx.pool.query(
        'INSERT INTO bookings (id, slot_id, name, email, status) VALUES ($1, $2, $3, $4, $5)',
        [id, slotId, 'Ada Obi', 'ada@example.com', status]
    );

describe('GET /slots', () => {
    beforeEach(() => reset([s2, s1, s3])); // deliberately out of order

    test('returns 200 and { slots: [...] } with nothing else at the top level', async () => {
        const res = await list();

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(Object.keys(res.body)).toEqual(['slots']);
    });

    test('returns the slots earliest start first', async () => {
        expect(ids(await list())).toEqual(['s3', 's1', 's2']);
    });

    test('slots with the same start are ordered by id, so the order is stable', async () => {
        await reset([
            slot('b', 'Dr Ade', s1.start, s1.end),
            slot('a', 'Dr Bola', s1.start, s1.end),
        ]);

        expect(ids(await list())).toEqual(['a', 'b']);
    });

    test('each slot has exactly the spec fields (start/end, not start_at/end_at)', async () => {
        const res = await list();

        expect(Object.keys(res.body.slots[0]).sort()).toEqual(
            ['available', 'end', 'id', 'provider', 'start']
        );
    });

    test('start and end come back in the same ISO format that was sent', async () => {
        const res = await list();

        expect(bySlot(res, 's1')).toMatchObject({
            id: 's1',
            provider: 'Dr Ade',
            start: '2026-12-10T09:00:00Z',
            end: '2026-12-10T09:30:00Z',
        });
    });

    test('keeps fractional seconds when they are non-zero', async () => {
        await reset([slot('m', 'Dr Ade', '2026-12-10T09:00:00.500Z', '2026-12-10T09:30:00Z')]);

        expect((await list()).body.slots[0].start).toBe('2026-12-10T09:00:00.500Z');
    });

    test('a time with an offset is stored as the same instant and returned in UTC', async () => {
        await reset([slot('o', 'Dr Ade', '2026-12-10T10:00:00+01:00', '2026-12-10T10:30:00+01:00')]);

        expect((await list()).body.slots[0].start).toBe('2026-12-10T09:00:00Z');
    });

    test('a fresh slot is available', async () => {
        const res = await list();

        expect(res.body.slots.every((s) => s.available === true)).toBe(true);
    });

    test('a slot with a confirmed booking is not available, others still are', async () => {
        await insertBooking('b1', 's1', 'confirmed');
        const res = await list();

        expect(bySlot(res, 's1').available).toBe(false);
        expect(bySlot(res, 's2').available).toBe(true);
        expect(bySlot(res, 's3').available).toBe(true);
    });

    test('a slot whose only booking is cancelled is available again', async () => {
        await insertBooking('b1', 's1', 'cancelled');

        expect(bySlot(await list(), 's1').available).toBe(true);
    });

    test('filters by provider', async () => {
        expect(ids(await list('?provider=Dr%20Ade'))).toEqual(['s1', 's2']);
    });

    test('the provider match is exact, including case', async () => {
        expect(ids(await list('?provider=dr%20ade'))).toEqual([]);
        expect(ids(await list('?provider=Dr'))).toEqual([]);
    });

    test('an unknown provider returns an empty list, not an error', async () => {
        const res = await list('?provider=Nobody');

        expect(res.status).toBe(200);
        expect(res.body.slots).toEqual([]);
    });

    test('a provider with characters that are special in SQL is just text', async () => {
        const res = await list("?provider=" + encodeURIComponent("x' OR '1'='1"));

        expect(res.status).toBe(200);
        expect(res.body.slots).toEqual([]);
    });

    test('a repeated provider parameter is rejected with 400', async () => {
        const res = await list('?provider=Dr%20Ade&provider=Dr%20Bola');

        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe('string');
    });

    test('returns an empty list when there are no slots', async () => {
        await reset([]);
        const res = await list();

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ slots: [] });
    });
});