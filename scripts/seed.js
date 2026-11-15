#!/usr/bin/env node
// scripts/seed.js
//
// Fills a RUNNING service with realistic future slots so the web page has something to show.
// It calls POST /reset, which DELETES ALL BOOKINGS and replaces every slot, so it refuses to run
// against anything but localhost unless you pass --force.
//
//   npm run dev            (in one terminal)
//   node scripts/seed.js   (in another)
//
// Reads API_KEY and PORT from .env. BASE_URL overrides the address.

require('dotenv').config({ quiet: true });

const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const KEY = process.env.API_KEY;

if (!KEY) {
    console.error('API_KEY is not set (put it in .env).');
    process.exit(2);
}

const host = new URL(BASE).hostname;
const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
if (!isLocal && !process.argv.includes('--force')) {
    console.error(`Refusing to wipe ${BASE}: it is not localhost. Pass --force if you really mean it.`);
    process.exit(2);
}

const PROVIDERS = [
    { name: 'Dr Ade', code: 'ade' },
    { name: 'Dr Bello', code: 'bello' },
    { name: 'Dr Chika', code: 'chika' },
];
const DAYS = 7;                       // starting tomorrow
const START_HOURS = [9, 10, 11, 14];  // UTC, each slot is 30 minutes
const iso = (date) => date.toISOString().replace('.000Z', 'Z');

function buildSlots() {
    const slots = [];
    const today = new Date();
    for (let d = 1; d <= DAYS; d++) {
        for (const provider of PROVIDERS) {
            for (const hour of START_HOURS) {
                const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d, hour));
                const end = new Date(start.getTime() + 30 * 60 * 1000);
                const stamp = iso(start).replace(/[-:]/g, '').slice(0, 13); // 20261116T09
                slots.push({ id: `${provider.code}-${stamp}`, provider: provider.name, start: iso(start), end: iso(end) });
            }
        }
    }
    return slots;
}

async function main() {
    const slots = buildSlots();
    const res = await fetch(`${BASE}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ slots }),
        signal: AbortSignal.timeout(90_000),
    });
    if (res.status !== 200) {
        console.error(`Seeding failed: ${res.status} ${await res.text()}`);
        process.exit(1);
    }
    console.log(`Seeded ${slots.length} slots (${PROVIDERS.length} providers, next ${DAYS} days) at ${BASE}.`);
}

main().catch((err) => {
    console.error(`Could not reach ${BASE}: ${err.message}. Is "npm run dev" running?`);
    process.exit(1);
});