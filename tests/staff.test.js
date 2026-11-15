// tests/staff.test.js
//
// The staff console on the page. Anyone can open it, but it does nothing until someone TYPES the
// admin key. The key is kept in memory only. Everything the console does is an admin-only API call.

jest.setTimeout(60000);
const request = require('supertest');
const { makeTestContext } = require('./helpers');
const { openPage, spyFetch, waitFor, click, type, submit, visible } = require('./pageHarness');

const NOW = new Date('2026-12-10T09:30:00Z');
const ctx = makeTestContext({ now: () => NOW });
let server;
let baseUrl;

beforeAll(async () => {
    server = ctx.app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.close();
});

const admin = { 'X-API-Key': ctx.apiKey };
const slot = (id, start, end, provider = 'Dr Ade') => ({ id, provider, start, end });
const SLOTS = [
    slot('a1', '2026-12-11T09:00:00Z', '2026-12-11T09:30:00Z'),
    slot('a2', '2026-12-11T10:00:00Z', '2026-12-11T10:30:00Z'),
    slot('a3', '2026-12-11T11:00:00Z', '2026-12-11T11:30:00Z'),
    ...Array.from({ length: 12 }, (_, i) => slot(`g${i + 1}`, `2026-12-12T${String(8 + i).padStart(2, '0')}:00:00Z`, `2026-12-12T${String(8 + i).padStart(2, '0')}:30:00Z`)),
];
const adminBook = (slot_id, name, email) => request(ctx.app).post('/bookings').set(admin).send({ slot_id, name, email });
const resetWith = async (slots) => {
    const res = await request(ctx.app).post('/reset').set(admin).send({ slots });
    expect(res.status).toBe(200); // a bad fixture must fail loudly, not leave stale data behind
};

beforeEach(() => resetWith(SLOTS));

async function open({ override, timeZone = 'UTC' } = {}) {
    const fetchImpl = spyFetch(baseUrl, override);
    const page = openPage({ baseUrl, publicKey: ctx.publicKey, fetchImpl, timeZone, now: NOW });
    page.calls = fetchImpl.calls;
    await page.app.ready;
    expect(page.staff).not.toBeNull(); // the staff scripts must be loaded
    return page;
}
const openStaff = (page) => click(page.$('#open-staff'));
const msg = (page, id) => page.$(id).textContent.trim();
const kind = (page, id) => page.$(id).dataset.kind;
const fake = (status, body, headers = {}) => ({
    status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body,
});

async function signIn(page, key = ctx.apiKey) {
    openStaff(page);
    type(page.$('#staff-key'), key);
    submit(page.$('#staff-signin-form'));
    await waitFor(() => visible(page.$('#staff-console')), { label: 'the staff console' });
}
async function find(page, email) {
    type(page.$('#find-email'), email);
    submit(page.$('#find-form'));
    await waitFor(() => page.$$('#find-results [data-booking-id]').length > 0 || page.$('#find-message').dataset.kind, { label: 'the search result' });
}
const rowIds = (page) => page.$$('#find-results [data-booking-id]').map((r) => r.dataset.bookingId);
const rowFor = (page, id) => page.$(`#find-results [data-booking-id="${id}"]`);

