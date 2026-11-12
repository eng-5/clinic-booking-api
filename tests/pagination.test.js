// tests/pagination.test.js
//
// GET /bookings?email=&limit=&cursor=  (Level 4)
// A person's bookings, oldest first, case-insensitive on email, cursor pagination:
// pass next_cursor back as cursor; the last page has next_cursor: null.

const request = require('supertest');
const { makeTestContext } = require('./helpers');

const ctx = makeTestContext({ now: () => new Date('2026-12-10T09:30:00Z') });
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };
const ADA = 'ada@example.com';

const slots = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i + 1}`, provider: 'Dr Ade',
    start: `2026-12-11T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`,
    end: `2026-12-11T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '59' : '29'}:00Z`,
}));

const list = (query) => request(ctx.app).get(`/bookings?${query}`).set(auth);
const page = (email, limit, cursor) => {
    const q = new URLSearchParams({ email });
    if (limit !== undefined) q.set('limit', String(limit));
    if (cursor !== undefined) q.set('cursor', cursor);
    return list(q.toString());
};
const cursorOf = (text) => Buffer.from(text).toString('base64url');

function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(typeof res.body.error).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
}

// Seeds directly with SQL (one statement), so the suite stays fast: 25 bookings for Ada on
// slots s1..s25 (ids b001..b025, created in that order), 3 for Bola on s26..s28.
async function seed() {
    const reset = await request(ctx.app).post('/reset').set(auth).send({ slots });
    expect(reset.status).toBe(200); // a bad fixture must fail loudly, not leave stale data behind
    await ctx.pool.query(`
        INSERT INTO bookings (id, slot_id, name, email, status, created_at)
        SELECT 'b' || lpad(g::text, 3, '0'), 's' || g, 'Ada Obi', 'ada@example.com', 'confirmed', now()
        FROM generate_series(1, 25) g
    `);
    await ctx.pool.query(`
        INSERT INTO bookings (id, slot_id, name, email, status, created_at)
        SELECT 'c' || g, 's' || (25 + g), 'Bola Eze', 'bola@example.com', 'confirmed', now()
        FROM generate_series(1, 3) g
    `);
}

beforeEach(seed);

async function walk(email, limit) {
    const pages = [];
    let cursor;
    do {
        const res = await page(email, limit, cursor);
        expect(res.status).toBe(200);
        pages.push(res.body);
        cursor = res.body.next_cursor ?? undefined;
    } while (cursor && pages.length < 100);
    return pages;
}

describe('GET /bookings: shape and basics', () => {
    test('returns 200 with { bookings, next_cursor } and nothing else', async () => {
        const res = await page(ADA);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(Object.keys(res.body).sort()).toEqual(['bookings', 'next_cursor']);
    });

    test('each booking has exactly the six spec fields (no seq)', async () => {
        const res = await page(ADA, 1);

        expect(Object.keys(res.body.bookings[0]).sort()).toEqual(
            ['created_at', 'email', 'id', 'name', 'slot_id', 'status']
        );
    });

    test('the default page size is 10, oldest first', async () => {
        const res = await page(ADA);

        expect(res.body.bookings.map((b) => b.id)).toEqual(
            Array.from({ length: 10 }, (_, i) => `b${String(i + 1).padStart(3, '0')}`)
        );
        expect(typeof res.body.next_cursor).toBe('string');
    });

    test("only that person's bookings are returned", async () => {
        const res = await page('bola@example.com');

        expect(res.body.bookings.map((b) => b.id)).toEqual(['c1', 'c2', 'c3']);
    });

    test('an email with no bookings returns an empty page, not an error', async () => {
        const res = await page('nobody@example.com');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ bookings: [], next_cursor: null });
    });

    test('the email match ignores case and surrounding spaces', async () => {
        const res = await page('  ADA@Example.COM ', 50);

        expect(res.body.bookings).toHaveLength(25);
    });

    test('cancelled bookings are included and show their status', async () => {
        await ctx.pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = 'b002'");
        const res = await page(ADA, 3);

        expect(res.body.bookings.map((b) => b.status)).toEqual(['confirmed', 'cancelled', 'confirmed']);
    });

    test('a special-character email is just text', async () => {
        const res = await page("x' OR '1'='1");

        expect(res.status).toBe(200);
        expect(res.body.bookings).toEqual([]);
    });
});

describe('GET /bookings: walking the pages', () => {
    test('limit 10 over 25 bookings gives pages of 10, 10, 5 and a null cursor at the end', async () => {
        const pages = await walk(ADA, 10);

        expect(pages.map((p) => p.bookings.length)).toEqual([10, 10, 5]);
        expect(pages.map((p) => p.next_cursor !== null)).toEqual([true, true, false]);
        expect(pages[2].next_cursor).toBeNull();
    });

    test('every booking appears exactly once, in order', async () => {
        const ids = (await walk(ADA, 7)).flatMap((p) => p.bookings.map((b) => b.id));

        expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => `b${String(i + 1).padStart(3, '0')}`));
    });

    test('a last page that is EXACTLY full still ends with a null cursor', async () => {
        const pages = await walk(ADA, 5); // 25 bookings = five full pages

        expect(pages.map((p) => p.bookings.length)).toEqual([5, 5, 5, 5, 5]);
        expect(pages[4].next_cursor).toBeNull();
        expect(pages.slice(0, 4).every((p) => typeof p.next_cursor === 'string')).toBe(true);
    });

    test('a limit larger than the data returns everything and no cursor', async () => {
        const res = await page(ADA, 50);

        expect(res.body.bookings).toHaveLength(25);
        expect(res.body.next_cursor).toBeNull();
    });

    test('limit 1 walks one booking at a time', async () => {
        const first = await page('bola@example.com', 1);
        const second = await page('bola@example.com', 1, first.body.next_cursor);
        const third = await page('bola@example.com', 1, second.body.next_cursor);

        expect([first, second, third].map((r) => r.body.bookings[0].id)).toEqual(['c1', 'c2', 'c3']);
        expect(third.body.next_cursor).toBeNull();
    });

    test('a booking created between pages is neither skipped nor repeated', async () => {
        const first = await page(ADA, 10);
        await ctx.pool.query(
            "INSERT INTO bookings (id, slot_id, name, email, status, created_at) VALUES ('b026', 's30', 'Ada Obi', 'ada@example.com', 'confirmed', now())"
        );

        const rest = [];
        let cursor = first.body.next_cursor;
        while (cursor) {
            const res = await page(ADA, 10, cursor);
            rest.push(...res.body.bookings.map((b) => b.id));
            cursor = res.body.next_cursor;
        }
        const all = [...first.body.bookings.map((b) => b.id), ...rest];

        expect(new Set(all).size).toBe(all.length);
        expect(all).toHaveLength(26);
        expect(all[25]).toBe('b026');
    });
});

describe('GET /bookings: validation (400 with the error shape)', () => {
    test.each([
        ['email missing', ''],
        ['email empty', 'email='],
        ['email whitespace-only', 'email=%20%20'],
        ['email repeated', 'email=a%40b.com&email=c%40d.com'],
    ])('%s', async (label, query) => {
        expectErrorShape(await list(query), 400);
    });

    test.each([
        ['0'], ['51'], ['-1'], ['abc'], ['2.5'], [''], ['10abc'], ['1e1'], [' 5'], ['0x10'],
    ])('limit=%p is rejected', async (limit) => {
        expectErrorShape(await list(`email=${ADA}&limit=${encodeURIComponent(limit)}`), 400);
    });

    test('limit repeated is rejected', async () => {
        expectErrorShape(await list(`email=${ADA}&limit=5&limit=6`), 400);
    });

    test.each([['1'], ['50']])('the boundary limit=%s is accepted', async (limit) => {
        expect((await list(`email=${ADA}&limit=${limit}`)).status).toBe(200);
    });

    test.each([
        ['not base64url!!', 'not%20base64url!!'],
        ['an empty cursor', ''],
        ['a negative number', cursorOf('-5')],
        ['zero', cursorOf('0')],
        ['letters', cursorOf('abc')],
        ['a fraction', cursorOf('1.5')],
        ['a number with a leading zero', cursorOf('007')],
        ['an enormous number', cursorOf('99999999999999999999999')],
        ['a non-canonical encoding', cursorOf('12') + '='],
    ])('an invalid cursor (%s) returns 400, never a crash', async (label, cursor) => {
        expectErrorShape(await list(`email=${ADA}&cursor=${cursor}`), 400);
    });

    test('a cursor past the end returns an empty final page', async () => {
        const res = await page(ADA, 10, cursorOf('999999'));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ bookings: [], next_cursor: null });
    });
});