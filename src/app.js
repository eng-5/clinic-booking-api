const express = require('express');
// const authRouter = require('./routes/authRouter');
// const { userRouter } = require('./routes/userRouter');
const bookingsRouter = require('./routes/bookingsRouter');
const slotsRouter = require('./routes/slotsRouter');
const resetRouter = require('./routes/resetRouter');
const globalErrorController = require('./controllers/errorController');

function createApp({ pool, clock, apiKey }) {
    const app = express();
    app.use(express.json({ limit: '100kb' }));

    app.get('/health', (req, res) => {
        res.json({ status: 'Application is running' });
    })
    // app.use('/auth', authRouter)
    app.use('/bookings', bookingsRouter)
    app.use('/slots', slotsRouter)
    app.use('/reset', resetRouter)
    app.use((req, res) => res.status(404).json({ error: 'Page Not Found' }));
    app.use(globalErrorController);

    //     /assessment-api/openapi.json
    // The exact contract for Task 1 of the Koya Cohort 4 assessment. Build these endpoints so our checks can talk to your API.

    // Everything is JSON. Each endpoint says which level it belongs to. Every error response looks like {"error": "<message>"}.

    // Every request needs the X-API-Key header (level 2). A missing or wrong key returns 401.

    // default

    // POST
    // /reset
    // Level 1 · Replace all slots

    // GET
    // /slots
    // Level 1 · List slots

    // POST
    // /bookings
    // Book a slot (levels 1–5)

    // GET
    // /bookings
    // Level 4 · List a person's bookings

    // GET
    // /bookings/{id}
    // Level 1 · Get a booking

    // DELETE
    // /bookings/{id}
    // Level 3 · Cancel a booking
    // Your job, in this order:
    // 1. GET /health  (no auth, runs SELECT 1)
    // 2. API key middleware
    // 3. routes: reset, slots, bookings
    // 4. 404 handler, then error handler (always {"error": "..."})

    return app
}

module.exports = { createApp }