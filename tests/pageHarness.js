// tests/pageHarness.js
//
// Runs the real page (public/index.html + its scripts) inside jsdom, talking to the REAL server.
// jsdom is a simulated browser: it runs the page's logic and DOM updates, but draws nothing,
// so it can prove behaviour, not how the page looks.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

// Time you control: nothing fires until the test calls advance().
class FakeTimers {
    constructor() { this.now = 0; this.queue = []; this.nextId = 1; }
    setTimeout = (fn, ms) => { const id = this.nextId++; this.queue.push({ id, at: this.now + ms, fn }); return id; };
    clearTimeout = (id) => { this.queue = this.queue.filter((t) => t.id !== id); };
    advance(ms) {
        const target = this.now + ms;
        for (; ;) {
            const due = this.queue.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!due) break;
            this.queue = this.queue.filter((t) => t !== due);
            this.now = due.at;
            due.fn();
        }
        this.now = target;
    }
}

// Wraps fetch so tests can see exactly what the page sent.
function spyFetch(baseUrl, override) {
    const calls = [];
    const real = (url, opts = {}) => fetch(new URL(url, baseUrl), opts);
    const fn = async (url, opts = {}) => {
        const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        const call = { method: (opts.method || 'GET').toUpperCase(), path: url, headers, body: opts.body ? JSON.parse(opts.body) : undefined };
        calls.push(call);
        if (override) {
            const handled = await override(call, real, url, opts);
            if (handled !== undefined) return handled;
        }
        return real(url, opts);
    };
    fn.calls = calls;
    return fn;
}

function openPage({ baseUrl, publicKey, fetchImpl, timeZone = 'UTC', now, timers = new FakeTimers(), locale = 'en-GB' }) {
    const dom = new JSDOM(read('index.html'), { url: `${baseUrl}/`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.__NO_AUTOSTART__ = true;
    w.__CONFIG__ = { publicKey };
    // The staff scripts are loaded exactly as the page loads them (order matters). Until they exist, tests that need them fail.
    const files = ['lib.js', 'api.js', 'app.js', 'staff-api.js', 'staff.js'].filter((f) => fs.existsSync(path.join(PUBLIC, f)));
    for (const file of files) w.eval(read(file));

    let n = 0;
    const app = w.ClinicApp.start({
        fetch: fetchImpl, now: () => now, timeZone, locale, timers,
        uuid: () => `key-${++n}`, slowAfterMs: 5000,
    });
    const staff = w.ClinicStaff
        ? w.ClinicStaff.start({ fetch: fetchImpl, now: () => now, timeZone, locale })
        : null;
    return {
        window: w, document: w.document, app, staff, timers,
        $: (sel) => w.document.querySelector(sel),
        $$: (sel) => [...w.document.querySelectorAll(sel)],
    };
}

async function waitFor(check, { timeout = 4000, label = 'condition' } = {}) {
    const start = Date.now();
    for (; ;) {
        const value = check();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 15));
    }
}

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
const type = (el, value) => { el.value = value; el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); };
const submit = (form) => form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
const visible = (el) => !!el && !el.hidden;

module.exports = { openPage, spyFetch, FakeTimers, waitFor, click, type, submit, visible };