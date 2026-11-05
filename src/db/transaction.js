// src/db/transaction.js
//
// Runs `fn(client)` inside one database transaction: all-or-nothing.
//   - success: COMMIT and return what fn returned
//   - any error: ROLLBACK, then rethrow the ORIGINAL error
// The connection is always given back to the pool, so a failure can't leak connections.
//
// Why a client and not pool.query? A pool hands each query to ANY free connection, so
// BEGIN, the statements and COMMIT could run on different connections and not be a
// transaction at all. One client = one connection for the whole transaction.

async function withTransaction(pool, fn) {
    const client = await pool.connect();
    let broken = false;
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // The connection itself is dead. Tell the pool to throw it away, not reuse it.
            broken = true;
        }
        throw err; // always the original error, never the rollback's
    } finally {
        client.release(broken);
    }
}

module.exports = { withTransaction };