describe('opening the staff area and signing in', () => {
    test('the staff area is hidden and opening it sends no request at all', async () => {
        const page = await open();
        const before = page.calls.length;

        expect(visible(page.$('#staff'))).toBe(false);
        openStaff(page);

        expect(visible(page.$('#staff'))).toBe(true);
        expect(visible(page.$('#booking-view'))).toBe(false);
        expect(visible(page.$('#staff-console'))).toBe(false);
        expect(page.calls.length).toBe(before);
    });

    test('"Back to booking" returns to the booking page', async () => {
        const page = await open();
        openStaff(page);
        click(page.$('#close-staff'));

        expect(visible(page.$('#staff'))).toBe(false);
        expect(visible(page.$('#booking-view'))).toBe(true);
    });

    test('the admin key opens the console, and the key box is emptied', async () => {
        const page = await open();
        await signIn(page);

        expect(visible(page.$('#staff-signin'))).toBe(false);
        expect(page.$('#staff-key').value).toBe('');
    });

    test('the PUBLIC key is recognised as not an admin key (403) and does not open the console', async () => {
        const page = await open();
        openStaff(page);
        type(page.$('#staff-key'), ctx.publicKey);
        submit(page.$('#staff-signin-form'));

        await waitFor(() => kind(page, '#staff-message') === 'not-admin', { label: 'the message' });
        expect(visible(page.$('#staff-console'))).toBe(false);
    });

    test('an unknown key (401) is reported differently', async () => {
        const page = await open();
        openStaff(page);
        type(page.$('#staff-key'), 'definitely-wrong');
        submit(page.$('#staff-signin-form'));

        await waitFor(() => kind(page, '#staff-message') === 'unknown', { label: 'the message' });
        expect(visible(page.$('#staff-console'))).toBe(false);
    });

    test('an empty key is explained and nothing is sent', async () => {
        const page = await open();
        const before = page.calls.length;
        openStaff(page);
        submit(page.$('#staff-signin-form'));

        expect(kind(page, '#staff-message')).toBe('validation');
        expect(page.calls.length).toBe(before);
    });

    test('a network failure while checking the key is reported, and the console stays closed', async () => {
        const page = await open({ override: (call) => { if (call.path.startsWith('/bookings')) throw new Error('offline'); } });
        openStaff(page);
        type(page.$('#staff-key'), ctx.apiKey);
        submit(page.$('#staff-signin-form'));

        await waitFor(() => kind(page, '#staff-message') === 'server', { label: 'the message' });
        expect(visible(page.$('#staff-console'))).toBe(false);
    });

    test('signing out closes the console, and nothing can be sent afterwards', async () => {
        const page = await open();
        await signIn(page);
        click(page.$('#staff-signout'));
        const before = page.calls.length;

        expect(visible(page.$('#staff-console'))).toBe(false);
        expect(visible(page.$('#staff-signin'))).toBe(true);
        type(page.$('#find-email'), 'ada@example.com');
        submit(page.$('#find-form'));
        submit(page.$('#reset-form'));
        expect(page.calls.length).toBe(before);
    });
});

describe('the admin key stays private', () => {
    test('it is never put in storage, cookies, the address, the page text, or a form field', async () => {
        const page = await open();
        await signIn(page);

        expect(page.window.localStorage.length).toBe(0);
        expect(page.window.sessionStorage.length).toBe(0);
        expect(page.document.cookie).toBe('');
        expect(page.window.location.href).not.toContain(ctx.apiKey);
        const everything = page.document.documentElement.outerHTML
            + [...page.$$('input,textarea')].map((i) => i.value).join('|');
        expect(everything).not.toContain(ctx.apiKey);
    });

    test('before signing in every request carries the public key; the admin key appears only afterwards, only in the header', async () => {
        const page = await open();
        openStaff(page);
        const beforeSignIn = page.calls.length;
        await signIn(page);
        await find(page, 'nobody@example.com');

        for (const call of page.calls.slice(0, beforeSignIn)) expect(call.headers['x-api-key']).toBe(ctx.publicKey);
        for (const call of page.calls.slice(beforeSignIn)) {
            expect(call.headers['x-api-key']).toBe(ctx.apiKey);
            expect(JSON.stringify([call.path, call.body ?? null])).not.toContain(ctx.apiKey); // never in the URL or body
            expect(call.path.startsWith('/')).toBe(true); // same site only
        }
    });

    test('a public visitor who never signs in never triggers an admin request', async () => {
        const page = await open();
        click(page.$('#slot-list [data-state="available"] [data-action="select"]'));
        type(page.$('#name'), 'Ada Obi');
        type(page.$('#email'), 'ada@example.com');
        submit(page.$('#booking-form'));
        await waitFor(() => visible(page.$('#confirmation')), { label: 'the confirmation' });

        for (const c of page.calls) {
            expect(['GET /slots', 'POST /bookings']).toContain(`${c.method} ${c.path}`);
            expect(c.headers['x-api-key']).toBe(ctx.publicKey);
        }
    });

    test('a key the server later rejects ends the session with a clear message', async () => {
        let revoked = false;
        const page = await open({ override: (call) => (revoked && call.path.startsWith('/bookings?email=') ? fake(401, { error: 'Unauthorised entry' }) : undefined) });
        await signIn(page);
        revoked = true; // from now on the server refuses the key
        type(page.$('#find-email'), 'ada@example.com');
        submit(page.$('#find-form'));

        await waitFor(() => kind(page, '#staff-message') === 'session', { label: 'the session message' });
        expect(visible(page.$('#staff-console'))).toBe(false);
        expect(visible(page.$('#staff-signin'))).toBe(true);
    });
});

