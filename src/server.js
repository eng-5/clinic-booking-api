require('dotenv').config();
const { Pool } = require('pg');
const { createApp } = require('./app');

for (const key of ['DATABASE_URL', 'API_KEY']) {
    if (!process.env[key]) {
        console.error(`Missing env var ${key}`)
        process.exit(1);
    }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const app = createApp({ pool, clock: () => new Date(), apiKey: process.env.API_KEY });

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Listening on ${port}`));

// Render sends SIGTERM on deploys: stop accepting requests, then close
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close(() => pool.end().then(() => process.exit(0)));
    });
}

