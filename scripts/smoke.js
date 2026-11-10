#!/usr/bin/env node
// scripts/smoke.js
//
// Runs the real user journey against a RUNNING service (local or deployed) and prints
// ok / FAIL for each step. Exit code 0 = everything passed, 1 = something failed.
//
//   bash:        BASE_URL=https://your-service.onrender.com API_KEY=... node scripts/smoke.js
//   PowerShell:  $env:BASE_URL="https://..."; $env:API_KEY="..."; npm run smoke
//
// It finishes by resetting to an empty slot list. Add steps here as new levels are built
// (idempotency, pagination, rate limiting).

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.API_KEY;
if (!BASE || !KEY) {
    console.error('Set BASE_URL and API_KEY first.');
    process.exit(2);
}

const results = [];

async function call(method, path, { body, raw, key = KEY } = {}) {
    const started = Date.now();
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-api-key'] = key;
    const res = await fetch(BASE + path, {
        method,
        headers,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(90_000), // a cold start can take about a minute
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, ms: Date.now() - started };
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
    await step('reset installs two future slots', async () => {
        const r = await call('POST', '/reset', { body: { slots } });
        expect(r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
        return r.ms;
    });
    await step('slots are listed in order and available', async () => {
        const r = await call('GET', '/slots');
        expect(r.status === 200, `got ${r.status}`);
        expect(r.body.slots.map((s) => s.id).join() === 'smoke-1,smoke-2', 'wrong order or content');
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