describe('finding bookings', () => {
    beforeEach(async () => {
        expect((await adminBook('a1', 'Ada Obi', 'ada@example.com')).status).toBe(201);
        expect((await adminBook('a2', 'Ada Obi', 'ada@example.com')).status).toBe(201);
        expect((await adminBook('a3', 'Bola Eze', 'bola@example.com')).status).toBe(201);
    });

    test('shows a person\'s bookings, oldest first, with every field, and nobody else\'s', async () => {
        const page = await open();
        await signIn(page);
        await find(page, '  ADA@Example.COM ');

        const rows = page.$$('#find-results [data-booking-id]');
        expect(rows).toHaveLength(2);
        const first = rows[0];
        expect(first.querySelector('[data-field="reference"]').textContent).toBe(first.dataset.bookingId);
        expect(first.querySelector('[data-field="name"]').textContent).toContain('Ada Obi');
        expect(first.querySelector('[data-field="email"]').textContent).toContain('ada@example.com');
        expect(first.querySelector('[data-field="slot"]').textContent).toContain('a1');
        expect(first.querySelector('[data-field="status"]').textContent).toMatch(/confirmed/i);
        expect(page.$('#find-results').textContent).not.toContain('Bola');
    });

    test('an email with no bookings says so', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'nobody@example.com');

        expect(kind(page, '#find-message')).toBe('empty');
        expect(rowIds(page)).toHaveLength(0);
    });

    test('an empty email is explained and nothing is sent', async () => {
        const page = await open();
        await signIn(page);
        const before = page.calls.length;
        submit(page.$('#find-form'));

        expect(kind(page, '#find-message')).toBe('validation');
        expect(page.calls.length).toBe(before);
    });

    test('a server failure is reported, never shown raw', async () => {
        const page = await open({ override: (call) => (call.path.startsWith('/bookings?email=ada') ? fake(500, { error: 'select * from secrets' }) : undefined) });
        await signIn(page);
        type(page.$('#find-email'), 'ada@example.com');
        submit(page.$('#find-form'));

        await waitFor(() => kind(page, '#find-message') === 'server', { label: 'the failure message' });
        expect(page.$('#find-message').textContent).not.toMatch(/select/);
    });

    test('names are shown as text, never as markup', async () => {
        await resetWith(SLOTS);
        await adminBook('a1', '<img src=x onerror="window.pwned=1">', 'xss@example.com');
        const page = await open();
        await signIn(page);
        await find(page, 'xss@example.com');

        expect(page.$('#find-results img')).toBeNull();
        expect(page.$('#find-results').textContent).toContain('<img src=x');
        expect(page.window.pwned).toBeUndefined();
    });

    test('more than one page: "Load more" fetches the rest, with no repeats', async () => {
        await ctx.pool.query(`
            INSERT INTO bookings (id, slot_id, name, email, status, created_at)
            SELECT 'm' || lpad(g::text, 2, '0'), 'g' || g, 'Many Obi', 'many@example.com', 'confirmed', now()
            FROM generate_series(1, 12) g
        `);
        const page = await open();
        await signIn(page);
        await find(page, 'many@example.com');

        expect(rowIds(page)).toHaveLength(10);
        expect(visible(page.$('#load-more'))).toBe(true);
        click(page.$('#load-more'));
        await waitFor(() => rowIds(page).length === 12, { label: 'the second page' });

        expect(new Set(rowIds(page)).size).toBe(12);
        expect(visible(page.$('#load-more'))).toBe(false);
    });
});

