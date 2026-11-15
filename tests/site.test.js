// tests/site.test.js
//
// The web page is served by the same service, BEFORE the API-key check (a browser has no key
// when it first asks for the page). The page gets the PUBLIC key from /config.js, so the key
// never lives in the repository. Security headers stop the page loading anything but its own files.

const request = require('supertest');
const { makeTestContext } = require('./helpers');
const { createApp } = require('../src/app');

const ctx = makeTestContext();
afterAll(() => ctx.close());

describe('the page', () => {
    test('GET / returns the page without any key', async () => {
        const res = await request(ctx.app).get('/');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
        expect(res.text).toMatch(/<html/i);
    });

    test('the API stays protected even though the page is open', async () => {
        expect((await request(ctx.app).get('/slots')).status).toBe(401);
        expect((await request(ctx.app).post('/reset').send({ slots: [] })).status).toBe(401);
    });

    test.each([
        ['a dotfile', '/.env'],
        ['a path that climbs out of the public folder', '/..%2f..%2fpackage.json'],
        ['a path that climbs out (encoded dots)', '/%2e%2e/%2e%2e/package.json'],
        ['a source file', '/src/app.js'],
    ])('%s is never served', async (label, path) => {
        const res = await request(ctx.app).get(path);

        expect(res.status).not.toBe(200);
        expect(res.text).not.toMatch(/createApp|"dependencies"|DATABASE_URL/);
    });

    test('an unknown path without a key is still 401, and with the admin key is a JSON 404', async () => {
        expect((await request(ctx.app).get('/nope.css')).status).toBe(401);

        const res = await request(ctx.app).get('/nope.css').set('X-API-Key', ctx.apiKey);
        expect(res.status).toBe(404);
        expect(Object.keys(res.body)).toEqual(['error']);
    });
});

describe('/config.js', () => {
    test('hands the page the PUBLIC key, as JavaScript, without needing a key', async () => {
        const res = await request(ctx.app).get('/config.js');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/javascript/);
        expect(res.text).toContain(`window.__CONFIG__ = {"publicKey":"${ctx.publicKey}"}`);
    });

    test('NEVER contains the admin key', async () => {
        const res = await request(ctx.app).get('/config.js');

        expect(res.status).toBe(200); // it must exist before "does not contain" means anything
        expect(res.text).not.toContain(ctx.apiKey);
    });

    test('is never cached, so a key change takes effect at once', async () => {
        expect((await request(ctx.app).get('/config.js')).headers['cache-control']).toMatch(/no-store/);
    });

    test('with no public key configured it says so (null), and still has no admin key', async () => {
        const app = createApp({ pool: ctx.pool, clock: () => new Date(), apiKey: ctx.apiKey });
        const res = await request(app).get('/config.js');

        expect(res.text).toContain('window.__CONFIG__ = {"publicKey":null}');
        expect(res.text).not.toContain(ctx.apiKey);
    });

    test('cannot be used to break out of the script (angle brackets are escaped)', async () => {
        const app = createApp({ pool: ctx.pool, clock: () => new Date(), apiKey: ctx.apiKey, publicKey: 'a</script><b>' });
        const res = await request(app).get('/config.js');

        expect(res.text).not.toContain('</script>');
        expect(res.text).toContain('\\u003c');
    });
});

describe('security headers', () => {
    const csp = async (path, key) => {
        const req = request(ctx.app).get(path);
        return (key ? req.set('X-API-Key', key) : req);
    };

    test.each([['the page', '/'], ['config.js', '/config.js'], ['a 401 JSON error', '/slots'], ['health', '/health']])(
        'are on %s', async (label, path) => {
            const res = await csp(path);

            expect(res.headers['x-content-type-options']).toBe('nosniff');
            expect(res.headers['referrer-policy']).toBe('no-referrer');
            expect(res.headers['content-security-policy']).toBeDefined();
        }
    );

    test('the policy allows only the page\'s own files, and no framing', async () => {
        const policy = (await request(ctx.app).get('/')).headers['content-security-policy'];

        expect(policy).toMatch(/default-src 'none'/);
        expect(policy).toMatch(/script-src 'self'(;|$)/);
        expect(policy).toMatch(/style-src 'self'(;|$)/);
        expect(policy).toMatch(/connect-src 'self'/);
        expect(policy).toMatch(/frame-ancestors 'none'/);
        expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|https?:\/\/|\*/);
    });
});