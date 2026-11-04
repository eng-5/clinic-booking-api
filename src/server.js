// src/server.js
//
// The only file that wires the REAL pool and clock and starts listening.
// (app.js never calls listen, so tests can use the app without opening a port.)

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { createApp } = require('./app');

for (const key of ['DATABASE_URL', 'API_KEY']) {
    if (!process.env[key]) {
        console.error(`Missing env var ${key}`);
        process.exit(1);
    }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// The database can drop an idle connection (Neon suspends idle compute). Without this
// listener that emits an unhandled 'error' event, which crashes the whole process.
pool.on('error', (err) => console.error('idle pool client error:', err.message));

const app = createApp({ pool, clock: () => new Date(), apiKey: process.env.API_KEY });

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Listening on ${port}`));

// Render sends SIGTERM on deploys: stop accepting requests, then close the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close(() => pool.end().then(() => process.exit(0)));
    });
}