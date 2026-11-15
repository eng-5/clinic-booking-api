// src/config.js
//
// Reads and checks the environment at startup. Fails fast on mistakes that would be DANGEROUS
// (a missing key, or the page being handed the admin key). It only warns about things that would
// take a working deployment down if treated as errors (no public key yet).

function loadConfig(env = process.env) {
    const problems = [];
    const warnings = [];

    for (const name of ['DATABASE_URL', 'API_KEY']) {
        if (!env[name]) problems.push(`Missing env var ${name}`);
    }

    const publicKey = env.PUBLIC_API_KEY && env.PUBLIC_API_KEY.trim() !== '' ? env.PUBLIC_API_KEY : null;
    if (publicKey && publicKey === env.API_KEY) {
        // The message names the variables, never their values.
        problems.push('PUBLIC_API_KEY must differ from API_KEY: the web page would receive the admin key');
    }
    if (!publicKey) warnings.push('PUBLIC_API_KEY is not set: the web page cannot call the API');

    return {
        problems,
        warnings,
        config: {
            port: Number(env.PORT) || 3000,
            databaseUrl: env.DATABASE_URL,
            apiKey: env.API_KEY,
            publicKey,
        },
    };
}

module.exports = { loadConfig };