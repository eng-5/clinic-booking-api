// tests/page.test.js
//
// The page's behaviour, in a simulated browser (jsdom) talking to the REAL server.
// jsdom proves what the page DOES (what it sends, what it shows, what it refuses to do).
// It cannot prove how the page LOOKS: that is checked by eye on a phone and a desktop.

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
const slot = (id, provider, start, end) => ({ id, provider, start, end });
const SLOTS = [
    slot('p1', 'Dr Ade', '2026-12-10T09:00:00Z', '2026-12-10T09:30:00Z'), // started: must be hidden
    slot('a1', 'Dr Ade', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z'),
    slot('a2', 'Dr Bola', '2026-12-10T11:00:00Z', '2026-12-10T11:45:00Z'),
    slot('a3', 'Dr Ade', '2026-12-11T09:00:00Z', '2026-12-11T09:30:00Z'),
    slot('b1', 'Dr Bola', '2026-12-11T10:00:00Z', '2026-12-11T10:30:00Z'), // booked below
];
const adminBook = (slot_id, name, email) =>
    request(ctx.app).post('/bookings').set(admin).send({ slot_id, name, email });
const resetWith = async (slots) => {
    const res = await request(ctx.app).post('/reset').set(admin).send({ slots });
    expect(res.status).toBe(200); // a bad fixture must fail loudly, not leave stale data behind
};

beforeEach(async () => {
    await resetWith(SLOTS);
    expect((await adminBook('b1', 'Someone Else', 'someone@example.com')).status).toBe(201);
});

// Opens the page against the real server. `override` lets a test fake one particular response.
async function open({ override, publicKey = ctx.publicKey, timeZone = 'UTC', waitReady = true } = {}) {
    const fetchImpl = spyFetch(baseUrl, override);
    const page = openPage({ baseUrl, publicKey, fetchImpl, timeZone, now: NOW });
    page.calls = fetchImpl.calls;
    if (waitReady) await page.app.ready;
    return page;
}
const card = (page, id) => page.$(`[data-slot-id="${id}"]`);
const selectSlot = (page, id) => click(card(page, id).querySelector('[data-action="select"]'));
const fill = (page, name, email) => { type(page.$('#name'), name); type(page.$('#email'), email); };
const book = async (page, id, name = 'Ada Obi', email = 'ada@example.com') => {
    selectSlot(page, id);
    fill(page, name, email);
    submit(page.$('#booking-form'));
};
const confirmed = (page) => waitFor(() => visible(page.$('#confirmation')), { label: 'the confirmation' });
const fake = (status, body, headers = {}) => ({
    status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body,
});

describe('listing the appointments', () => {
    test('shows the available slots for the first day, and hides the loading state', async () => {
        const page = await open();

        expect(visible(page.$('#slots-loading'))).toBe(false);
        expect(page.$$('#slot-list [data-slot-id]').map((c) => c.dataset.slotId)).toEqual(['a1', 'a2']);
    });

    test('a slot that has already started is never shown', async () => {
        const page = await open();

        expect(page.$('[data-slot-id="p1"]')).toBeNull();
        click(page.$('#date-tabs [data-date="2026-12-11"]'));
        expect(page.$('[data-slot-id="p1"]')).toBeNull();
    });

    test('one tab per day, the first selected, each showing how many are available', async () => {
        const page = await open();
        const tabs = page.$$('#date-tabs [data-date]');

        expect(tabs.map((t) => t.dataset.date)).toEqual(['2026-12-10', '2026-12-11']);
        expect(tabs.map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        expect(tabs[0].textContent).toMatch(/\b2 available/);
        expect(tabs[1].textContent).toMatch(/\b1 available/); // a3 is free; b1 is booked
    });

    test('choosing another day shows that day, with a booked slot greyed out and not selectable', async () => {
        const page = await open();
        click(page.$('#date-tabs [data-date="2026-12-11"]'));

        expect(page.$$('#slot-list [data-slot-id]').map((c) => c.dataset.slotId)).toEqual(['a3', 'b1']);
        expect(card(page, 'b1').dataset.state).toBe('booked');
        expect(card(page, 'b1').querySelector('[data-action="select"]').disabled).toBe(true);
        expect(card(page, 'a3').dataset.state).toBe('available');
    });

    test('the provider filter lists every provider and narrows the list', async () => {
        const page = await open();
        const options = [...page.$('#provider-filter').options].map((o) => o.textContent.trim());

        expect(options).toEqual(expect.arrayContaining(['Dr Ade', 'Dr Bola']));
        page.$('#provider-filter').value = 'Dr Bola';
        page.$('#provider-filter').dispatchEvent(new page.window.Event('change', { bubbles: true }));

        expect(page.$$('#slot-list [data-slot-id]').map((c) => c.dataset.slotId)).toEqual(['a2']);
    });

    test('times are shown in the viewer\'s own time zone', async () => {
        const page = await open({ timeZone: 'Africa/Lagos' });

        expect(card(page, 'a1').querySelector('[data-field="time"]').textContent).toMatch(/11:00/);
    });

    test('the time-zone note names the zone once, and gives both the short and the full name when they differ', async () => {
        const utc = await open({ timeZone: 'UTC' });
        const lagos = await open({ timeZone: 'Africa/Lagos' });

        expect(utc.$('#zone-note').textContent).not.toMatch(/UTC \(UTC\)/);
        expect(utc.$('#zone-note').textContent).toMatch(/UTC/);
        expect(lagos.$('#zone-note').textContent).toMatch(/Africa\/Lagos/);
    });

    test('on load the page sends exactly one request: GET /slots with the public key', async () => {
        const page = await open();

        expect(page.calls).toHaveLength(1);
        expect(page.calls[0]).toMatchObject({ method: 'GET', path: '/slots' });
        expect(page.calls[0].headers['x-api-key']).toBe(ctx.publicKey);
    });

    test('with nothing to book it says so, with no day tabs', async () => {
        await resetWith([]);
        const page = await open();

        expect(visible(page.$('#slots-empty'))).toBe(true);
        expect(page.$$('#date-tabs [data-date]')).toHaveLength(0);
    });

    test('if every slot has already started, it also says so', async () => {
        await resetWith([slot('old', 'Dr Ade', '2026-12-10T08:00:00Z', '2026-12-10T08:30:00Z')]);
        const page = await open();

        expect(visible(page.$('#slots-empty'))).toBe(true);
    });
});

describe('choosing a slot', () => {
    test('the booking form is hidden until a slot is chosen', async () => {
        const page = await open();

        expect(visible(page.$('#booking-form'))).toBe(false);
        expect(visible(page.$('#no-selection'))).toBe(true);
    });

    test('choosing a slot shows its details and the form', async () => {
        const page = await open();
        selectSlot(page, 'a1');

        expect(visible(page.$('#booking-form'))).toBe(true);
        expect(visible(page.$('#no-selection'))).toBe(false);
        expect(page.$('#selected-slot').textContent).toMatch(/Dr Ade/);
        expect(card(page, 'a1').dataset.selected).toBe('true');
    });

    test('choosing a different slot moves the selection (never two at once)', async () => {
        const page = await open();
        selectSlot(page, 'a1');
        selectSlot(page, 'a2');

        expect(page.$$('[data-selected="true"]').map((c) => c.dataset.slotId)).toEqual(['a2']);
    });

    test('"Choose a different time" clears the selection', async () => {
        const page = await open();
        selectSlot(page, 'a1');
        click(page.$('#change-slot'));

        expect(visible(page.$('#booking-form'))).toBe(false);
        expect(page.$$('[data-selected="true"]')).toHaveLength(0);
    });
});

describe('booking', () => {
    test('a successful booking shows the confirmation with the real booking reference', async () => {
        const page = await open();
        await book(page, 'a1', '  Ada Obi ', 'ada@example.com');
        await confirmed(page);

        const reference = page.$('#confirmation [data-field="reference"]').textContent.trim();
        const stored = await request(ctx.app).get(`/bookings/${reference}`).set(admin);
        expect(stored.status).toBe(200);
        expect(stored.body).toMatchObject({ slot_id: 'a1', name: 'Ada Obi', email: 'ada@example.com', status: 'confirmed' });
        expect(page.$('#confirmation [data-field="provider"]').textContent).toMatch(/Dr Ade/);
        expect(page.$('#confirmation [data-field="name"]').textContent).toMatch(/Ada Obi/);
        expect(page.$('#confirmation [data-field="email"]').textContent).toMatch(/ada@example\.com/);
        expect(visible(page.$('#booking-form'))).toBe(false);
    });

    test('the request carries the public key, an Idempotency-Key, and the trimmed details', async () => {
        const page = await open();
        await book(page, 'a1', '  Ada Obi ', 'ada@example.com');
        await confirmed(page);

        const post = page.calls.find((c) => c.method === 'POST');
        expect(post.path).toBe('/bookings');
        expect(post.headers['x-api-key']).toBe(ctx.publicKey);
        expect(post.headers['idempotency-key']).toBe('key-1');
        expect(post.body).toEqual({ slot_id: 'a1', name: 'Ada Obi', email: 'ada@example.com' });
    });

    test('afterwards the list is refreshed, so the slot shows as booked', async () => {
        const page = await open();
        await book(page, 'a1');
        await confirmed(page);

        await waitFor(() => card(page, 'a1') && card(page, 'a1').dataset.state === 'booked', { label: 'a1 to show as booked' });
    });

    test('"Book another" returns to the list with nothing selected', async () => {
        const page = await open();
        await book(page, 'a1');
        await confirmed(page);
        click(page.$('#book-another'));

        expect(visible(page.$('#confirmation'))).toBe(false);
        expect(visible(page.$('#booking-form'))).toBe(false);
        expect(page.$('#name').value).toBe('');
    });

    test('text from the server or the patient is shown as text, never as markup', async () => {
        await resetWith([slot('x1', '<img src=x onerror="window.pwned=1">', '2026-12-10T12:00:00Z', '2026-12-10T12:30:00Z')]);
        const page = await open();

        expect(page.$('#slot-list img')).toBeNull();
        expect(card(page, 'x1').textContent).toContain('<img src=x');

        await book(page, 'x1', '<script>window.pwned=2</script>', 'ada@example.com');
        await confirmed(page);

        expect(page.$('#confirmation script')).toBeNull();
        expect(page.$('#confirmation [data-field="name"]').textContent).toContain('<script>');
        expect(page.window.pwned).toBeUndefined();
    });

    test('across a whole booking the page only ever makes allowed requests, with the public key', async () => {
        const page = await open();
        await book(page, 'a1');
        await confirmed(page);
        await waitFor(() => page.calls.filter((c) => c.method === 'GET').length >= 2, { label: 'the refresh' });

        for (const c of page.calls) {
            expect(['GET /slots', 'POST /bookings']).toContain(`${c.method} ${c.path}`);
            expect(c.headers['x-api-key']).toBe(ctx.publicKey);
        }
    });

    test('while a booking is being sent the button is disabled and a second submit is ignored', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const page = await open({ override: async (call, real, url, opts) => { if (call.method === 'POST') { await gate; return real(url, opts); } } });
        selectSlot(page, 'a1');
        fill(page, 'Ada Obi', 'ada@example.com');
        submit(page.$('#booking-form'));
        submit(page.$('#booking-form'));

        expect(page.$('#submit').disabled).toBe(true);
        release();
        await confirmed(page);
        expect(page.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });
});

describe('checking the form before sending', () => {
    test.each([
        ['an empty name', '', 'ada@example.com', '#name'],
        ['a name of only spaces', '   ', 'ada@example.com', '#name'],
        ['an invalid email', 'Ada Obi', 'nope', '#email'],
        ['an empty email', 'Ada Obi', '', '#email'],
    ])('%s is explained next to the form and nothing is sent', async (label, name, email, field) => {
        const page = await open();
        const before = page.calls.length;
        await book(page, 'a1', name, email);

        expect(page.$('#form-message').textContent.trim().length).toBeGreaterThan(0);
        expect(page.$('#form-message').dataset.kind).toBe('validation');
        expect(page.$(field).getAttribute('aria-invalid')).toBe('true');
        expect(page.calls.length).toBe(before);
    });
});

describe('when the booking does not go through', () => {
    test('a slot taken by someone else in the meantime: a clear message, the list refreshes, the selection clears', async () => {
        const page = await open();
        selectSlot(page, 'a1');
        fill(page, 'Ada Obi', 'ada@example.com');
        expect((await adminBook('a1', 'Faster Person', 'faster@example.com')).status).toBe(201);
        submit(page.$('#booking-form'));

        await waitFor(() => /taken/i.test(page.$('#form-message').textContent), { label: 'the "taken" message' });
        await waitFor(() => card(page, 'a1').dataset.state === 'booked', { label: 'the list to refresh' });
        expect(page.$$('[data-selected="true"]')).toHaveLength(0);
    });

    test('a taken slot clears the selection immediately, even if the list refresh then fails', async () => {
        let breakList = false;
        const page = await open({ override: (call) => (breakList && call.method === 'GET' ? fake(500, { error: 'x' }) : undefined) });
        selectSlot(page, 'a1');
        fill(page, 'Ada Obi', 'ada@example.com');
        expect((await adminBook('a1', 'Faster Person', 'faster@example.com')).status).toBe(201);
        breakList = true;
        submit(page.$('#booking-form'));

        await waitFor(() => /taken/i.test(page.$('#form-message').textContent), { label: 'the "taken" message' });
        expect(page.$$('[data-selected="true"]')).toHaveLength(0);
        expect(visible(page.$('#booking-form'))).toBe(false);
    });

    test('too many attempts: the wait time counts down, the button is disabled, then it comes back', async () => {
        for (let i = 0; i < 5; i++) await adminBook('nope', 'Ada', 'ada@example.com'); // five attempts for this email
        const page = await open();
        await book(page, 'a1', 'Ada Obi', 'ada@example.com');

        await waitFor(() => page.$('#form-message').dataset.kind === 'rate', { label: 'the rate-limit message' });
        expect(page.$('#form-message').textContent).toMatch(/60/);
        expect(page.$('#submit').disabled).toBe(true);
        expect(page.$('#submit').textContent).toBe('Confirm booking'); // not stuck on "Booking..." while waiting

        page.timers.advance(30000);
        expect(page.$('#form-message').textContent).toMatch(/30/);
        expect(page.$('#submit').disabled).toBe(true);

        page.timers.advance(30000);
        expect(page.$('#submit').disabled).toBe(false);
    });

    test('a network failure keeps the form, and the retry reuses the SAME Idempotency-Key', async () => {
        let failed = false;
        const page = await open({ override: (call) => { if (call.method === 'POST' && !failed) { failed = true; throw new Error('network down'); } } });
        await book(page, 'a1');

        await waitFor(() => page.$('#form-message').dataset.kind === 'server', { label: 'the failure message' });
        expect(visible(page.$('#booking-form'))).toBe(true);
        submit(page.$('#booking-form'));
        await confirmed(page);

        const keys = page.calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
        expect(keys).toEqual(['key-1', 'key-1']);
    });

    test('a server error shows a generic message, never the server\'s own text', async () => {
        const page = await open({ override: (call) => (call.method === 'POST' ? fake(500, { error: 'select * from secrets' }) : undefined) });
        await book(page, 'a1');

        await waitFor(() => page.$('#form-message').dataset.kind === 'server', { label: 'the failure message' });
        expect(page.$('#form-message').textContent).not.toMatch(/select/);
    });

    test('changing the details after a failure uses a NEW Idempotency-Key', async () => {
        let failed = false;
        const page = await open({ override: (call) => { if (call.method === 'POST' && !failed) { failed = true; return fake(503, { error: 'x' }); } } });
        await book(page, 'a1', 'Ada Obi');
        await waitFor(() => page.$('#form-message').dataset.kind === 'server', { label: 'the failure message' });

        type(page.$('#name'), 'Ada Obi Jr');
        submit(page.$('#booking-form'));
        await confirmed(page);

        const keys = page.calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
        expect(keys).toEqual(['key-1', 'key-2']);
    });
});

describe('problems loading the list', () => {
    test('a slow first response shows a "waking up" notice, which goes away when it arrives', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const page = await open({ waitReady: false, override: async (call, real, url, opts) => { await gate; return real(url, opts); } });

        expect(visible(page.$('#slow-notice'))).toBe(false);
        page.timers.advance(5000);
        expect(visible(page.$('#slow-notice'))).toBe(true);

        release();
        await page.app.ready;
        expect(visible(page.$('#slow-notice'))).toBe(false);
        expect(page.$$('#slot-list [data-slot-id]').length).toBeGreaterThan(0);
    });

    test('if the list fails to load there is a clear error and a working "Try again"', async () => {
        let first = true;
        const page = await open({ override: (call) => { if (first) { first = false; return fake(500, { error: 'x' }); } } });

        expect(visible(page.$('#slots-error'))).toBe(true);
        click(page.$('#retry-slots'));
        await waitFor(() => page.$$('#slot-list [data-slot-id]').length > 0, { label: 'the list after retrying' });
        expect(visible(page.$('#slots-error'))).toBe(false);
    });

    test('a network failure on the list is handled the same way', async () => {
        const page = await open({ override: () => { throw new Error('offline'); } });

        expect(visible(page.$('#slots-error'))).toBe(true);
    });

    test('with no key configured the page says so and makes no requests at all', async () => {
        const page = await open({ publicKey: null });

        expect(visible(page.$('#config-error'))).toBe(true);
        expect(page.calls).toHaveLength(0);
    });

    test('a key the server rejects is reported as a set-up problem', async () => {
        const page = await open({ publicKey: 'not-the-real-key' });

        expect(visible(page.$('#config-error'))).toBe(true);
    });
});