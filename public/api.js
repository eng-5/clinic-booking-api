// public/api.js
//
// The ONLY file that talks to the network. The page can do exactly two things with the API,
// and nothing else: list the slots, and create a booking. Every request carries the PUBLIC key.

(function (root, factory) {
    const api = factory(typeof module !== 'undefined' && module.exports ? require('./lib') : root.ClinicLib);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ClinicApi = api;
})(typeof window !== 'undefined' ? window : globalThis, function (lib) {
    'use strict';

    function createApi({ fetch, publicKey }) {
        // Never throws: always answers { ok: true, data } or { ok: false, error: { kind, message } }.
        async function call(method, path, { body, headers = {} } = {}) {
            let response;
            try {
                response = await fetch(path, {
                    method,
                    headers: {
                        'X-API-Key': publicKey,
                        Accept: 'application/json',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                        ...headers,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (err) {
                return { ok: false, error: { kind: 'server', message: lib.NETWORK_MESSAGE } };
            }

            let data = null;
            try { data = await response.json(); } catch (err) { /* an answer with no JSON body */ }

            if (response.ok) return { ok: true, status: response.status, data };
            return { ok: false, status: response.status, error: lib.describeError(response.status, data, response.headers) };
        }

        return {
            listSlots: () => call('GET', '/slots'),
            // The Idempotency-Key makes a retry safe: the same key with the same details never books twice.
            createBooking: (details, idempotencyKey) =>
                call('POST', '/bookings', { body: details, headers: { 'Idempotency-Key': idempotencyKey } }),
        };
    }

    return { createApi };
});