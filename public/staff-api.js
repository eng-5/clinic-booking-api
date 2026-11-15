// public/staff-api.js
//
// The staff console's network layer, kept apart from api.js on purpose: this is the ONLY file that
// knows the admin routes, and the admin key only ever exists inside the object it creates (the
// caller never receives the key back). Nothing here stores, logs or displays the key.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ClinicStaffApi = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const NETWORK_MESSAGE = 'We could not reach the booking service. Check your connection and try again.';

    // kind says what the console should DO; the text of a 5xx is never passed on.
    function describe(status, data) {
        const text = data && typeof data.error === 'string' ? data.error : '';
        switch (status) {
            case 401: return { kind: 'unknown', message: 'That key was not recognised.' };
            case 403: return { kind: 'not-admin', message: 'That key is not an admin key.' };
            case 404: return { kind: 'not-found', message: text || 'Not found.' };
            case 409: return { kind: 'conflict', message: text || 'That conflicts with the current state.' };
            case 400: return { kind: 'invalid', message: text || 'The request was not accepted.' };
            default: return { kind: 'server', message: 'Something went wrong on our side. Please try again in a moment.' };
        }
    }

    function createStaffApi({ fetch, adminKey }) {
        // Never throws: answers { ok: true, data } or { ok: false, error: { kind, message } }.
        async function call(method, path, body) {
            let response;
            try {
                response = await fetch(path, {
                    method,
                    headers: {
                        'X-API-Key': adminKey,
                        Accept: 'application/json',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (err) {
                return { ok: false, error: { kind: 'server', message: NETWORK_MESSAGE } };
            }
            let data = null;
            try { data = await response.json(); } catch (err) { /* an answer with no JSON body */ }
            if (response.ok) return { ok: true, status: response.status, data };
            return { ok: false, status: response.status, error: describe(response.status, data) };
        }

        const id = (value) => encodeURIComponent(value); // a reference is data, never trusted as part of an address

        return {
            // A harmless read that only the admin key may do: 200 admin, 403 public key, 401 unknown.
            checkKey: () => call('GET', '/bookings?email=staff-check%40example.com&limit=1'),
            findBookings: ({ email, cursor }) =>
                call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
            getBooking: (reference) => call('GET', `/bookings/${id(reference)}`),
            cancelBooking: (reference) => call('DELETE', `/bookings/${id(reference)}`),
            reset: (slots) => call('POST', '/reset', { slots }),
        };
    }

    return { createStaffApi };
});