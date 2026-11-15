# Design decisions
 
This is the "why" behind the code. Each entry follows the same short pattern, so a reviewer can scan it in a minute:
 
- **Context:** the problem or pressure that forced a choice.
- **Decision:** what I chose, in one or two sentences.
- **Consequences:** what I gained, and what it costs me.
- **Evidence:** the test or experiment that shows it works.
Entries are numbered in the order I made them. A decision is never deleted: if I change my mind, I add a new entry that supersedes the old one, so the history stays honest.
 
| # | Decision | Status |
|---|---|---|
| 1 | One Express service, Postgres, raw SQL | Accepted |
| 2 | Inject `pool`, `clock` and `apiKey` into `createApp` | Accepted |
| 3 | API-key auth runs before the body parser, compared in constant time | Accepted |
| 4 | One error shape; 5xx messages are hidden | Accepted |
| 5 | Structured logs with request ids, redaction and no query strings | Accepted |
| 6 | `/health` is public, quiet in the logs, and reports database failure as 503 | Accepted |
| 7 | Listen for `error` on the connection pool | Accepted |
| 8 | Unfinished handlers answer 501 | Accepted |
| 9 | `withTransaction` helper; resets are serialised with an advisory lock | Accepted |
| 10 | Slot availability is derived, never stored | Accepted |
| 11 | Dates are returned in UTC, in the spec's format | Accepted |
| 12 | The database prevents double booking (partial unique index) | Accepted |
| 13 | Idempotency keys stored with a request fingerprint | Proposed |
| 14 | Rate limiting kept in Postgres | Proposed |
| 15 | Booking input is validated first; fixed order of checks | Accepted |
| 16 | Deployment: migrate by hand, smoke test, keep-alive, connection timeout | Accepted |
 | 17 | Cursor ("keyset") pagination on a sequence number | Accepted |
 | 18 | Two API keys with roles; the page carries a low-privilege key | Accepted |
 | 19 | The booking page: plain HTML, CSS and JavaScript, rebuilt from the design | Accepted |
| 20 | Testing the page in three layers | Accepted |
---
 
## 1. One Express service, Postgres, raw SQL
 
**Context.** The assessment is graded on correctness under concurrent requests: no double booking, safe retries, a rate limit that holds when requests arrive together.
 
**Decision.** A single Express service talking to one Postgres database through the `pg` driver, with plain SQL. No ORM, no microservices.
 
**Consequences.** Every guarantee depends on explicit transactions, constraints and locks, and an ORM tends to hide exactly those. The cost is writing SQL by hand. Matching the size of the design to the size of the problem is deliberate: this is a small API, and extra moving parts would be things I'd have to explain and secure for no benefit.
 
**Evidence.** The concurrency tests (milestones 3 to 5) run against a real Postgres, in CI and locally.
 
## 2. Inject `pool`, `clock` and `apiKey` into `createApp`
 
**Context.** Several rules depend on time ("the slot has already started", "5 attempts per minute"). Testing them by waiting would be slow and flaky. Importing a global database connection would also make it easy to point a test at the wrong database.
 
**Decision.** `createApp({ pool, clock, apiKey })` receives its dependencies. Routers and controllers are factories that take `{ pool, clock }`. Only `server.js` builds the real pool and a real clock, and only `app.js` knows nothing about listening on a port.
 
**Consequences.** A test can pass a fixed clock and a test database, and use the app without opening a port. `tests/helpers.js` refuses to run if the test and dev database URLs are the same, because `/reset` deletes everything. The cost is a little wiring code.
 
**Evidence.** `tests/helpers.js`; the health tests run the app with a fake pool that fails on demand.
 
## 3. API-key auth runs before the body parser, compared in constant time
 
**Context.** The spec requires an `X-API-Key` header on every request and says a missing or wrong key returns 401.
 
**Decision.**
- The key check is mounted before `express.json()`, so a caller without a valid key never makes the server parse their body, and gets 401 even if their body is broken.
- Both the provided and the expected key are hashed with SHA-256, then compared with `crypto.timingSafeEqual`. `timingSafeEqual` throws on inputs of different lengths; hashing gives two 32-byte values every time.
- There are no user accounts, sessions or login. The key identifies the calling application, not a person. Patients are identified only by the email on a booking.
**Consequences.** Simple and exactly what the spec asks for. Known limits, also listed in the README: the web page has to carry the key, so anyone who opens the page's code can read it; and anyone with the key can call `/reset`. A real system would add per-user authentication and authorisation.
 
