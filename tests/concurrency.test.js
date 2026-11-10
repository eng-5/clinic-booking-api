// tests/concurrency.test.js
//
// Level 3: "Two people can never book the same slot, even at the exact same moment."
//
// These tests fire requests truly in parallel (the test pool has 25 connections) and check
// that the DATABASE, not luck, decides the winner.

const request = require('supertest');
const { makeTestContext } = require('./helpers');
const { createApp } = require('../src/app');

const NOW = new Date('2026-12-10T09:30:00Z');
const ctx = makeTestContext({ now: () => NOW });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };
const SLOTS = [
    { id: 'f1', provider: 'Dr Ade', start: '2026-12-11T09:00:00Z', end: '2026-12-11T09:30:00Z' },
    { id: 'f2', provider: 'Dr Ade', start: '2026-12-11T10:00:00Z', end: '2026-12-11T10:30:00Z' },
];

const book = (body) => request(ctx.app).post('/bookings').set(auth).send(body);
const patient = (slot_id, i) => ({ slot_id, name: `Patient ${i}`, email: `patient${i}@example.com` });
const parallel = (n, makeBody) => Promise.all(Array.from({ length: n }, (_, i) => book(makeBody(i))));
const count = (rows, status) => rows.filter((r) => r.status === status).length;
const confirmedRows = async (slotId) =>
    Number((await ctx.pool.query(
        "SELECT count(*) FROM bookings WHERE slot_id = $1 AND status = 'confirmed'", [slotId]
    )).rows[0].count);

beforeEach(() => request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS }));

describe('booking the same slot at the same moment', () => {
    test('20 different people at once: exactly one 201, nineteen 409, nothing else', async () => {
        const responses = await parallel(20, (i) => patient('f1', i));

        expect(count(responses, 201)).toBe(1);
        expect(count(responses, 409)).toBe(19);
        expect(responses.filter((r) => ![201, 409].includes(r.status))).toEqual([]); // no 500s
        expect(await confirmedRows('f1')).toBe(1);
    });

    test('the losers get the error shape', async () => {
        const responses = await parallel(10, (i) => patient('f1', i));
        const losers = responses.filter((r) => r.status === 409);

        expect(losers).toHaveLength(9); // without this, an empty list would "pass" the loop below
        for (const res of losers) {
            expect(res.headers['content-type']).toMatch(/json/);
            expect(typeof res.body.error).toBe('string');
            expect(Object.keys(res.body)).toEqual(['error']);
        }
    });

    test('the winner can be looked up and the slot shows as unavailable', async () => {
        const responses = await parallel(10, (i) => patient('f1', i));
        const winners = responses.filter((r) => r.status === 201);
        expect(winners).toHaveLength(1);
        const winner = winners[0];

        const found = await request(ctx.app).get(`/bookings/${winner.body.id}`).set(auth);
        const slots = (await request(ctx.app).get('/slots').set(auth)).body.slots;

        expect(found.body).toEqual(winner.body);
        expect(slots.find((s) => s.id === 'f1').available).toBe(false);
    });

    test('the same person clicking 10 times at once also books once', async () => {
        const responses = await parallel(10, () => patient('f1', 1));

        expect(count(responses, 201)).toBe(1);
        expect(count(responses, 409)).toBe(9);
        expect(await confirmedRows('f1')).toBe(1);
    });

    test('different slots do not block each other: one winner per slot', async () => {
        const responses = await parallel(20, (i) => patient(i % 2 === 0 ? 'f1' : 'f2', i));

        expect(count(responses, 201)).toBe(2);
        expect(count(responses, 409)).toBe(18);
        expect(await confirmedRows('f1')).toBe(1);
        expect(await confirmedRows('f2')).toBe(1);
    });
});

describe('a booking race against a reset', () => {
    // If a reset deletes the slot between "does it exist?" and "insert", the database
    // rejects the insert (foreign key, code 23503). That must be a clean 404, not a 500.
    // A fake pool makes this deterministic, because the real race is nearly impossible to time.
    test('a slot deleted mid-booking is reported as 404, not a crash', async () => {
        const pool = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ id: 'f1', start_at: new Date('2026-12-11T09:00:00Z') }] })
                .mockRejectedValueOnce(Object.assign(new Error('foreign key violation'), { code: '23503' })),
        };
        const app = createApp({ pool, clock: () => NOW, apiKey: 'k' });

        const res = await request(app).post('/bookings').set({ 'X-API-Key': 'k' }).send(patient('f1', 1));

        expect(res.status).toBe(404);
        expect(typeof res.body.error).toBe('string');
    });
});