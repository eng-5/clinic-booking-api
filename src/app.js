// src/app.js
const express = require('express');
const { randomUUID } = require('crypto');
const pinoHttp = require('pino-http');

const verifyApiKey = require('./middleware/internalAuth');
const bookingsRouter = require('./routes/bookingsRouter');
const slotsRouter = require('./routes/slotsRouter');
const resetRouter = require('./routes/resetRouter');
const errorController = require('./controllers/errorController');

// Only accept a client-supplied request id if it is short and boring. Anything else could
// forge log lines or bloat the logs.
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

function createApp({ pool, clock, apiKey }) {
    const app = express();
    app.disable('x-powered-by');

    // 1. Logging and request tracing. First, so EVERY request (404s, 401s, bad JSON) is logged
    //    with an id. Quiet in tests, and /health is skipped so keep-alive pings don't flood logs.
    app.use(pinoHttp({
        level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL || 'info'),
        genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
                ? incoming
                : randomUUID();
            res.setHeader('X-Request-Id', id);
            return id;
        },
        autoLogging: { ignore: (req) => req.url === '/health' },
        customLogLevel: (req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
        },
        redact: [
            'req.headers["x-api-key"]',
            'req.headers.authorization',
            'req.headers.cookie',
        ],
    }));

    // 2. Health: no key, checks the database. Keep-alive pings and the host's checks use this.
    app.get('/health', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok', database: 'connected' });
        } catch (err) {
            req.log.error({ err }, 'health check failed');
            res.status(503).json({ error: 'database unavailable' });
        }
    });

    // 3. Everything below needs the API key. The key check runs BEFORE the body parser so a
    //    request with no key and a broken body gets 401, not 400.
    app.use(verifyApiKey(apiKey));
    app.use(express.json({ limit: '100kb' }));

    // 4. Routes. In step 1.7 these become factories: bookingsRouter({ pool, clock }), etc.
    app.use('/bookings', bookingsRouter);
    app.use('/slots', slotsRouter);
    app.use('/reset', resetRouter);

    // 5. Unknown routes, then the one error handler. Must stay last.
    app.use((req, res) => res.status(404).json({ error: 'route not found' }));
    app.use(errorController);

    return app;
}

module.exports = { createApp };