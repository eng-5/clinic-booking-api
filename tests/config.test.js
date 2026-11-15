// tests/config.test.js
//
// Startup configuration. Fail fast on mistakes that would be dangerous, but never on things that
// would take a working deployment down: a missing PUBLIC_API_KEY is a warning, not a crash.

const { loadConfig } = require('../src/config');

const good = { DATABASE_URL: 'postgres://x', API_KEY: 'admin-secret-value' };

describe('loadConfig', () => {
    test('accepts a minimal valid environment (no public key yet)', () => {
        const { problems, config } = loadConfig(good);

        expect(problems).toEqual([]);
        expect(config).toMatchObject({ port: 3000, apiKey: 'admin-secret-value', publicKey: null });
    });

    test.each(['DATABASE_URL', 'API_KEY'])('a missing %s is a problem', (name) => {
        const env = { ...good };
        delete env[name];

        expect(loadConfig(env).problems.join(' ')).toContain(name);
    });

    test('a public key equal to the admin key is a problem (the page would receive the admin key)', () => {
        const { problems } = loadConfig({ ...good, PUBLIC_API_KEY: 'admin-secret-value' });

        expect(problems.join(' ')).toMatch(/PUBLIC_API_KEY must differ/);
    });

    test('a different public key is accepted', () => {
        const { problems, config } = loadConfig({ ...good, PUBLIC_API_KEY: 'visitor-secret' });

        expect(problems).toEqual([]);
        expect(config.publicKey).toBe('visitor-secret');
    });

    test('no public key is a WARNING only, so an existing deployment keeps starting', () => {
        const { problems, warnings } = loadConfig(good);

        expect(problems).toEqual([]);
        expect(warnings.join(' ')).toMatch(/PUBLIC_API_KEY/);
    });

    test.each([[''], ['   ']])('a blank public key (%p) counts as not set', (blank) => {
        const { problems, config } = loadConfig({ ...good, PUBLIC_API_KEY: blank });

        expect(problems).toEqual([]);
        expect(config.publicKey).toBeNull();
    });

    test('PORT is read as a number, and defaults to 3000', () => {
        expect(loadConfig({ ...good, PORT: '8080' }).config.port).toBe(8080);
        expect(loadConfig({ ...good, PORT: 'abc' }).config.port).toBe(3000);
    });

    test('problems never include the secret values', () => {
        const { problems } = loadConfig({ ...good, PUBLIC_API_KEY: 'admin-secret-value' });

        expect(problems.join(' ')).not.toContain('admin-secret-value');
    });
});