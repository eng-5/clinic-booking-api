#!/usr/bin/env node
// scripts/smoke.js
//
// Runs the real user journey against a RUNNING service (local or deployed) and prints
// ok / FAIL for each step. Exit code 0 = everything passed, 1 = something failed.
//
//   bash:        BASE_URL=https://your-service.onrender.com API_KEY=... node scripts/smoke.js
//   PowerShell:  $env:BASE_URL="https://..."; $env:API_KEY="..."; npm run smoke
//
// It covers Levels 1 to 5, the web page, and the two key roles (the public key comes from /config.js), and finishes by resetting to an empty slot list (which also clears
// idempotency keys and rate-limit counters, so it can be re-run straight away).

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.API_KEY;
if (!BASE || !KEY) {
    console.error('Set BASE_URL and API_KEY first.');
    process.exit(2);
}

const results = [];

async function call(method, path, { body, raw, key = KEY, headers: extra = {} } = {}) {
    const started = Date.now();
    const headers = { 'content-type': 'application/json', ...extra };
    if (key) headers['x-api-key'] = key;
    const res = await fetch(BASE + path, {
        method,
        headers,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(90_000), // a cold start can take about a minute
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, headers: res.headers, ms: Date.now() - started };
}

const expect = (condition, message) => { if (!condition) throw new Error(message); };

// Each step returns the response time in ms (shown next to the result).
async function step(name, fn) {
    try {
        const ms = await fn();
        results.push(true);
        console.log(`  ok    ${name}${ms === undefined ? '' : `  (${ms} ms)`}`);
    } catch (err) {
        results.push(false);
        console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
}

const hour = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const t0 = Date.now() + 48 * hour;
const slots = [
    { id: 'smoke-1', provider: 'Smoke Dr', start: iso(t0), end: iso(t0 + hour / 2) },
    { id: 'smoke-2', provider: 'Smoke Dr', start: iso(t0 + hour), end: iso(t0 + 1.5 * hour) },
    { id: 'smoke-3', provider: 'Smoke Dr', start: iso(t0 + 2 * hour), end: iso(t0 + 2.5 * hour) },
    { id: 'smoke-4', provider: 'Smoke Dr', start: iso(t0 + 3 * hour), end: iso(t0 + 3.5 * hour) },
];
const person = (slot_id, n = 1) => ({ slot_id, name: `Smoke ${n}`, email: `smoke${n}@example.com` });
const availability = async () =>
    Object.fromEntries((await call('GET', '/slots')).body.slots.map((s) => [s.id, s.available]));
const state = {};

async function main() {
    console.log(`Smoke test against ${BASE}\n`);

    await step('health answers without a key (the first request also measures a cold start)', async () => {
        const r = await call('GET', '/health', { key: null });
        expect(r.status === 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
        return r.ms;
    });
    if (!results[0]) {
        console.log('\nThe service is not reachable or not healthy. Stopping.');
        process.exit(1);
    }

    await step('no key is rejected with 401', async () => {
        const r = await call('GET', '/slots', { key: null });
        expect(r.status === 401 && typeof r.body?.error === 'string', `got ${r.status}`);
        return r.ms;
    });
    await step('a wrong key is rejected with 401', async () => {
        const r = await call('GET', '/slots', { key: 'definitely-wrong' });
        expect(r.status === 401, `got ${r.status}`);
        return r.ms;
    });
    await step('the web page loads without a key', async () => {
        const started = Date.now();
        const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(90_000) });
        const html = await res.text();
        expect(res.status === 200 && /<h1/.test(html), `got ${res.status}`);
        expect(!!res.headers.get('content-security-policy'), 'the page should carry a Content-Security-Policy');
        return Date.now() - started;
    });
    await step('/config.js hands the page a PUBLIC key, and never the admin key', async () => {
        const res = await fetch(BASE + '/config.js');
        const text = await res.text();
        expect(res.status === 200, `got ${res.status}`);
        expect(!text.includes(KEY), 'config.js must NEVER contain the admin key');
        const match = text.match(/"publicKey":"([^"]+)"/);
        expect(!!match, 'PUBLIC_API_KEY is not set on the server, so the page cannot call the API');
        expect(match[1] !== KEY, 'the public key must differ from the admin key');
        state.publicKey = match[1];
    });
    await step('the public key can list slots', async () => {
        const r = await call('GET', '/slots', { key: state.publicKey });
        expect(r.status === 200, `got ${r.status}`);
        return r.ms;
    });
    await step('the public key is refused (403) on reset and on listing bookings', async () => {
        const reset = await call('POST', '/reset', { key: state.publicKey, body: { slots: [] } });
        const list = await call('GET', '/bookings?email=a%40b.com', { key: state.publicKey });
        expect(reset.status === 403 && list.status === 403, `reset ${reset.status}, list ${list.status}`);
    });
    await step('reset installs four future slots', async () => {
        const r = await call('POST', '/reset', { body: { slots } });
        expect(r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
        return r.ms;
    });
    await step('slots are listed in order and available', async () => {
        const r = await call('GET', '/slots');
        expect(r.status === 200, `got ${r.status}`);
        expect(r.body.slots.map((s) => s.id).join() === 'smoke-1,smoke-2,smoke-3,smoke-4', 'wrong order or content');
        expect(r.body.slots.every((s) => s.available === true), 'slots should be available');
        return r.ms;
    });
    await step('booking a slot returns 201 and a confirmed booking', async () => {
        const r = await call('POST', '/bookings', { body: person('smoke-1') });
        expect(r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
        expect(r.body.status === 'confirmed', 'status should be confirmed');
        expect(Object.keys(r.body).length === 6, 'booking should have exactly 6 fields');
        state.booking = r.body;
        return r.ms;
    });
    await step('the booking can be looked up', async () => {
        const r = await call('GET', `/bookings/${state.booking.id}`);
        expect(r.status === 200 && r.body.id === state.booking.id, `got ${r.status}`);
        return r.ms;
    });
    await step('booking the same slot again returns 409', async () => {
        const r = await call('POST', '/bookings', { body: person('smoke-1', 2) });
        expect(r.status === 409, `got ${r.status}`);
        return r.ms;
    });
    await step('10 simultaneous bookings of one slot: exactly one wins', async () => {
        const started = Date.now();
        const rs = await Promise.all(
            Array.from({ length: 10 }, (_, i) => call('POST', '/bookings', { body: person('smoke-2', i + 10) }))
        );
        const codes = rs.map((r) => r.status);
        expect(codes.filter((c) => c === 201).length === 1, `expected one 201, got ${codes.join(',')}`);
        expect(codes.filter((c) => c === 409).length === 9, `expected nine 409, got ${codes.join(',')}`);
        return Date.now() - started;
    });
    await step('both slots show as unavailable', async () => {
        const a = await availability();
        expect(a['smoke-1'] === false && a['smoke-2'] === false, JSON.stringify(a));
    });
    await step('cancelling returns 200 and frees the slot', async () => {
        const r = await call('DELETE', `/bookings/${state.booking.id}`);
        expect(r.status === 200 && r.body.status === 'cancelled', `got ${r.status}`);
        expect((await availability())['smoke-1'] === true, 'slot should be available again');
        return r.ms;
    });
    await step('cancelling twice returns 409', async () => {
        const r = await call('DELETE', `/bookings/${state.booking.id}`);
        expect(r.status === 409, `got ${r.status}`);
        return r.ms;
    });
    await step('invalid email returns 400', async () => {
        const r = await call('POST', '/bookings', { body: { ...person('smoke-1'), email: 'nope' } });
        expect(r.status === 400 && typeof r.body?.error === 'string', `got ${r.status}`);
        return r.ms;
    });
    await step('unknown slot returns 404', async () => {
        const r = await call('POST', '/bookings', { body: person('no-such-slot') });
        expect(r.status === 404, `got ${r.status}`);
        return r.ms;
    });
    await step('broken JSON returns 400 in the error shape', async () => {
        const r = await call('POST', '/bookings', { raw: '{bad' });
        expect(r.status === 400 && typeof r.body?.error === 'string', `got ${r.status}`);
        return r.ms;
    });
    await step('unknown booking returns 404', async () => {
        const r = await call('GET', '/bookings/does-not-exist');
        expect(r.status === 404, `got ${r.status}`);
        return r.ms;
    });
    await step('Level 4: an idempotent retry returns the same booking and makes no second one', async () => {
        const send = () => call('POST', '/bookings', { body: person('smoke-1', 21), headers: { 'idempotency-key': 'smoke-key-1' } });
        const first = await send();
        const again = await send();
        expect(first.status === 201, `first: got ${first.status} ${JSON.stringify(first.body)}`);
        expect(again.status === 201 && again.body.id === first.body.id, `retry: got ${again.status}, id ${again.body?.id} vs ${first.body.id}`);
        expect(again.headers.get('idempotent-replayed') === 'true', 'the retry should be marked as a replay');
        return again.ms;
    });
    await step('Level 4: the same key with a different body returns 422', async () => {
        const r = await call('POST', '/bookings', { body: person('smoke-3', 21), headers: { 'idempotency-key': 'smoke-key-1' } });
        expect(r.status === 422, `got ${r.status}`);
        return r.ms;
    });
    await step('Level 4: pagination returns one booking per page, then the cursor ends', async () => {
        const second = await call('POST', '/bookings', { body: person('smoke-3', 21) });
        expect(second.status === 201, `booking got ${second.status}`);
        const email = encodeURIComponent('smoke21@example.com');
        const p1 = await call('GET', `/bookings?email=${email}&limit=1`);
        expect(p1.status === 200 && p1.body.bookings.length === 1 && typeof p1.body.next_cursor === 'string', `page 1: ${JSON.stringify(p1.body)}`);
        const p2 = await call('GET', `/bookings?email=${email}&limit=1&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
        expect(p2.status === 200 && p2.body.bookings.length === 1 && p2.body.next_cursor === null, `page 2: ${JSON.stringify(p2.body)}`);
        expect(p1.body.bookings[0].id !== p2.body.bookings[0].id, 'pages should not repeat a booking');
        return p2.ms;
    });
    await step('Level 5: the 6th attempt for one email returns 429 with Retry-After', async () => {
        const attempt = () => call('POST', '/bookings', { body: { slot_id: 'no-such-slot', name: 'Smoke', email: 'smoke-limit@example.com' } });
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await attempt()).status);
        expect(codes.every((c) => c === 404), `the first five should be processed (404), got ${codes.join(',')}`);
        const sixth = await attempt();
        expect(sixth.status === 429, `6th: expected 429, got ${sixth.status}`);
        expect(/^\d+$/.test(sixth.headers.get('retry-after') ?? ''), 'Retry-After should be whole seconds');
        return sixth.ms;
    });
    await step('the public key can book a slot, as the page does', async () => {
        const r = await call('POST', '/bookings', { key: state.publicKey, body: person('smoke-4', 31), headers: { 'idempotency-key': 'smoke-page-1' } });
        expect(r.status === 201 && r.body.status === 'confirmed', `got ${r.status} ${JSON.stringify(r.body)}`);
        return r.ms;
    });
    await step('cleanup: reset to an empty slot list', async () => {
        const r = await call('POST', '/reset', { body: { slots: [] } });
        expect(r.status === 200, `got ${r.status}`);
        return r.ms;
    });

    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
    console.error('Smoke test crashed:', err.message);
    process.exit(1);
});