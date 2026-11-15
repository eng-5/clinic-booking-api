// tests/lib.test.js
//
// The page's pure logic (public/lib.js): no DOM, no network. Time zones are passed in, so the
// results don't depend on the machine running the tests.

const Lib = require('../public/lib');

const slot = (id, start, end, available = true, provider = 'Dr Ade') => ({ id, provider, start, end, available });
const NOW = Date.parse('2026-12-10T09:30:00Z');

describe('which slots are shown', () => {
    test('a slot that has already started is hidden (booking it would be a 400)', () => {
        const slots = [slot('past', '2026-12-10T09:00:00Z', '2026-12-10T09:30:00Z'), slot('next', '2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z')];

        expect(Lib.visibleSlots(slots, NOW).map((s) => s.id)).toEqual(['next']);
    });

    test('a slot starting exactly now counts as started, like the server', () => {
        expect(Lib.isStarted(slot('x', '2026-12-10T09:30:00Z', '2026-12-10T10:00:00Z'), NOW)).toBe(true);
        expect(Lib.isStarted(slot('y', '2026-12-10T09:30:01Z', '2026-12-10T10:00:00Z'), NOW)).toBe(false);
    });

    test('booked slots stay in the list (shown as unavailable)', () => {
        expect(Lib.visibleSlots([slot('b', '2026-12-11T09:00:00Z', '2026-12-11T09:30:00Z', false)], NOW)).toHaveLength(1);
    });
});

describe('grouping by the viewer\'s local date', () => {
    const slots = [
        slot('late', '2026-12-10T23:30:00Z', '2026-12-11T00:00:00Z'),
        slot('mid', '2026-12-10T12:00:00Z', '2026-12-10T12:30:00Z'),
        slot('booked', '2026-12-10T13:00:00Z', '2026-12-10T13:30:00Z', false),
    ];

    test('in UTC all three are on the 10th, in time order, with an available count', () => {
        const days = Lib.groupByDate(slots, 'UTC', 'en-GB');

        expect(days).toHaveLength(1);
        expect(days[0]).toMatchObject({ key: '2026-12-10', total: 3, available: 2 });
        expect(days[0].slots.map((s) => s.id)).toEqual(['mid', 'booked', 'late']);
    });

    test('in Lagos (UTC+1) the 23:30Z slot belongs to the NEXT day', () => {
        const days = Lib.groupByDate(slots, 'Africa/Lagos', 'en-GB');

        expect(days.map((d) => d.key)).toEqual(['2026-12-10', '2026-12-11']);
        expect(days[1].slots.map((s) => s.id)).toEqual(['late']);
    });

    test('days come back in date order, and labels name the day and month', () => {
        const days = Lib.groupByDate([slot('b', '2026-12-12T09:00:00Z', '2026-12-12T09:30:00Z'), slot('a', '2026-12-11T09:00:00Z', '2026-12-11T09:30:00Z')], 'UTC', 'en-GB');

        expect(days.map((d) => d.key)).toEqual(['2026-12-11', '2026-12-12']);
        expect(days[0].label).toMatch(/11/);
        expect(days[0].label).toMatch(/Dec/);
    });

    test('no slots gives no days', () => {
        expect(Lib.groupByDate([], 'UTC', 'en-GB')).toEqual([]);
    });
});

describe('formatting', () => {
    test('a time range is shown in the viewer\'s zone', () => {
        expect(Lib.formatTimeRange('2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z', 'UTC', 'en-GB')).toMatch(/10:00.+10:30/);
        expect(Lib.formatTimeRange('2026-12-10T10:00:00Z', '2026-12-10T10:30:00Z', 'Africa/Lagos', 'en-GB')).toMatch(/11:00.+11:30/);
    });

    test('duration is in whole minutes', () => {
        expect(Lib.durationMinutes('2026-12-10T10:00:00Z', '2026-12-10T10:45:00Z')).toBe(45);
    });

    test('the time zone is named for the viewer', () => {
        expect(typeof Lib.zoneLabel('Africa/Lagos', '2026-12-10T10:00:00Z', 'en-GB')).toBe('string');
        expect(Lib.zoneLabel('Africa/Lagos', '2026-12-10T10:00:00Z', 'en-GB').length).toBeGreaterThan(0);
    });

    test.each([
        ['Dr Ade', 'AD'],
        ['Dr. Amina Bello', 'AB'],
        ['Chukwuma Obi', 'CO'],
        ['Dr Babatunde Adeyemi-Ogunlesi', 'BA'],
        ['', '?'],
    ])('initials for %p are %p', (name, expected) => {
        expect(Lib.initials(name)).toBe(expected);
    });
});

describe('turning server answers into messages', () => {
    const headers = (o = {}) => ({ get: (k) => o[k.toLowerCase()] ?? null });

    test.each([
        [409, 'taken'], [404, 'gone'], [400, 'invalid'], [401, 'config'], [403, 'config'],
        [429, 'rate'], [500, 'server'], [503, 'server'], [422, 'server'],
    ])('status %i is "%s"', (status, kind) => {
        expect(Lib.describeError(status, { error: 'x' }, headers()).kind).toBe(kind);
    });

    test('a 400 shows the server\'s own message', () => {
        expect(Lib.describeError(400, { error: 'slot has already started' }, headers()).message).toMatch(/already started/);
    });

    test('a 429 carries the Retry-After seconds, and falls back safely', () => {
        expect(Lib.describeError(429, {}, headers({ 'retry-after': '42' })).retryAfter).toBe(42);
        expect(Lib.describeError(429, {}, headers()).retryAfter).toBe(60);
        expect(Lib.describeError(429, {}, headers({ 'retry-after': 'soon' })).retryAfter).toBe(60);
        expect(Lib.describeError(429, {}, headers({ 'retry-after': '0' })).retryAfter).toBe(60);
    });

    test('a 5xx never shows the server\'s text to the patient', () => {
        const d = Lib.describeError(500, { error: 'select * from secrets' }, headers());

        expect(d.message).not.toMatch(/select/);
    });
});

describe('input checks and retry identity', () => {
    test.each([['ada@example.com', true], [' ada@example.com ', true], ['ada@', false], ['nope', false], ['', false], ['a b@c.com', false]])(
        'email %p is plausible: %s', (value, expected) => expect(Lib.isPlausibleEmail(value)).toBe(expected)
    );

    test('the same booking details give the same fingerprint, however they are typed', () => {
        const a = Lib.fingerprint({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
        const b = Lib.fingerprint({ slot_id: 's1', name: '  Ada Obi ', email: ' ADA@Example.com' });

        expect(a).toBe(b);
    });

    test('different details give a different fingerprint', () => {
        const base = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

        expect(Lib.fingerprint({ ...base, name: 'Ada Obi Jr' })).not.toBe(Lib.fingerprint(base));
        expect(Lib.fingerprint({ ...base, slot_id: 's2' })).not.toBe(Lib.fingerprint(base));
    });
});