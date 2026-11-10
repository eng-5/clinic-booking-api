const { makeTestContext } = require('./helpers');

const ctx = makeTestContext();

afterAll(() => ctx.close());

test('test database is reachable and migrated', async () => {
    const { rows } = await ctx.pool.query("SELECT to_regclass('public.bookings') AS t");
    expect(rows[0].t).toBe('bookings');
});