describe('looking up one booking by reference', () => {
    test('shows the booking', async () => {
        const created = (await adminBook('a1', 'Ada Obi', 'ada@example.com')).body;
        const page = await open();
        await signIn(page);
        type(page.$('#lookup-ref'), `  ${created.id} `);
        submit(page.$('#lookup-form'));

        await waitFor(() => page.$('#lookup-result [data-booking-id]'), { label: 'the booking' });
        expect(page.$('#lookup-result [data-booking-id]').dataset.bookingId).toBe(created.id);
        expect(page.$('#lookup-result').textContent).toContain('Ada Obi');
    });

    test('an unknown reference says so', async () => {
        const page = await open();
        await signIn(page);
        type(page.$('#lookup-ref'), 'does-not-exist');
        submit(page.$('#lookup-form'));

        await waitFor(() => kind(page, '#lookup-message') === 'not-found', { label: 'the message' });
    });

    test('a reference with special characters is encoded in the address, not trusted', async () => {
        const page = await open();
        await signIn(page);
        type(page.$('#lookup-ref'), 'a/b?c=1#x');
        submit(page.$('#lookup-form'));

        await waitFor(() => kind(page, '#lookup-message') === 'not-found', { label: 'the message' });
        expect(page.calls.at(-1).path).toBe('/bookings/a%2Fb%3Fc%3D1%23x');
    });

    test('an empty reference is explained and nothing is sent', async () => {
        const page = await open();
        await signIn(page);
        const before = page.calls.length;
        submit(page.$('#lookup-form'));

        expect(kind(page, '#lookup-message')).toBe('validation');
        expect(page.calls.length).toBe(before);
    });
});

describe('cancelling', () => {
    let booking;
    beforeEach(async () => {
        booking = (await adminBook('a1', 'Ada Obi', 'ada@example.com')).body;
    });
    const cancelBtn = (page, id, action = 'cancel') => rowFor(page, id).querySelector(`[data-action="${action}"]`);

    test('asks for confirmation first, and "Keep" cancels nothing', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');
        const before = page.calls.length;
        click(cancelBtn(page, booking.id));

        expect(page.calls.length).toBe(before); // nothing sent yet
        expect(cancelBtn(page, booking.id, 'cancel-confirm')).not.toBeNull();
        click(cancelBtn(page, booking.id, 'cancel-keep'));
        expect(cancelBtn(page, booking.id, 'cancel-confirm')).toBeNull();
        expect(page.calls.length).toBe(before);
    });

    test('confirming cancels it: the row updates, the slot is free again, and no cancel button remains', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');
        click(cancelBtn(page, booking.id));
        click(cancelBtn(page, booking.id, 'cancel-confirm'));

        await waitFor(() => rowFor(page, booking.id).dataset.status === 'cancelled', { label: 'the row to update' });
        expect(cancelBtn(page, booking.id)).toBeNull();
        const del = page.calls.find((c) => c.method === 'DELETE');
        expect(del.path).toBe(`/bookings/${booking.id}`);
        expect(del.headers['x-api-key']).toBe(ctx.apiKey);
        const slots = (await request(ctx.app).get('/slots').set(admin)).body.slots;
        expect(slots.find((s) => s.id === 'a1').available).toBe(true);
    });

    test('going back to the booking page shows the freed slot', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');
        click(cancelBtn(page, booking.id));
        click(cancelBtn(page, booking.id, 'cancel-confirm'));
        await waitFor(() => rowFor(page, booking.id).dataset.status === 'cancelled', { label: 'the row to update' });
        click(page.$('#close-staff'));

        await waitFor(() => page.$('[data-slot-id="a1"]') && page.$('[data-slot-id="a1"]').dataset.state === 'available', { label: 'the list to refresh' });
    });

    test('a booking someone already cancelled: the row is corrected and the message is clear', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');
        await request(ctx.app).delete(`/bookings/${booking.id}`).set(admin); // cancelled elsewhere meanwhile
        click(cancelBtn(page, booking.id));
        click(cancelBtn(page, booking.id, 'cancel-confirm'));

        await waitFor(() => rowFor(page, booking.id).dataset.status === 'cancelled', { label: 'the row to update' });
        expect(rowFor(page, booking.id).querySelector('[data-field="row-message"]').dataset.kind).toBe('conflict');
    });

    test('a booking that no longer exists is reported', async () => {
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');
        await resetWith(SLOTS); // wipes every booking
        click(cancelBtn(page, booking.id));
        click(cancelBtn(page, booking.id, 'cancel-confirm'));

        await waitFor(() => rowFor(page, booking.id).querySelector('[data-field="row-message"]').dataset.kind === 'not-found', { label: 'the message' });
    });

    test('a cancelled booking has no cancel button to begin with', async () => {
        await request(ctx.app).delete(`/bookings/${booking.id}`).set(admin);
        const page = await open();
        await signIn(page);
        await find(page, 'ada@example.com');

        expect(rowFor(page, booking.id).dataset.status).toBe('cancelled');
        expect(cancelBtn(page, booking.id)).toBeNull();
    });
});

