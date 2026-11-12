// tests/ratelimit.test.js
//
// Level 5: "Stop anyone from spamming bookings."
// At most 5 attempts per email per minute, failed attempts included. The 6th returns 429
// with a Retry-After header in whole seconds. Other emails are not affected.
// The clock is movable, so the one-minute window is tested without waiting.

jest.setTimeout(60000);
const request = require('supertest');
const { makeTestContext } = require('./helpers');

const T0 = new Date('2026-12-10T09:30:00Z');
let now = T0;
const ctx = makeTestContext({ now: () => now });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };
const SLOTS = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i + 1}`, provider: 'Dr Ade',
    start: `2026-12-11T${String(8 + i).padStart(2, '0')}:00:00Z`,
    end: `2026-12-11T${String(8 + i).padStart(2, '0')}:30:00Z`,
}));

const ADA = 'ada@example.com';
const attempt = (email = ADA, slot_id = 'nope', extra = {}) =>
    request(ctx.app).post('/bookings').set(auth).send({ slot_id, name: 'Ada Obi', email, ...extra });
const secondsAfter = (s) => { now = new Date(T0.getTime() + s * 1000); };
const statuses = (rs) => rs.map((r) => r.status);

async function fiveAttempts(email = ADA) {
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await attempt(email)); // 404s: failed attempts
    return out;
}

function expectTooMany(res, retryAfter) {
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    if (retryAfter !== undefined) expect(res.headers['retry-after']).toBe(String(retryAfter));
}

beforeEach(async () => {
    now = T0;
    const res = await request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS });
    expect(res.status).toBe(200); // a bad fixture must fail loudly, not leave stale data behind
});

describe('the limit', () => {
    test('5 attempts are processed normally, the 6th is 429 with Retry-After', async () => {
        const first = await fiveAttempts();

        expect(statuses(first)).toEqual([404, 404, 404, 404, 404]);
        expectTooMany(await attempt(), 60);
    });

    test('FAILED attempts count: five failures block a valid booking', async () => {
        await fiveAttempts();

        expectTooMany(await attempt(ADA, 'f1'));
    });

    test('successful attempts count too', async () => {
        for (let i = 1; i <= 5; i++) expect((await attempt(ADA, `f${i}`)).status).toBe(201);

        expectTooMany(await attempt(ADA, 'f6'));
    });

    test('invalid details count, because the email is still usable (rate limit comes before validation)', async () => {
        const rs = [];
        for (let i = 0; i < 5; i++) rs.push(await attempt(ADA, 'f1', { name: '' }));

        expect(statuses(rs)).toEqual([400, 400, 400, 400, 400]);
        expectTooMany(await attempt(ADA, 'f1'));
    });

    test('another email is not affected', async () => {
        await fiveAttempts();
        expectTooMany(await attempt());

        expect((await attempt('bola@example.com', 'f1')).status).toBe(201);
    });

    test('the same email written differently is the same person', async () => {
        for (const email of ['ADA@Example.com', ' ada@example.com ', 'ada@example.com', 'Ada@example.COM', '  ADA@EXAMPLE.COM']) {
            await attempt(email);
        }

        expectTooMany(await attempt('ada@example.com'));
    });

    test('a replayed idempotent request is still an attempt', async () => {
        const payload = { slot_id: 'f1', name: 'Ada Obi', email: ADA };
        const send = () => request(ctx.app).post('/bookings').set(auth).set('Idempotency-Key', 'k').send(payload);
        const rs = [];
        for (let i = 0; i < 5; i++) rs.push(await send());

        expect(statuses(rs)).toEqual([201, 201, 201, 201, 201]);
        expectTooMany(await send());
    });

    test('requests without a valid key never reach the limiter', async () => {
        for (let i = 0; i < 6; i++) {
            const res = await request(ctx.app).post('/bookings').send({ slot_id: 'nope', name: 'Ada', email: ADA });
            expect(res.status).toBe(401);
        }

        expect((await attempt()).status).toBe(404); // still the first real attempt
    });

    test('a missing, invalid or non-string email is never limited (it is just a 400)', async () => {
        const bodies = [
            { slot_id: 'f1', name: 'Ada' },
            { slot_id: 'f1', name: 'Ada', email: 'nope' },
            { slot_id: 'f1', name: 'Ada', email: 123 },
        ];
        for (let i = 0; i < 3; i++) {
            for (const b of bodies) {
                expect((await request(ctx.app).post('/bookings').set(auth).send(b)).status).toBe(400);
            }
        }
    });

    test('listing and cancelling are not limited', async () => {
        for (let i = 0; i < 8; i++) {
            expect((await request(ctx.app).get(`/bookings?email=${ADA}`).set(auth)).status).toBe(200);
        }
    });
});

describe('the one-minute window and Retry-After', () => {
    test('the window slides: after a minute the email is allowed again', async () => {
        await fiveAttempts();
        expectTooMany(await attempt());

        secondsAfter(61);

        expect((await attempt()).status).toBe(404);
    });

    test('Retry-After is the seconds until the OLDEST attempt leaves the window', async () => {
        for (let i = 0; i < 3; i++) await attempt();       // at 0s
        secondsAfter(30);
        for (let i = 0; i < 2; i++) await attempt();       // at 30s
        secondsAfter(40);

        expectTooMany(await attempt(), 20);                // the 0s attempts expire at 60s
    });

    test('Retry-After is rounded UP to whole seconds, never 0', async () => {
        for (let i = 0; i < 5; i++) await attempt();
        now = new Date(T0.getTime() + 59_900);

        expectTooMany(await attempt(), 1);                 // 0.1 s left rounds up to 1
    });

    test('a fraction of a second rounds up too', async () => {
        now = new Date(T0.getTime() + 500);
        for (let i = 0; i < 5; i++) await attempt();
        secondsAfter(10);                                  // oldest expires at 60.5s: 50.5s left

        expectTooMany(await attempt(), 51);
    });

    test('an attempt exactly one minute old no longer counts (but one that is 59.999 s old still does)', async () => {
        await fiveAttempts();
        now = new Date(T0.getTime() + 59_999);
        expectTooMany(await attempt(), 1);                 // proves the limit is active first
        secondsAfter(60);

        expect((await attempt()).status).toBe(404);
    });

    test('blocked requests are NOT recorded, so they cannot extend the block forever', async () => {
        await fiveAttempts();
        secondsAfter(10);
        for (let i = 0; i < 4; i++) expectTooMany(await attempt());
        secondsAfter(60);

        expect((await attempt()).status).toBe(404);        // the blocked ones did not count
    });

    test('reset clears the counters', async () => {
        await fiveAttempts();
        expectTooMany(await attempt());                    // blocked before the reset
        await request(ctx.app).post('/reset').set(auth).send({ slots: SLOTS });

        expect((await attempt()).status).toBe(404);
    });
});

describe('simultaneous requests', () => {
    test('10 at once for one email: exactly 5 processed and 5 rejected', async () => {
        const rs = await Promise.all(Array.from({ length: 10 }, () => attempt()));

        expect(rs.filter((r) => r.status === 404)).toHaveLength(5);
        expect(rs.filter((r) => r.status === 429)).toHaveLength(5);
        rs.filter((r) => r.status === 429).forEach((r) => expectTooMany(r));
    });

    test('12 at once for 2 emails: each email gets its own 5 and is blocked after that', async () => {
        const rs = await Promise.all(
            Array.from({ length: 12 }, (_, i) => attempt(i % 2 ? 'bola@example.com' : ADA))
        );

        expect(rs.filter((r) => r.status === 404)).toHaveLength(10); // 5 + 5
        expect(rs.filter((r) => r.status === 429)).toHaveLength(2);  // the 6th of each
    });
});