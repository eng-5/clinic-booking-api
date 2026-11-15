// tests/pagefiles.test.js
//
// The page must obey the same rules as the Content Security Policy the server sends: its own
// files only, no inline script or style, nothing from another site, no secrets, no unsafe DOM
// writes. A real browser would enforce these at runtime; here they are enforced before deploy.
// It also enforces who may know about the admin side: only the staff scripts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const html = read('index.html');

const publicJs = ['lib.js', 'api.js', 'app.js'];          // what every visitor runs
const staffJs = ['staff-api.js', 'staff.js'];             // only does anything after the admin key is typed
const ownJs = [...publicJs, ...staffJs];
const scripts = ['config.js', ...ownJs];

describe('index.html obeys the Content Security Policy', () => {
    test('has no inline script', () => {
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    });
    test('has no inline event handlers (onclick=...)', () => {
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    });
    test('has no style attributes and no <style> blocks', () => {
        expect(html).not.toMatch(/\sstyle\s*=/i);
        expect(html).not.toMatch(/<style/i);
    });
    test('loads nothing from another site', () => {
        const external = (html.match(/(?:src|href)\s*=\s*"([^"]+)"/gi) || []).filter((a) => /^(?:src|href)\s*=\s*"(?:https?:)?\/\//i.test(a));
        expect(external).toEqual([]);
    });
    test('every local file it references exists (config.js is produced by the server, not a file)', () => {
        const producedByTheServer = new Set(['config.js']);
        for (const m of html.matchAll(/(?:src|href)\s*=\s*"\/([^"#?]+)"/gi)) {
            if (producedByTheServer.has(m[1])) continue;
            expect(fs.existsSync(path.join(PUBLIC, m[1]))).toBe(true);
        }
    });
    test('loads its scripts in dependency order: config, lib, api, app, staff-api, staff', () => {
        const order = [...html.matchAll(/<script[^>]*\bsrc="\/([^"]+)"/gi)].map((m) => m[1]);
        expect(order).toEqual(scripts);
    });
    test('is a complete, accessible document: language, title, viewport, one h1', () => {
        expect(html).toMatch(/<html[^>]*\blang="en"/i);
        expect(html).toMatch(/<title>[^<]+<\/title>/i);
        expect(html).toMatch(/name="viewport"/i);
        expect((html.match(/<h1[\s>]/gi) || [])).toHaveLength(1);
    });
});

describe('the staff area in the markup', () => {
    test('is hidden until opened, and the booking view is a separate section', () => {
        expect(html).toMatch(/<section[^>]*id="staff"[^>]*\bhidden\b/i);
        expect(html).toMatch(/id="booking-view"/);
        expect(html).toMatch(/id="staff-console"[^>]*\bhidden\b|\bhidden\b[^>]*id="staff-console"/i);
    });
    test('the key box is a password field that browsers are told not to remember', () => {
        const input = html.match(/<input[^>]*id="staff-key"[^>]*>/i)[0];
        expect(input).toMatch(/type="password"/i);
        expect(input).toMatch(/autocomplete="off"/i);
    });
    test('has a way in from the footer and a way back', () => {
        expect(html).toMatch(/id="open-staff"/);
        expect(html).toMatch(/id="close-staff"/);
    });
});

describe('the scripts are safe to ship', () => {
    test.each(ownJs)('%s never writes HTML from data or evaluates strings', (file) => {
        expect(read(file)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setAttribute\(\s*['"]on/);
    });
    test.each(ownJs)('%s never stores anything or logs: no storage, cookies, or console output (the admin key must not leak)', (file) => {
        expect(read(file)).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\./);
    });
    test.each(publicJs)('%s (what every visitor runs) never mentions the admin-only routes or any key but the public one', (file) => {
        expect(read(file)).not.toMatch(/\/reset|API_KEY|apiKey|adminKey|DELETE/);
    });
    test('the admin routes appear ONLY in the staff scripts', () => {
        expect(read('staff-api.js')).toMatch(/\/reset/);
        expect(read('staff-api.js')).toMatch(/adminKey/);
    });
    test('the public scripts never load or call the staff scripts', () => {
        for (const file of publicJs) expect(read(file)).not.toMatch(/ClinicStaff|staff-api|staff\.js/);
    });
    test('only the two api files talk to the network', () => {
        expect(read('lib.js')).not.toMatch(/\bfetch\b/);
        expect(read('app.js')).not.toMatch(/\bfetch\s*\(/);
        expect(read('staff.js')).not.toMatch(/\bfetch\s*\(/);
    });
    test.each(['app.js', 'staff.js'])('%s sets text with textContent, never from markup', (file) => {
        expect(read(file)).toMatch(/textContent/);
    });
});

describe('public/ contains no secrets and nothing that should not be public', () => {
    const files = fs.readdirSync(PUBLIC, { recursive: true }).filter((f) => /\.(html|js|css|txt|json)$/.test(f));

    test('there is at least the page', () => expect(files).toContain('index.html'));

    test.each(files)('%s has no keys, database URLs or environment access', (file) => {
        expect(read(file)).not.toMatch(/process\.env|postgres(ql)?:\/\/|DATABASE_URL|API_KEY\s*=/);
    });
});

describe('styles', () => {
    const css = read('styles.css');

    test('Inter is loaded from local font files, not from another site', () => {
        expect(css).toMatch(/@font-face/);
        expect(css).toMatch(/url\(\/?fonts\/[^)]+\.woff2\)/);
        expect(css).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//);
        for (const m of css.matchAll(/url\(\/?(fonts\/[^)]+\.woff2)\)/g)) {
            expect(fs.existsSync(path.join(PUBLIC, m[1]))).toBe(true);
        }
    });

    test('every utility class the page uses exists in the stylesheet (a typo would silently lose styling)', () => {
        const fromHtml = [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
        const fromJs = ['app.js', 'staff.js'].flatMap((file) => {
            const block = read(file).match(/\/\/ <classes>([\s\S]*?)\/\/ <\/classes>/)[1];
            return [...block.matchAll(/'([^']*)'/g)].flatMap((m) => m[1].split(/\s+/));
        });
        // Read the stylesheet the way a browser does: CSS spells special characters with escapes
        // (a comma becomes \2c, a colon \:), so undo them to get the class names it really defines.
        const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (m, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
        const defined = new Set([...css.matchAll(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/g)].map((m) => unescapeCss(m[1])));
        const custom = new Set(['skeleton', '']);
        const missing = [...new Set([...fromHtml, ...fromJs])].filter((c) => !custom.has(c) && !defined.has(c));

        expect(missing).toEqual([]);
    });

    test('has no @import of another site', () => {
        expect(css).not.toMatch(/@import/);
    });

    test('is up to date: rebuilding from the sources gives the same file', () => {
        const out = path.join(os.tmpdir(), `styles-check-${process.pid}.css`);
        execFileSync(process.execPath, [
            path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
            '-c', path.join(ROOT, 'web', 'tailwind.config.js'),
            '-i', path.join(ROOT, 'web', 'input.css'),
            '-o', out, '--minify',
        ], { cwd: ROOT, stdio: 'pipe' });

        expect(fs.readFileSync(out, 'utf8')).toBe(css);
    });
});