**Evidence.** `tests/auth.test.js` covers every route with no key, an empty key and a wrong key, plus a wrong key of the *same length* as the real one (a check that compared only lengths would pass the other tests), plus a broken body with no key returning 401, not 400.
 
## 4. One error shape; 5xx messages are hidden
 
**Context.** The spec says every error looks like `{"error": "<message>"}`. Express's defaults (an HTML page for a bad URL or broken JSON) would break that.
 
**Decision.** A single error-handling middleware produces every error response.
- It reads the status from `err.statusCode` or `err.status` and trusts it only if it is an integer from 400 to 599; otherwise it uses 500.
- **4xx:** the message is written for the caller to act on, so it is shown. Known parser errors (malformed JSON, body too large) get fixed wording, because the parser's own message can quote what the client sent.
- **5xx:** the caller gets `internal server error`. The real error is logged with the request id.
- It never modifies the error object, and it hands off to Express if a response has already started.
**Consequences.** Callers never see SQL, hostnames or stack details. Debugging relies on the logs and the request id.
 
**Evidence.** `tests/error.test.js`: HTTP-level tests for 404, malformed JSON and an oversized body, and unit tests for out-of-range statuses, a non-numeric status, 503 not leaking its message, and not mutating the error.
 
## 5. Structured logs with request ids, redaction and no query strings
 
**Context.** I need to trace a request through the logs, but logs are read by more people and tools than the database is.
 
**Decision.** pino-http as the first middleware, so even 401s and 404s are logged.
- Each request has an id, taken from `X-Request-Id` only if it is short and made of safe characters, otherwise generated. It is echoed back as a response header.
- The API key, authorization and cookie headers are redacted.
- Query strings are never logged. `GET /bookings?email=...` would otherwise write a patient's email into the logs (I confirmed this by running the app).
- Level follows the status: 5xx error, 4xx warn, everything else info. Silent under `NODE_ENV=test`.
**Consequences.** Useful logs without secrets or personal data. Fewer details in the logs is a deliberate cost.
 
**Evidence.** I ran the app and read the log lines: the key shows as `[Redacted]`, and a request with an email in the query string leaves no email in the output.
 
## 6. `/health` is public, quiet in the logs, and reports database failure as 503
 
**Context.** Hosting platforms and keep-alive pings call a health endpoint often, and they don't hold the API key. Cold starts of the host and the database are the main deployment risk.
 
**Decision.** `GET /health` needs no key, runs `SELECT 1`, and returns 200. If the database is unreachable it returns 503 with `{"error": "database unavailable"}`; the real error is logged. Successful health checks are not logged, so pings don't bury real traffic.
 
**Consequences.** A single URL both wakes the database and proves it is reachable. It exposes nothing beyond "ok" or "database unavailable".
 
**Evidence.** `tests/health.test.js` uses a fake pool that succeeds or rejects.
 
## 7. Listen for `error` on the connection pool
 
**Context.** A database connection can die while it sits idle in the pool (a restart, or a serverless database closing idle connections). The pool then emits an `error` event. In Node, an `error` event with no listener throws and ends the process.
 
**Decision.** `pool.on('error', ...)` logs the message and carries on. The pool discards the dead connection and opens a new one on demand.
 
**Consequences.** A dropped idle connection no longer takes the service down. This is not a catch-all for errors; request errors still go through the error handler.
 
**Evidence.** I terminated the database's connections under a running server: the process stayed up and `/health` still returned 200 on the next call.
 
## 8. Unfinished handlers answer 501
 
**Context.** A handler that never sends a response leaves the request open until the 30-second test timeout, which makes a missing feature look like a mysterious hang.
 
**Decision.** Stubs answer `501` with `{"error": "not implemented"}` until the real handler replaces them.
 
**Consequences.** Red tests fail in milliseconds with a clear reason, and the error shape stays consistent even for unfinished routes.
 
