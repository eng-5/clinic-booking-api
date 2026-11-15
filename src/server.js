// src/server.js
//
// The only file that wires the REAL pool and clock and starts listening.
// (app.js never calls listen, so tests can use the app without opening a port.)

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { createApp } = require('./app');
const { loadConfig } = require('./config');

const { problems, warnings, config } = loadConfig(process.env);
warnings.forEach((w) => console.warn(`Warning: ${w}`));
if (problems.length > 0) {
    problems.forEach((p) => console.error(p));
    process.exit(1);
}

// connectionTimeoutMillis: if the database is unreachable, fail after 10 seconds instead of
// waiting forever, so /health answers 503 instead of hanging.
const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 10_000,
});

// The database can drop an idle connection. Without this listener that emits an unhandled
// 'error' event, which crashes the whole process.
pool.on('error', (err) => console.error('idle pool client error:', err.message));

const app = createApp({
    pool,
    clock: () => new Date(),
    apiKey: config.apiKey,
    publicKey: config.publicKey,
});

const server = app.listen(config.port, () => console.log(`Listening on ${config.port}`));

// Render sends SIGTERM on deploys: stop accepting requests, then close the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close(() => pool.end().then(() => process.exit(0)));
    });
}