// public/app.js
//
// Wires the page to the API. All the logic that does not need a screen lives in lib.js, all the
// network calls live in api.js; this file only reads the page, calls those, and updates the page.
//
// Safety rules for this file (enforced by tests/pagefiles.test.js):
//   - text from the server or the patient is only ever set with textContent (never as markup)
//   - no network calls here, no keys other than the public key handed over by /config.js
//   - every CSS class is a fixed string in CLASS below, so the stylesheet build can see it

(function (root) {
    'use strict';

    const Lib = root.ClinicLib;
    const Api = root.ClinicApi;
    const doc = root.document;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // <classes>
    const CLASS = {
        tab: 'inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-2 text-label-md text-on-surface hover:bg-surface-container',
        tabActive: 'inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-lg border border-primary-container bg-primary-container px-4 py-2 text-label-md text-on-primary-container',
        card: 'flex flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-4',
        cardSelected: 'flex flex-col gap-3 rounded-xl border-2 border-primary bg-surface-container-low p-4',
        cardBooked: 'flex flex-col gap-3 rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-4 opacity-70',
        row: 'flex items-center justify-between gap-2',
        chipAvailable: 'inline-flex items-center rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm text-primary',
        chipBooked: 'inline-flex items-center rounded-full bg-surface-container-high px-2.5 py-0.5 text-label-sm text-on-surface-variant',
        provider: 'flex items-center gap-3',
        avatar: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-label-sm text-primary',
        providerName: 'text-title-md text-on-surface',
        timeRow: 'flex flex-wrap items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2 text-label-md text-on-surface',
        muted: 'text-body-sm text-on-surface-variant',
        icon: 'h-4 w-4 shrink-0',
        selectButton: 'min-h-[44px] rounded-lg bg-primary-container px-4 text-label-md text-on-primary-container hover:opacity-90',
        selectButtonOff: 'min-h-[44px] cursor-not-allowed rounded-lg bg-surface-container-high px-4 text-label-md text-on-surface-variant',
        messageError: 'mb-4 rounded-lg bg-error-container p-3 text-body-md text-on-error-container',
        messageInfo: 'mb-4 rounded-lg bg-surface-container p-3 text-body-md text-on-surface',
    };
    // </classes>

    // A small helper for building elements. Strings passed as children become TEXT nodes.
    function el(tag, { className, text, dataset, attrs } = {}, children = []) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        if (dataset) Object.assign(node.dataset, dataset);
        if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        for (const child of children) node.append(child);
        return node;
    }

    function icon(name) {
        const svg = doc.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', CLASS.icon);
        svg.setAttribute('aria-hidden', 'true');
        const use = doc.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.appendChild(use);
        return svg;
    }

    function defaultUuid() {
        const c = root.crypto;
        if (c && c.randomUUID) return c.randomUUID();
        const bytes = c.getRandomValues(new Uint8Array(16)); // older browsers
        return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    function start(deps) {
        const timers = deps.timers || { setTimeout: root.setTimeout.bind(root), clearTimeout: root.clearTimeout.bind(root) };
        const nowMs = () => +deps.now();
        const timeZone = deps.timeZone || new Intl.DateTimeFormat().resolvedOptions().timeZone;
        const locale = deps.locale;
        const slowAfterMs = deps.slowAfterMs || 5000;
        const makeKey = deps.uuid || defaultUuid;

        const $ = (id) => doc.getElementById(id);
        const dom = {
            configError: $('config-error'), slowNotice: $('slow-notice'), zoneNote: $('zone-note'),
            providerFilter: $('provider-filter'), tabs: $('date-tabs'), list: $('slot-list'),
            loading: $('slots-loading'), empty: $('slots-empty'), error: $('slots-error'),
            errorMessage: $('slots-error-message'), retry: $('retry-slots'),
            panel: $('booking-panel'), message: $('form-message'), noSelection: $('no-selection'),
            selected: $('selected-slot'), form: $('booking-form'), name: $('name'), email: $('email'),
            submit: $('submit'), change: $('change-slot'),
            confirmation: $('confirmation'), confirmationTitle: $('confirmation-title'), another: $('book-another'),
        };
        const show = (node, visible) => { node.hidden = !visible; };
        const field = (container, name) => container.querySelector(`[data-field="${name}"]`);

        const state = {
            slots: [], dayKey: null, provider: '', selectedId: null,
            attempt: null,          // { fp, key }: the Idempotency-Key for the current booking attempt
            submitting: false, countdownActive: false, pending: 0,
        };

        const showConfigError = () => {
            show(dom.configError, true); show(dom.loading, false); show(dom.error, false);
            show(dom.noSelection, false); show(dom.form, false);
        };

        const publicKey = root.__CONFIG__ && root.__CONFIG__.publicKey;
        if (!publicKey) {
            showConfigError();
            return { ready: Promise.resolve() };
        }
        const api = Api.createApi({ fetch: deps.fetch || root.fetch.bind(root), publicKey });

        const zone = Lib.zoneLabel(timeZone, new Date(nowMs()).toISOString(), locale);
        dom.zoneNote.textContent = `Times are shown in your time zone: ${zone === timeZone ? zone : `${zone} (${timeZone})`}.`;

        // Shows the "waking up" notice if a request takes longer than expected (a cold start).
        async function tracked(promise) {
            state.pending += 1;
            const timer = timers.setTimeout(() => show(dom.slowNotice, true), slowAfterMs);
            try {
                return await promise;
            } finally {
                timers.clearTimeout(timer);
                state.pending -= 1;
                if (state.pending === 0) show(dom.slowNotice, false);
            }
        }

        // ---- Messages beside the form ----------------------------------------------------------
        function setMessage(kind, text) {
            dom.message.dataset.kind = kind;
            dom.message.textContent = text;
            dom.message.className = kind === 'rate' ? CLASS.messageInfo : CLASS.messageError;
            show(dom.message, true);
        }
        function clearMessage() {
            delete dom.message.dataset.kind;
            dom.message.textContent = '';
            show(dom.message, false);
        }
        const setBusy = (disabled, label) => {
            dom.submit.disabled = disabled;
            dom.submit.textContent = label || 'Confirm booking';
        };

        // ---- Deriving what to show -------------------------------------------------------------
        const filteredSlots = () => (state.provider ? state.slots.filter((s) => s.provider === state.provider) : state.slots);
        const selectedSlot = () => state.slots.find((s) => s.id === state.selectedId && s.available) || null;

        function renderProviders() {
            const names = [...new Set(state.slots.map((s) => s.provider))].sort();
            if (state.provider && !names.includes(state.provider)) state.provider = '';
            dom.providerFilter.replaceChildren(
                el('option', { text: 'All providers', attrs: { value: '' } }),
                ...names.map((name) => el('option', { text: name, attrs: { value: name } })),
            );
            dom.providerFilter.value = state.provider;
        }

        function renderDays(days) {
            dom.tabs.replaceChildren(...days.map((day) => el('button', {
                className: day.key === state.dayKey ? CLASS.tabActive : CLASS.tab,
                dataset: { date: day.key },
                attrs: { type: 'button', 'aria-pressed': String(day.key === state.dayKey) },
            }, [el('span', { text: day.label }), ' ', el('span', { text: `${day.available} available` })])));
        }

        function slotCard(slot) {
            const booked = !slot.available;
            const selected = state.selectedId === slot.id;
            const time = Lib.formatTimeRange(slot.start, slot.end, timeZone, locale);
            const button = el('button', {
                className: booked ? CLASS.selectButtonOff : CLASS.selectButton,
                text: booked ? 'Unavailable' : selected ? 'Selected' : 'Select',
                dataset: { action: 'select' },
                attrs: { type: 'button', 'aria-label': `${booked ? 'Unavailable' : 'Select'}: ${time} with ${slot.provider}`, ...(booked ? { disabled: '' } : {}) },
            });
            return el('article', {
                className: booked ? CLASS.cardBooked : selected ? CLASS.cardSelected : CLASS.card,
                dataset: { slotId: slot.id, state: booked ? 'booked' : 'available', selected: selected ? 'true' : 'false' },
            }, [
                el('div', { className: CLASS.row }, [el('span', { className: booked ? CLASS.chipBooked : CLASS.chipAvailable, text: booked ? 'Booked' : 'Available' })]),
                el('div', { className: CLASS.provider }, [
                    el('span', { className: CLASS.avatar, text: Lib.initials(slot.provider), attrs: { 'aria-hidden': 'true' } }),
                    el('p', { className: CLASS.providerName, text: slot.provider, dataset: { field: 'provider' } }),
                ]),
                el('div', { className: CLASS.timeRow }, [
                    icon('clock'),
                    el('span', { text: time, dataset: { field: 'time' } }),
                    ' ', // a real space: screen readers join adjacent elements without one
                    el('span', { className: CLASS.muted, text: `${Lib.durationMinutes(slot.start, slot.end)} min` }),
                ]),
                el('div', { className: CLASS.row }, [button]),
            ]);
        }

        function renderSlots() {
            const visible = filteredSlots();
            const days = Lib.groupByDate(visible, timeZone, locale);
            const none = state.slots.length === 0;
            show(dom.empty, none);
            show(dom.tabs, !none);
            show(dom.list, !none);
            if (none) { dom.tabs.replaceChildren(); dom.list.replaceChildren(); return; }

            if (!days.some((d) => d.key === state.dayKey)) {
                state.dayKey = (days.find((d) => d.available > 0) || days[0]).key; // first day with a free slot
            }
            renderDays(days);
            const day = days.find((d) => d.key === state.dayKey);
            dom.list.replaceChildren(...day.slots.map(slotCard));
        }

        function renderSelection() {
            const slot = selectedSlot();
            show(dom.noSelection, !slot);
            show(dom.selected, !!slot);
            show(dom.form, !!slot);
            if (slot) {
                field(dom.selected, 'provider').textContent = slot.provider;
                field(dom.selected, 'when').textContent = describeWhen(slot);
            }
        }

        const describeWhen = (slot) =>
            `${Lib.longDate(slot.start, timeZone, locale)}, ${Lib.formatTimeRange(slot.start, slot.end, timeZone, locale)} ${Lib.zoneLabel(timeZone, slot.start, locale)}`;

        const renderAll = () => { renderProviders(); renderSlots(); renderSelection(); };

        // ---- Loading the list --------------------------------------------------------------------
        async function loadSlots({ initial = false } = {}) {
            if (initial) { show(dom.loading, true); show(dom.error, false); show(dom.empty, false); }
            const result = await tracked(api.listSlots());
            show(dom.loading, false);

            if (!result.ok) {
                if (result.error.kind === 'config') { showConfigError(); return; }
                if (initial || state.slots.length === 0) {
                    dom.errorMessage.textContent = result.error.message;
                    show(dom.error, true);
                }
                return; // a failed refresh keeps the list that is already on screen
            }
            show(dom.error, false);
            state.slots = Lib.visibleSlots(result.data.slots, nowMs());
            if (state.selectedId && !selectedSlot()) state.selectedId = null; // it was booked in the meantime
            renderAll();
        }

        // ---- Choosing a slot ---------------------------------------------------------------------
        function chooseSlot(id) {
            const slot = state.slots.find((s) => s.id === id);
            if (!slot || !slot.available) return;
            state.selectedId = id;
            clearMessage();
            renderSlots();
            renderSelection();
            dom.name.focus();
        }

        function clearSelection() {
            state.selectedId = null;
            state.attempt = null;
            renderSlots();
            renderSelection();
        }

        // ---- Booking -----------------------------------------------------------------------------
        function validate(name, email) {
            if (name === '') return { input: dom.name, message: 'Please enter your full name.' };
            if (!Lib.isPlausibleEmail(email)) return { input: dom.email, message: 'Please enter a valid email address.' };
            return null;
        }

        function startCountdown(seconds) {
            state.countdownActive = true;
            let remaining = seconds;
            setBusy(true);
            setMessage('rate', Lib.rateMessage(remaining));
            const tick = () => {
                remaining -= 1;
                if (remaining <= 0) {
                    state.countdownActive = false;
                    clearMessage();
                    setBusy(false);
                    return;
                }
                setMessage('rate', Lib.rateMessage(remaining));
                timers.setTimeout(tick, 1000);
            };
            timers.setTimeout(tick, 1000);
        }

        function showConfirmation(booking, slot) {
            state.attempt = null;
            state.selectedId = null;
            field(dom.confirmation, 'reference').textContent = booking.id;
            field(dom.confirmation, 'provider').textContent = slot.provider;
            field(dom.confirmation, 'when').textContent = describeWhen(slot);
            field(dom.confirmation, 'name').textContent = booking.name;
            field(dom.confirmation, 'email').textContent = booking.email;
            field(dom.confirmation, 'status').textContent = booking.status === 'confirmed' ? 'Confirmed' : booking.status;
            clearMessage();
            show(dom.panel, false);
            show(dom.confirmation, true);
            dom.confirmationTitle.focus();
            loadSlots(); // refresh in the background so the slot now shows as booked
        }

        async function onSubmit(event) {
            event.preventDefault();
            if (state.submitting || state.countdownActive) return; // one booking at a time
            const slot = selectedSlot();
            if (!slot) return;

            const name = dom.name.value.trim();
            const email = dom.email.value.trim();
            dom.name.removeAttribute('aria-invalid');
            dom.email.removeAttribute('aria-invalid');
            const problem = validate(name, email);
            if (problem) {
                problem.input.setAttribute('aria-invalid', 'true');
                setMessage('validation', problem.message);
                problem.input.focus();
                return;
            }

            // The same details are the same attempt, so a retry reuses its Idempotency-Key and can
            // never book twice. Different details are a different attempt and get a new key.
            const details = { slot_id: slot.id, name, email };
            const fingerprint = Lib.fingerprint(details);
            if (!state.attempt || state.attempt.fp !== fingerprint) state.attempt = { fp: fingerprint, key: makeKey() };

            clearMessage();
            state.submitting = true;
            setBusy(true, 'Booking\u2026');
            const result = await tracked(api.createBooking(details, state.attempt.key));
            state.submitting = false;

            if (result.ok) { setBusy(false); showConfirmation(result.data, slot); return; }

            const { kind, message, retryAfter } = result.error;
            if (kind === 'rate') {
                startCountdown(retryAfter); // the key is kept: the retry is the same attempt
                return;
            }
            setBusy(false);
            if (kind === 'taken' || kind === 'gone' || (kind === 'invalid' && /started/i.test(message))) {
                setMessage(kind, message);
                clearSelection();
                await loadSlots();
            } else if (kind === 'config') {
                showConfigError();
            } else {
                setMessage(kind, message); // validation from the server, or a failure: the form stays, the key is kept
            }
        }

        // ---- Events (no inline handlers anywhere) ------------------------------------------------
        dom.list.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action="select"]');
            if (!button || button.disabled) return;
            chooseSlot(button.closest('[data-slot-id]').dataset.slotId);
        });
        dom.tabs.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-date]');
            if (!tab) return;
            state.dayKey = tab.dataset.date;
            renderSlots();
        });
        dom.providerFilter.addEventListener('change', () => { state.provider = dom.providerFilter.value; renderSlots(); });
        dom.retry.addEventListener('click', () => loadSlots({ initial: true }));
        dom.form.addEventListener('submit', onSubmit);
        dom.change.addEventListener('click', () => { clearMessage(); clearSelection(); });
        for (const input of [dom.name, dom.email]) {
            input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
        }
        dom.another.addEventListener('click', () => {
            dom.form.reset();
            clearMessage();
            show(dom.confirmation, false);
            show(dom.panel, true);
            clearSelection();
        });

        // Sent when the page is shown again after the data may have changed (a booking cancelled, data reset).
        doc.addEventListener('clinic:refresh', () => { loadSlots(); });

        return { ready: loadSlots({ initial: true }) };
    }

    root.ClinicApp = { start };

    if (!root.__NO_AUTOSTART__) {
        const go = () => start({ now: () => new Date() });
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go);
        else go();
    }
})(window);