**Evidence.** Calling every route with a valid key returned 501 in single-digit milliseconds.
 
## 9. `withTransaction` helper; resets are serialised with an advisory lock
 
**Context.** `/reset` changes three things (bookings, slots, new slots) and must be all-or-nothing. A connection pool gives each query to *any* free connection, so `BEGIN`, the statements and `COMMIT` have to share one connection to be a real transaction. Two resets running at the same moment can also both try to insert the same slot id.
 
**Decision.**
- `withTransaction(pool, fn)` takes one client, runs `BEGIN`, calls `fn`, then `COMMIT`. On any error it rolls back and rethrows the original error, and it always releases the client.
- `/reset` takes a transaction-scoped advisory lock first, so overlapping resets take turns. The lock is released automatically when the transaction ends.
- The new slots go in with one `INSERT ... SELECT FROM unnest(...)`, whatever their number.
- The body is validated with Zod *before* any database work, so a bad request changes nothing.
**Consequences.** Atomic, and safe under simultaneous resets. The cost is that resets queue behind one another, which is the point.
 
**Evidence.** `tests/transaction.test.js` (rollback, rollback after a database error, and no leaked connections through a pool of two). In `tests/reset.test.js`, 10 simultaneous resets all succeed. With the lock line removed, that test failed in 8 of 8 runs; with it, 0 of 15.
 
## 10. Slot availability is derived, never stored
 
**Context.** A slot is bookable unless someone has a confirmed booking on it. Storing an `available` flag would create two sources of truth that could disagree.
 
**Decision.** `available` is computed in the query with `NOT EXISTS` over *confirmed* bookings.
 
**Consequences.** Cancelling a booking frees the slot with no extra bookkeeping.
 
**Evidence.** `tests/slots.test.js`: a confirmed booking makes the slot unavailable, a cancelled one does not. Removing the `status = 'confirmed'` condition makes the cancelled-booking test fail.
 
## 11. Dates are returned in UTC, in the spec's format
 
**Context.** Postgres returns JavaScript dates, which serialise as `2026-12-10T09:00:00.000Z`. The spec's examples are `2026-12-10T09:00:00Z`, and a checker might compare strings.
 
**Decision.** Instants are stored as `timestamptz` and returned in UTC. Whole seconds are written without `.000`; non-zero fractions are kept. Inputs with offsets (such as `+01:00`) are accepted.
 
**Consequences.** Matches the spec's examples exactly. A caller who sent an offset gets the same instant back in UTC, not their original text.
 
**Evidence.** `tests/slots.test.js` checks an exact string, a fractional-second case and an offset case.
 
 ## 15. Booking input is validated first; fixed order of checks

**Context.** A booking request can be wrong in several ways at once: a bad key, broken JSON, invalid details, a slot that doesn't exist, a slot that has already started. If the order isn't fixed, the same request can get different answers, and callers can learn things they shouldn't.

**Decision.** Checks run in this order, and the first failure wins:
1. API key: 401
2. Malformed JSON or oversized body: 400 or 413
3. Rate limit, only when the body has a usable email: 429
4. Idempotency-Key header format: 400
5. If a key was seen: replay the saved answer, or 422 for a different body
6. Body validation: 400
7. The slot exists: 404
8. The slot has not started: 400
9. Insert: 201, or 409 if the slot is taken

Details:
- `name` and `email` are trimmed, and `email` is lower-cased before its format is checked, as the spec requires. Lengths are capped (name 200, email 254).
- `slot_id` is an identifier, so it is not trimmed or changed, because the id sent to `/reset` must work here. A value that is only spaces is rejected as blank.
- A slot whose `start` is at or before the current time counts as started.
- The clock is read once per request, so "has it started?" and `created_at` use the same instant. `created_at` comes from the injected clock.
- Unknown fields in the body are dropped. A caller cannot choose the `id`, the `status` or `created_at`.
- Rows are mapped to the response through one serializer that names each field, so internal columns such as `seq` can't leak.

**Consequences.** Predictable answers, cheap rejection of bad input, and no way to inject server-controlled fields. Known gap, on purpose: until Level 3 (milestone 4) nothing stops two bookings on the same slot. The test for it is written as `test.todo`, and the database rule that fixes it arrives together with the failing concurrency test that justifies it.

