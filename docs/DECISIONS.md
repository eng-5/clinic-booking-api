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
| 12 | The database prevents double booking (partial unique index) | Proposed |
| 13 | Idempotency keys stored with a request fingerprint | Proposed |
| 14 | Rate limiting kept in Postgres | Proposed |
 
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
 
---
 
## 12. The database prevents double booking (proposed, milestone 4)
 
**Context.** Checking "is the slot free?" and then inserting leaves a gap in which two simultaneous requests can both pass the check.
 
**Proposed decision.** A partial unique index, `UNIQUE (slot_id) WHERE status = 'confirmed'`, with `INSERT ... ON CONFLICT DO NOTHING` so a conflict returns no row and becomes a 409. Cancelling sets `status = 'cancelled'`, which frees the slot automatically.
 
**To confirm with evidence.** 20 parallel booking requests for one slot produce exactly one 201 and nineteen 409s, repeated about 20 times without a flake.
 
## 13. Idempotency keys stored with a request fingerprint (proposed, milestone 6)
 
**Context.** A retried request must not create a second booking. The same key with a different body must be rejected.
 
**Proposed decision.** Store the key, a hash of the key-sorted request body, and the response, in the same transaction as the booking, under an advisory lock on the key so simultaneous retries line up. Do not rely on catching a unique-violation error inside that transaction: after a failed statement, Postgres aborts the transaction and nothing else can run in it, including saving the key.
 
**To confirm with evidence.** Ten parallel requests with one key create one booking and return identical responses; the same key with a different body returns 422.
 
## 14. Rate limiting kept in Postgres (proposed, milestone 7)
 
**Context.** At most 5 booking attempts per email per minute, failed attempts included, and it must hold under simultaneous requests.
 
**Proposed decision.** An attempts table in Postgres, counted under an advisory lock on the normalised email, with timestamps taken from the injected clock. Rejected attempts are not recorded, so the window can't be extended forever. In-memory counting would reset on restart.
 
**To confirm with evidence.** Ten parallel requests for one email give exactly five allowed and five 429s with a correct `Retry-After`.