describe('resetting the data', () => {
    const slotsJson = JSON.stringify([slot('n1', '2026-12-20T09:00:00Z', '2026-12-20T09:30:00Z'), slot('n2', '2026-12-20T10:00:00Z', '2026-12-20T10:30:00Z')]);
    const doReset = (page, json, confirm = 'RESET') => {
        type(page.$('#reset-json'), json);
        type(page.$('#reset-confirm'), confirm);
        submit(page.$('#reset-form'));
    };
    const bookingCount = async () => Number((await ctx.pool.query('SELECT count(*) FROM bookings')).rows[0].count);

    test.each([
        ['text that is not JSON', '{nope', /valid JSON/i],
        ['JSON that is not slots', '"hello"', /array of slots/i],
        ['an object with no slots list', '{"x":1}', /array of slots/i],
    ])('%s is explained and nothing is sent', async (label, json, pattern) => {
        const page = await open();
        await signIn(page);
        const before = page.calls.length;
        doReset(page, json);

        expect(kind(page, '#reset-message')).toBe('validation');
        expect(msg(page, '#reset-message')).toMatch(pattern);
        expect(page.calls.length).toBe(before);
    });

    test.each([['nothing', ''], ['the wrong word', 'reset'], ['a near miss', 'RESET ']])('typing %s instead of RESET sends nothing', async (label, word) => {
        const page = await open();
        await signIn(page);
        const before = page.calls.length;
        doReset(page, slotsJson, word);

        expect(msg(page, '#reset-message')).toMatch(/RESET/);
        expect(page.calls.length).toBe(before);
    });

    test('a valid list and the word RESET replaces the slots and deletes every booking', async () => {
        await adminBook('a1', 'Ada Obi', 'ada@example.com');
        const page = await open();
        await signIn(page);
        doReset(page, slotsJson);

        await waitFor(() => kind(page, '#reset-message') === 'success', { label: 'the success message' });
        expect(msg(page, '#reset-message')).toMatch(/2 slots/);
        expect(await bookingCount()).toBe(0);
        const slots = (await request(ctx.app).get('/slots').set(admin)).body.slots;
        expect(slots.map((s) => s.id)).toEqual(['n1', 'n2']);
        const post = page.calls.find((c) => c.method === 'POST' && c.path === '/reset');
        expect(post.headers['x-api-key']).toBe(ctx.apiKey);
        expect(post.body).toEqual({ slots: JSON.parse(slotsJson) });
    });

    test('an object with a "slots" list is accepted too', async () => {
        const page = await open();
        await signIn(page);
        doReset(page, JSON.stringify({ slots: JSON.parse(slotsJson) }));

        await waitFor(() => kind(page, '#reset-message') === 'success', { label: 'the success message' });
    });

    test('afterwards the boxes are cleared, so a stray click cannot repeat a reset', async () => {
        const page = await open();
        await signIn(page);
        doReset(page, slotsJson);
        await waitFor(() => kind(page, '#reset-message') === 'success', { label: 'the success message' });

        expect(page.$('#reset-json').value).toBe('');
        expect(page.$('#reset-confirm').value).toBe('');
    });

    test('a server refusal (400) shows the server\'s reason and leaves the data alone', async () => {
        await adminBook('a1', 'Ada Obi', 'ada@example.com');
        const page = await open();
        await signIn(page);
        doReset(page, JSON.stringify([{ id: 'x', provider: 'Dr', start: 'tomorrow', end: 'later' }]));

        await waitFor(() => kind(page, '#reset-message') === 'invalid', { label: 'the refusal' });
        expect(msg(page, '#reset-message')).toMatch(/start|datetime|date/i);
        expect(await bookingCount()).toBe(1);
    });

    test('the example button fills in valid slots that the server accepts', async () => {
        const page = await open();
        await signIn(page);
        click(page.$('#reset-example'));
        type(page.$('#reset-confirm'), 'RESET');
        submit(page.$('#reset-form'));

        await waitFor(() => kind(page, '#reset-message') === 'success', { label: 'the success message' });
    });

    test('going back to the booking page shows the new slots', async () => {
        const page = await open();
        await signIn(page);
        doReset(page, slotsJson);
        await waitFor(() => kind(page, '#reset-message') === 'success', { label: 'the success message' });
        click(page.$('#close-staff'));

        await waitFor(() => page.$('[data-slot-id="n1"]'), { label: 'the new slots' });
        expect(page.$('[data-slot-id="a1"]')).toBeNull();
    });
});