**Evidence.** `tests/bookings.test.js` uses a fixed clock. I broke the code on purpose in 13 ways, and each was caught: removing the started check, `<=` becoming `<` (the exactly-now boundary), no lower-casing, no trimming (email and name), `created_at` ignoring the clock, a leaked extra field, a caller-chosen id, no validation, a missing slot not handled, an unknown booking returning 200, a blank slot id allowed, and checking the slot before validating.
---
 
## 12. The database prevents double booking (partial unique index)

**Context.** Checking "is the slot free?" and then inserting leaves a gap in which two simultaneous requests can both pass the check. I measured it: with a check-then-insert version and no index, 20 simultaneous requests for one slot produced 20 "winners" in 4 of 5 runs.

**Decision.**
- A partial unique index, `UNIQUE (slot_id) WHERE status = 'confirmed'`. Cancelled bookings don't count, so cancelling frees the slot with no extra bookkeeping.
- The insert uses `ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING`. If a confirmed booking already holds the slot, no row comes back and the caller gets 409. Because that is a normal result and not a database error, the transaction is never aborted.
- Cancelling is one atomic statement, `UPDATE ... WHERE id = $1 AND status = 'confirmed'`. If nothing is updated, a second query decides between 404 (no such booking) and 409 (already cancelled). Ten simultaneous cancels of one booking give one 200 and nine 409.
- If `/reset` deletes the slot between "does it exist?" and the insert, the foreign key rejects the insert (code `23503`), and the caller gets 404, not a crash.

**Consequences.** The guarantee holds however many requests collide, and no application code can forget it. The cost is that the migration must have run on every database the code touches: without the index, `ON CONFLICT` fails and every booking returns 500.

**Evidence.** `tests/concurrency.test.js` fires 20 parallel bookings of one slot and expects exactly one 201 and nineteen 409. Run 20 times with no failure. I broke it on purpose: check-then-insert without the index, check-then-insert with the index but unhandled, and the correct code with the index missing. All three failed the concurrency test.
 
## 13. Idempotency keys stored with a request fingerprint

**Context.** A retried request must not create a second booking, and reusing a key for a different request must be refused. Two retries can also arrive at the same moment.

**Decision.** `idempotency_keys` stores, per key, a SHA-256 fingerprint of the request body (object keys sorted, so key order doesn't matter), the status code and the response.
- Everything for a keyed request happens in one transaction that first takes an advisory lock on the key: look up the key, then either replay the saved answer (same fingerprint), answer 422 (different fingerprint), or do the work and save the answer.
- The booking attempt *returns* its outcome (201, 404, 400 started, 409) instead of throwing, which is what makes it possible to save refusals too. A replay returns the original answer even if the slot has since changed hands, and is marked `Idempotent-Replayed: true`.
- Not remembered: validation failures (the key can be reused with a corrected body), and 429 and 500 responses.
- The key lookup comes before body validation, so a different body is always 422, valid or not.
- A key must be 1 to 255 characters. `/reset` forgets every key.

**Consequences.** Retries are safe under simultaneous requests. Costs: keys are global (not per caller) and never expire except through `/reset`; a retry is replayed even if the world has changed, which is the definition of "the same response".

**Evidence.** `tests/idempotency.test.js`. The simultaneous-retry test slows the key lookup on purpose so the requests overlap every time; with the lock removed it fails in 5 of 5 runs. Without that trick the race never fired locally, because rate limiting spaces requests a few milliseconds apart.
 
## 14. Rate limiting kept in Postgres

**Context.** At most 5 booking attempts per email per minute, failed attempts included, holding under simultaneous requests.

**Decision.** A sliding window in `booking_attempts`, counted under an advisory lock on the normalised email.
- The email is normalised exactly as booking validation does (trim, lower-case). With no usable email there is nobody to limit, and the request is just a 400.
- The limiter runs before validation and before the idempotency lookup, so invalid, refused and replayed requests all count.
- A blocked request is not recorded, so it cannot extend its own block.
- `Retry-After` is the seconds until the oldest attempt in the window leaves it, rounded up, never 0.
- Timestamps come from the injected clock, so tests move time instead of waiting.
- `/reset` clears the counters.

**Consequences.** Shared by every instance and safe across restarts. Costs: a few extra database round trips per booking attempt, and an email's old rows are pruned only when that email attempts again.

**Evidence.** `tests/ratelimit.test.js`: 10 simultaneous requests for one email give exactly 5 processed and 5 rejected; the minute boundary is tested at 59.999 s and at 60 s.
## 16. Deployment: migrate by hand, smoke test, keep-alive, connection timeout

**Context.** The first request after a quiet period is the main deployment risk. A free Render service sleeps after 15 minutes without traffic and takes up to about a minute to wake. A free Neon compute sleeps after 5 minutes and wakes in a few hundred milliseconds.

**Decision.**
- Migrations are run by hand with `npm run migrate:prod`, which reads `DATABASE_URL_PROD`. That is a different variable from `DATABASE_URL`, so a migration can't hit the wrong database by accident. (`node-pg-migrate` is a dev dependency, and Render doesn't install those when `NODE_ENV=production`.)
- `scripts/smoke.js` runs the full user journey against a running service and exits non-zero on any failure. It is the check I run after every deploy.
- A scheduled GitHub Actions workflow pings `/health` every 10 minutes during grading.
- The connection pool times out after 10 seconds, so an unreachable database becomes a quick 503 from `/health` instead of a hang.

