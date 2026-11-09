// tests/cancel.test.js
//
// DELETE /bookings/:id sets status to "cancelled" and frees the slot.
//   200 the cancelled booking | 404 no such booking | 409 already cancelled

const request = require('supertest');
const { makeTestContext } = require('./helpers');

const NOW = new Date('2026-12-10T09:30:00Z');
const ctx = makeTestContext({ now: () => NOW });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };
const SLOTS = [
    { id: 'f1', provider: 'Dr Ade', start: '2026-12-11T09:00:00Z', end: '2026-12-11T09:30:00Z' },
    { id: 'f2', provider: 'Dr Ade', start: '2026-12-11T10:00:00Z', end: '2026-12-11T10:30:00Z' },
];

const book = (slot_id = 'f1', n = 1) =>
    request(ctx.app).post('/bookings').set(auth)
        .send({ slot_id, name: `Patient ${n}`, email: `patient${n}@example.com` });
const cancel = (id) => request(ctx.app).delete(`/bookings/${id}`).set(auth);
const getBooking = (id) => request(ctx.app).get(`/bookings/${id}`).set(auth);
const available = async (id) =>
    (await request(ctx.app).get('/slots').set(auth)).body.slots.find((s) => s.id === id).available;

function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
}

beforeEach(() => request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS }));

describe('DELETE /bookings/:id', () => {
    test('returns 200 with the same booking, now cancelled', async () => {
        const created = (await book()).body;
        const res = await cancel(created.id);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ...created, status: 'cancelled' });
    });

    test('frees the slot', async () => {
        const created = (await book()).body;
        expect(await available('f1')).toBe(false);

        await cancel(created.id);

        expect(await available('f1')).toBe(true);
    });

    test('the freed slot can be booked again by someone else', async () => {
        const first = (await book('f1', 1)).body;
        expect((await cancel(first.id)).status).toBe(200);

        const second = await book('f1', 2);

        expect(second.status).toBe(201);
        expect(second.body.id).not.toBe(first.id);
    });

    test('the cancelled booking stays on record with status cancelled', async () => {
        const created = (await book()).body;
        await cancel(created.id);

        expect((await getBooking(created.id)).body.status).toBe('cancelled');
    });

    test('cancelling twice returns 409 the second time', async () => {
        const created = (await book()).body;
        await cancel(created.id);

        expectErrorShape(await cancel(created.id), 409);
    });

    test('an unknown id returns 404', async () => {
        expectErrorShape(await cancel('does-not-exist'), 404);
    });

    test('an id with characters that are special in SQL is just text', async () => {
        expectErrorShape(await cancel(encodeURIComponent("x' OR '1'='1")), 404);
    });

    test('cancelling one booking leaves other bookings alone', async () => {
        const a = (await book('f1', 1)).body;
        const b = (await book('f2', 2)).body;

        expect((await cancel(a.id)).status).toBe(200);

        expect((await getBooking(a.id)).body.status).toBe('cancelled');
        expect((await getBooking(b.id)).body.status).toBe('confirmed');
        expect(await available('f2')).toBe(false);
    });

    test('cancelling an OLD booking never touches the slot\'s NEW booking', async () => {
        const old = (await book('f1', 1)).body;
        await cancel(old.id);
        const current = (await book('f1', 2)).body;

        const again = await cancel(old.id); // already cancelled: must be 409 and change nothing

        expectErrorShape(again, 409);
        expect((await getBooking(current.id)).body.status).toBe('confirmed');
        expect(await available('f1')).toBe(false);
    });

    test('10 simultaneous cancels of one booking: exactly one 200, nine 409', async () => {
        const created = (await book()).body;

        const responses = await Promise.all(Array.from({ length: 10 }, () => cancel(created.id)));

        expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
        expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
        expect(responses.filter((r) => ![200, 409].includes(r.status))).toEqual([]);
    });
});