// tests/error.test.js
//
// Contract: every failure answers with JSON shaped exactly {"error": "<message>"}.
// Two layers:
//   1. Over HTTP, for failures Express/body-parser produce on their own.
//   2. Unit tests on the handler, because no real route throws on demand yet.

const request = require('supertest');
const { makeTestContext } = require('./helpers');
const errorController = require('../src/controllers/errorController');

const ctx = makeTestContext();
afterAll(() => ctx.close());

const auth = { 'X-API-Key': ctx.apiKey };

// One place that defines "what a correct error looks like".
function expectErrorShape(res, status) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/json/); // catches Express's HTML pages
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(Object.keys(res.body)).toEqual(['error']);   // no leftover status/message fields
}

describe('errors over HTTP use the {"error": "..."} shape', () => {
    test('unknown GET route returns 404', async () => {
        const res = await request(ctx.app).get('/nope').set(auth);
        expectErrorShape(res, 404);
    });

    test('unknown POST route returns 404', async () => {
        const res = await request(ctx.app).post('/nope').set(auth).send({});
        expectErrorShape(res, 404);
    });

    test('unknown route without a key returns 401, not 404 (every request needs the key)', async () => {
        const res = await request(ctx.app).get('/nope');
        expectErrorShape(res, 401);
    });

    test('malformed JSON returns 400 with fixed wording', async () => {
        const res = await request(ctx.app)
            .post('/bookings')
            .set(auth)
            .set('Content-Type', 'application/json')
            .send('{bad');
        expectErrorShape(res, 400);
        expect(res.body.error).toBe('invalid JSON body');
        expect(res.body.error).not.toContain('{bad'); // never echo client input
    });

    test('a body over 100kb returns 413', async () => {
        const res = await request(ctx.app)
            .post('/bookings')
            .set(auth)
            .send({ name: 'x'.repeat(150000) });
        expectErrorShape(res, 413);
    });
});

describe('errorController (unit)', () => {
    let req;
    let res;
    let next;
    let consoleSpy;

    beforeEach(() => {
        req = { log: { error: jest.fn() } };
        res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() };
        next = jest.fn();
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => consoleSpy.mockRestore());

    test('an unexpected error returns 500 with a generic message and leaks nothing', () => {
        errorController(new Error('password for db is hunter2'), req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'internal server error' });
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('hunter2');
    });

    test('logs the real error for 5xx using the request logger', () => {
        const err = new Error('boom');
        errorController(err, req, res, next);

        expect(req.log.error).toHaveBeenCalledTimes(1);
        expect(req.log.error.mock.calls[0][0].err).toBe(err);
    });

    test('falls back to console.error when there is no request logger', () => {
        errorController(new Error('boom'), {}, res, next);

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(500);
    });

    test('does not log client errors (4xx are not server faults)', () => {
        const err = Object.assign(new Error('slot not found'), { statusCode: 404 });
        errorController(err, req, res, next);

        expect(req.log.error).not.toHaveBeenCalled();
        expect(consoleSpy).not.toHaveBeenCalled();
    });

    test('client errors keep their intentional message and status', () => {
        const err = Object.assign(new Error('slot not found'), { statusCode: 404 });
        errorController(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'slot not found' });
    });

    test('reads err.status too (body-parser style) and uses fixed wording for known types', () => {
        const err = Object.assign(new Error('request entity too large'), {
            status: 413,
            type: 'entity.too.large',
        });
        errorController(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(413);
        expect(res.json).toHaveBeenCalledWith({ error: 'request body too large' });
    });

    test('malformed JSON gets fixed wording, not the parser message', () => {
        const err = Object.assign(new Error('Unexpected token b in JSON: {bad'), {
            status: 400,
            type: 'entity.parse.failed',
        });
        errorController(err, req, res, next);

        expect(res.json).toHaveBeenCalledWith({ error: 'invalid JSON body' });
    });

    test('an out-of-range status falls back to 500 instead of crashing the handler', () => {
        const err = Object.assign(new Error('boom'), { statusCode: 1000 });
        errorController(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    test('a non-numeric status (like the old "error" string) falls back to 500', () => {
        const err = Object.assign(new Error('boom'), { status: 'error' });
        errorController(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    test('a 503 does not leak its message', () => {
        const err = Object.assign(new Error('db host is x.y.z'), { statusCode: 503 });
        errorController(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({ error: 'internal server error' });
    });

    test('does not modify the error object it receives', () => {
        const err = new Error('boom');
        errorController(err, req, res, next);

        expect(err.statusCode).toBeUndefined();
        expect(err.status).toBeUndefined();
    });

    test('delegates to Express when headers were already sent', () => {
        const sent = { ...res, headersSent: true };
        const err = new Error('late');
        errorController(err, req, sent, next);

        expect(next).toHaveBeenCalledWith(err);
        expect(sent.status).not.toHaveBeenCalled();
    });
});