**Consequences.** Cheap to run and easy to explain. Costs: keeping the services awake uses free-tier hours (Render's 750 are shared across the workspace; Neon's compute budget is 100 compute-unit hours per project), so the ping is turned off once grading ends.

**Evidence.** The smoke test passes against the real server, and fails with the right exit code on a wrong key, an unreachable service and missing configuration. `migrate:prod` applied both migrations to an empty database. I could not test the 10-second timeout itself, because my test environment rejected the unreachable address immediately; the 503 behaviour was verified.
## 17. Cursor ("keyset") pagination on a sequence number

**Context.** `GET /bookings` lists a person's bookings oldest first. With offset paging, a booking created between two page requests shifts every later row, so rows are skipped or repeated.

**Decision.** The cursor is the `seq` of the last booking on the page, base64url-encoded. The next page is `seq > cursor`, ordered by `seq`, fetching `limit + 1` rows: an extra row means another page exists, so the last page is correctly `null` even when it is exactly full. Cursors are validated strictly (canonical encoding, a positive whole number) and anything else is a 400. `limit` is 1 to 50 (default 10). Cancelled bookings are included. An index on `(lower(email), seq)` serves the query.

**Consequences.** Stable under concurrent inserts and fast at any size. A cursor isn't tied to an email, which leaks nothing, because a caller only ever receives bookings for the email they ask about.

**Evidence.** `tests/pagination.test.js` walks 25 bookings at limits 7, 10 and 5 (the exactly-full case), creates a booking between pages, and rejects nine kinds of bad cursor.
## 18. Two API keys with roles; the page carries a low-privilege key

**Context.** The web page has to call the API, but anything a browser can send, a person with developer tools can send too. If the page carried the key the graders use, anyone who opened it could call `/reset` and wipe the data. A browser cannot keep a secret.

**Decision.** Separate privileges, not secrets:
- **Admin key** (`API_KEY`): everything. This is the key submitted to the assessment. It lives only in the host's environment and the submission form, never in a file the browser loads or in git.
- **Public key** (`PUBLIC_API_KEY`): only what the page needs, which is listing slots and booking a slot. It is handed to the page by `GET /config.js`, read from the environment, so it is not committed either.
- A valid key that isn't allowed to do something gets **403**. A missing or wrong key is **401**, as the spec says. The admin-only guard runs before the route's own logic, so a public key gets the same 403 whether or not a booking exists, and can't probe for bookings.
- Admin only: `POST /reset`, `GET /bookings` (it returns personal data for any email), `GET /bookings/{id}`, `DELETE /bookings/{id}`.
- Both keys are compared in constant time, and both comparisons always run, so timing doesn't hint at which key matched.
- The page and `/config.js` are served **before** the key check, because a browser has no key when it first asks for the page.
- Security headers on every response: a Content Security Policy that allows only the site's own scripts, styles, fonts and connections, no framing, `nosniff`, and no referrer.
- Startup checks: a missing admin key or database URL stops the server, and so does a public key equal to the admin key (the page would receive the admin key). A missing public key is only a **warning**, so a working deployment is never taken down by a new setting.

