// tests/transaction.test.js
//
// withTransaction is the helper every multi-statement write will use (reset now; booking,
// idempotency and rate limiting later). Its two promises:
//   1. all-or-nothing: if anything throws, nothing it did is kept
//   2. it always gives the connection back, even on failure (a leak would exhaust the pool)
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const { withTransaction } = require('../src/db/transaction');
const { testDatabaseUrl } = require('./helpers');

const url = testDatabaseUrl();
// A deliberately tiny pool: if a failed transaction leaked its connection, the third
// call below would wait forever and the test would time out.
const pool = new Pool({ connectionString: url, max: 2 });

const count = async () => Number((await pool.query('SELECT count(*) FROM slots')).rows[0].count);

beforeEach(async () => {
    await pool.query('DELETE FROM bookings');
    await pool.query('DELETE FROM slots');
});
afterAll(() => pool.end());

const insertSlot = (client, id) =>
    client.query(
        "INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, 'Dr Ade', now(), now())",
        [id]
    );

test('commits everything and returns the callback result on success', async () => {
    const result = await withTransaction(pool, async (client) => {
        await insertSlot(client, 's1');
        await insertSlot(client, 's2');
        return 'done';
    });

    expect(result).toBe('done');
    expect(await count()).toBe(2);
});

test('rolls back everything and rethrows the original error on failure', async () => {
    await expect(
        withTransaction(pool, async (client) => {
            await insertSlot(client, 's1');
            throw new Error('boom');
        })
    ).rejects.toThrow('boom');

    expect(await count()).toBe(0);
});

test('rolls back after a database error too (not only thrown errors)', async () => {
    await expect(
        withTransaction(pool, async (client) => {
            await insertSlot(client, 's1');
            await insertSlot(client, 's1'); // duplicate primary key
        })
    ).rejects.toMatchObject({ code: '23505' });

    expect(await count()).toBe(0);
});

test('releases its connection even when the transaction fails', async () => {
    for (let i = 0; i < 5; i++) {
        await expect(
            withTransaction(pool, async () => {
                throw new Error('fail');
            })
        ).rejects.toThrow('fail');
    }
    // Five failures through a pool of two: only possible if every connection was released.
    expect(await withTransaction(pool, async () => 'still works')).toBe('still works');
});