// public/lib.js
//
// The page's pure logic: no DOM, no network, easy to test. Time zones and locale are passed in
// (never read from the machine), so the same input always gives the same output.

(function (root, factory) {
    const lib = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = lib;
    else root.ClinicLib = lib;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const TITLES = /^(dr|dr\.|mr|mrs|ms|prof|prof\.)$/i;
    const DEFAULT_WAIT_SECONDS = 60;
    const NETWORK_MESSAGE = 'We could not reach the booking service. Check your connection and try again.';

    // --- Which slots the page shows -----------------------------------------------------------

    // A slot that has started cannot be booked (the server answers 400), so it is not offered.
    // The boundary matches the server: starting exactly now counts as started.
    const isStarted = (slot, nowMs) => Date.parse(slot.start) <= nowMs;
    const visibleSlots = (slots, nowMs) => slots.filter((slot) => !isStarted(slot, nowMs));

    // --- Dates and times, in the VIEWER's time zone -------------------------------------------

    function dateKey(iso, timeZone) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(new Date(iso));
        const part = (type) => parts.find((p) => p.type === type).value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    }

    const dayLabel = (iso, timeZone, locale) =>
        new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

    const longDate = (iso, timeZone, locale) =>
        new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));

    // Slots grouped by local calendar day, days in date order, slots in time order.
    function groupByDate(slots, timeZone, locale) {
        const days = new Map();
        for (const slot of slots) {
            const key = dateKey(slot.start, timeZone);
            if (!days.has(key)) days.set(key, { key, label: dayLabel(slot.start, timeZone, locale), slots: [] });
            days.get(key).slots.push(slot);
        }
        return [...days.values()]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map((day) => {
                const ordered = day.slots.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : 1));
                return { key: day.key, label: day.label, slots: ordered, total: ordered.length, available: ordered.filter((s) => s.available).length };
            });
    }

    function formatTimeRange(startIso, endIso, timeZone, locale) {
        const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' });
        return `${time.format(new Date(startIso))} \u2013 ${time.format(new Date(endIso))}`;
    }

    // For the staff console: a full date and time in the viewer's zone. A value that is not a date
    // is returned unchanged, so one odd record can never break the whole list.
    function formatDateTime(iso, timeZone, locale) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return String(iso);
        return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    const durationMinutes = (startIso, endIso) => Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);

    function zoneLabel(timeZone, iso, locale) {
        const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso));
        const zone = parts.find((p) => p.type === 'timeZoneName');
        return zone ? zone.value : timeZone;
    }

    // Initials for the avatar: titles are skipped ("Dr Amina Bello" -> "AB").
    function initials(name) {
        const words = String(name || '').trim().split(/\s+/).filter((w) => w && !TITLES.test(w));
        if (words.length === 0) return '?';
        if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
        return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
    }

    // --- Turning the server's answers into something a patient can act on ---------------------

    const retryAfterSeconds = (value) => {
        const seconds = Number(value);
        return Number.isInteger(seconds) && seconds >= 1 ? seconds : DEFAULT_WAIT_SECONDS;
    };

    const rateMessage = (seconds) => `Too many attempts. Please wait ${seconds} second${seconds === 1 ? '' : 's'} before trying again.`;

    // kind says what the page should DO; message says what the patient SEES.
    // A server error's own text is never shown: it can contain internal details.
    function describeError(status, body, headers) {
        const serverText = body && typeof body.error === 'string' ? body.error : '';
        switch (status) {
            case 409: return { kind: 'taken', message: 'Sorry, that time was just taken. Please choose another time.' };
            case 404: return { kind: 'gone', message: 'That appointment time is no longer available. Please choose another.' };
            case 400: return { kind: 'invalid', message: serverText || 'Please check your details and try again.' };
            case 401:
            case 403: return { kind: 'config', message: 'This page is not set up correctly. Please contact the clinic.' };
            case 429: {
                const retryAfter = retryAfterSeconds(headers && headers.get ? headers.get('retry-after') : null);
                return { kind: 'rate', retryAfter, message: rateMessage(retryAfter) };
            }
            default: return { kind: 'server', message: 'Something went wrong on our side. Please try again in a moment.' };
        }
    }

    // --- Checking the form, and knowing when a retry is the SAME request ----------------------

    // Only a hint for the patient. The server is the authority on what a valid email is.
    const isPlausibleEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

    // The same details (however they are typed) are the same booking attempt, so a retry can reuse
    // its Idempotency-Key; different details are a different attempt and need a new key.
    const fingerprint = ({ slot_id, name, email }) =>
        [slot_id, String(name || '').trim(), String(email || '').trim().toLowerCase()].join('\u0000');

    return {
        isStarted, visibleSlots, groupByDate, formatTimeRange, formatDateTime, durationMinutes, zoneLabel, longDate,
        initials, retryAfterSeconds, rateMessage, describeError, isPlausibleEmail, fingerprint, NETWORK_MESSAGE,
    };
});