**Consequences.** A leaked public key can only do what any visitor already can. Costs and limits, also in the README: someone with the public key can still book slots or fill them with fake emails, because the rate limit is per email (a per-IP limit would need correct proxy settings on the host); and the public key can't be changed after submission without a redeploy.

**Evidence.** `tests/roles.test.js` checks every route against the admin key, the public key and no key (18 cases), that the public key can complete a booking, and that it cannot wipe the data. `tests/site.test.js` checks that `/config.js` never contains the admin key, that the page is open while the API is not, that dotfiles and parent paths are never served, and the headers. I broke the code in 18 ways, and each was caught, including promoting the public key to admin, leaking the admin key through `/config.js`, serving the page after the key check, serving the whole project folder, weakening the policy with `unsafe-inline`, and making a missing public key a fatal error.
## 19. The booking page: plain HTML, CSS and JavaScript, rebuilt from the design

**Context.** The assessment asks for a simple page to see available slots, book one and see the confirmation. I generated designs with Stitch. Both exports loaded Tailwind and fonts from other sites and used inline `onclick` handlers and `<script>` blocks, which the Content Security Policy (decision 18) forbids. They also showed things this system does not do.

**Decision.**
- **No framework.** Plain HTML, one compiled stylesheet and three small scripts, served by the same Express service. There is no build step on the host (the compiled CSS is committed), no second deployment, no CORS, and about 700 lines to explain. A framework would add a build step on Render for no gain at this size.
- **Rebuilt from the blue design, not copied.** The Tailwind config is generated from the design's own colours, radii and type scale, so the page matches it. Inter is served from `public/fonts` and the icons are an inline SVG sprite.
- **Three scripts with one job each.** `lib.js` is pure logic (grouping slots by local day, formatting, turning server answers into messages). `api.js` is the only code that touches the network, and it can do exactly two things: list slots and create a booking. `app.js` reads and updates the page.
- **Text is always set with `textContent`,** never as markup, because names and provider names come from users.
- **Honest content only.** I removed everything the system cannot do: "My Bookings" and "Find a Booking" (listing by email would expose patients' appointments), "calendar invite" and "emailed to you" (nothing sends email), rescheduling, encryption claims, specialties, photos, "Live" and "Verified" badges, and hard-coded time zones. Times are shown in the viewer's own zone, and slots that have started are hidden because booking them returns 400.
- **Safe retries.** Each booking attempt gets an `Idempotency-Key`. Retrying the same details reuses it; changing the details makes a new one. The page never books twice.

**Consequences.** Small, predictable and easy to explain. The page cannot look a booking up later, so the confirmation tells the patient to keep their reference.

**Evidence.** 36 behaviour tests, 35 logic tests and the file-rule tests. I broke the page in 22 ways and each is caught. Two were missed at first and are now closed (see the learning log).

## 20. Testing the page in three layers

**Context.** A page can be correct in code and still look wrong or break under a real browser's rules.

**Decision.**
1. **Pure logic** (`lib.test.js`): no screen, no network. Time zones are passed in, so results never depend on the machine.
2. **Behaviour** (`page.test.js`): the real page runs in a simulated browser (jsdom) against the real server. It checks what the page sends (which key, which `Idempotency-Key`), what it shows, and what it refuses to do (never `/reset`, never the admin key).
3. **Rules the policy enforces** (`pagefiles.test.js`): no inline script or style, nothing from another site, no HTML written from data, no secrets, and the compiled stylesheet is up to date and contains every class the page uses.
- Separately, I ran the page once in a **real headless browser**: no console errors, no policy violations, every request to this site, the font loaded locally, and I looked at desktop and phone screenshots.

**Consequences.** jsdom proves behaviour but draws nothing, so it cannot prove how the page looks. Only the real-browser run and a human look can. Visual correctness is checked by eye before submission.

**Evidence.** The real-browser run found one flaw the tests could not: the note read "UTC (UTC)". It is fixed and now has a test.