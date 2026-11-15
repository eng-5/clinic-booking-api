# Learning log
 
A record of what I built, what went wrong, and what I learned, written after each milestone. I keep my first understanding next to the corrected one on purpose: the useful part is seeing how my thinking changed, so I don't edit mistakes out.
 
**Each entry uses the same pattern:**
 
- **Built:** what now exists.
- **Went wrong:** the symptom I saw, the real cause, the fix, and the lesson.
- **Concept check:** questions I answer without looking at the code, then correct.
- **Evidence:** how I know it works, including experiments I can rerun.
For the reasoning behind each design choice, see [DECISIONS.md](DECISIONS.md). For how I used AI along the way, see [AI-NOTES.md](AI-NOTES.md).
 
---
 
## Milestone 1: foundations (auth, errors, logging, health, CI)
 
### Built
 
Express app factory with injected dependencies, API-key middleware with a constant-time comparison, one error handler that always returns `{"error": ...}`, pino request logging with redaction, a `/health` endpoint that checks the database, 501 stubs for unfinished routes, and a GitHub Actions workflow that migrates a throwaway Postgres and runs the tests.
 
### Went wrong, and how I found it
 
| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| `npm run migrate:dev` printed help text and never migrated | The `dotenv` command on my machine was not the `dotenv-cli` my script assumed (first a different tool, later the `dotenv` package's own CLI, which has different syntax) | Load `.env` with `node -r dotenv/config` and run `node-pg-migrate` directly | A tool's name is not its identity. Check what the command really resolves to before debugging my own config. |
| A test I broke on purpose reported `Received: 500`, not the status I set | `res.status(1000)` throws, because 1000 is not a valid HTTP status. The error handler then used its fallback, 500 | The error handler only trusts integer statuses from 400 to 599 | Errors can happen inside the error path too. The handler must be the most defensive code in the app. |
| Jest warned that it "did not exit one second after the tests" | A request was not awaited, and a database pool stayed open | `await` every request; close the pool in `afterAll` | An un-awaited promise in a test looks like a pass until something is still running. |
| A test read `res.statusCode` and got `undefined` | I did not `await` the supertest request before asserting | `await request(app).get(...)` on the same line | The assertion ran before the response existed. |
| Found in review: `app.use('/*')`, a `moodule.exports` typo, and `clock: new Date()` | Express 5 rejects `'/*'`; the typo throws on load; a `Date` object is not a function | `app.use(handler)` with no path; fix the typo; `clock: () => new Date()` | A scaffold can look fine and still not start. Run it early and often. |
| Logs contained patients' emails | pino-http logs `url` and `query` by default, and `GET /bookings?email=...` carries an email | A request serializer that drops the query string | I only found this by running the app and reading the output. Reading the config would not have shown it. |
| Requests to unfinished routes hung for 30 seconds | An empty handler never sends a response | Stubs answer 501 | A missing feature should fail loudly and fast. |
 
### Concept check (8 questions, answered without looking at the code)
 
**1. Why does the key check run before the JSON parser?**
Two reasons. First, a caller without a valid key should not make the server spend effort parsing their body. Second, a request with no key and a broken body must get 401, not 400, so unauthenticated callers learn nothing about how the API validates input. The test "a broken body with no key is rejected with 401, not 400" proves the order.
*Correction:* my first answer only said that "only authorised users get through". That is true of the key check in general, but it doesn't explain why its position matters.
 
**2. Why pass `pool` and `clock` into `createApp` instead of importing them?**
So the code is testable. A test passes a test database and a fixed clock, which makes "the slot has already started" testable without waiting, and nothing hides in a global. It is also why the test helper can refuse to run against the dev database.
*Correction:* my first answer explained why I use `pg` instead of an ORM. That is a separate decision. Injection is about testability, not about which database library I picked.
 
**3. Why does `/health` skip auth and request logging, and what does it return when the database is down?**
Hosting platforms and keep-alive pings call it often and don't hold the API key, and logging every successful check would bury real traffic. When the database is unreachable it returns **503 with `{"error": "database unavailable"}`** and logs the real error.
*Correction:* my first answer left out the 503 behaviour, which is the part that makes the endpoint useful.
 
**4. Why strip the query string from logs?**
Logs are read by more people and tools than the database is, including staff, log services and backups. `GET /bookings?email=...` would put a patient's email in all of them, and personal data should not leak into places that aren't protected like the database. I confirmed the leak by running the app, then confirmed the fix.
 
**5. What does `pool.on('error')` prevent, and when would it fire?**
A connection can die while it sits idle in the pool, for example when the database restarts or a serverless database closes idle connections. The pool then emits an `error` event, and in Node an `error` event with no listener throws and ends the process. The listener logs the problem and keeps the service alive; the pool replaces the dead connection when needed.
*Correction:* I first described it as a general "last fallback for unhandled errors". It isn't. Request errors go through the Express error handler. This listener covers one specific case: an idle pooled connection that dies.
 
**6. Why does the same-length wrong-key test exist, and what bug would pass without it?**
My other wrong-key tests use a key of a different length. A check that compared only the length (or only a prefix) would pass all of them. A wrong key of the same length forces a real comparison. Hashing both keys first is what lets `timingSafeEqual` handle inputs of any length, since both digests are 32 bytes.
*Evidence:* with a deliberately broken, length-only check, exactly this one test failed and the rest still passed.
 
**7. Why do unfinished handlers answer 501 and not nothing?**
A handler that never responds leaves the request open until the 30-second test timeout, so a missing feature looks like a mysterious hang. A 501 with the standard error shape fails in milliseconds with a clear reason.
 
**8. Why hide 5xx messages but not 4xx?**
4xx errors are the caller's mistake, and the message is written so they can fix it ("slot not found"). 5xx errors are my fault, and their messages can contain SQL, hostnames or stack details that help an attacker and mean nothing to the caller. The real error is logged with the request id. For malformed JSON I use fixed wording, because the parser's own message can echo what the client sent.
*Correction:* my first answer said the caller "needs to know" about 4xx. The sharper reason is whose fault it is, and so who can act on the message.
 
### Evidence
 
- All tests pass from a fresh clone against an empty database (the same steps CI runs).
- The key stays `[Redacted]` in the logs, and a query-string email does not appear.
- With the database's connections terminated under a running server, the process stays up.
---
 
## Milestone 2: reset and slots
 
### Built
 
`POST /reset` (validated with Zod, one transaction, resets take turns), `GET /slots` (sorted, exact provider filter, derived availability), and a reusable `withTransaction` helper.
 
### Went wrong, and how I found it
 
| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| A new test passed while the feature did not exist | "Running it twice gives the same state" compared two identical 501 responses | Also assert the actual content of the first result | A test that cannot fail proves nothing. I check that a new test is red *for the right reason* before writing code. |
| A broken version of the code made the test run hang instead of fail | Not releasing a connection exhausts the pool, and later tests wait forever | Keep the pool-leak test, which uses a pool of two so a leak shows up quickly | Some failures look like hangs. A tiny pool makes them visible. |
| Four tests failed on my machine with `SASL: client password must be a string` | One test file read `process.env.DATABASE_URL_TEST` without loading `.env`, so the URL was `undefined`. It passed in the AI's environment, where the variables had been exported by hand | Load dotenv, ideally through the shared test helper, which also refuses the dev database | A test that passes where it was written can still fail where it is used. Run in the same environment the user has, and route every test through one helper. |
| Removing the provider filter produced 15 failures | The change broke the SQL itself, so it didn't prove the filter test works | Try a subtler change: make the match case-insensitive. The exact-match test failed, as it should | A crude broken version can pass for the wrong reason. Mutations should be precise. |
 
### Concept check
 
**Why use one transaction for `/reset`?** If the process fails halfway, it must not leave bookings deleted and slots half-replaced. All three steps succeed together or none do.
 
**Why does the helper take a client from the pool instead of calling `pool.query` for each step?** A pool can run each query on a different connection, so `BEGIN`, the statements and `COMMIT` might not belong to the same transaction at all. One client is one connection for the whole transaction.
 
**Why an advisory lock in `/reset`?** Two overlapping resets can both try to insert the same slot id, and one would fail with a primary-key error. The lock makes them take turns, and it releases automatically when the transaction ends.
 
**Why does every test file get its database URL from one helper?** The helper loads `.env` and refuses to run against the dev database. A test file that reads the variable itself can skip both, and the tests delete rows.
 
**Why is `available` derived?** Storing it would create a second source of truth that could disagree with the bookings table.
 
### Evidence, and how to rerun it
 
A green suite only matters if it goes red when the code is wrong, so I break the code on purpose and check that a test notices. Each of these should fail a test, and I put the code back afterwards.
 
- Remove `ORDER BY` in `slotsController.js`: the ordering tests fail.
- Remove `AND b.status = 'confirmed'`: the cancelled-booking test fails.
- Change `s.provider = $1` to `s.provider ILIKE $1`: the exact-match test fails.
- Remove the `ROLLBACK` call in `transaction.js`: the rollback tests fail.
- Remove `client.release(...)`: the pool-leak test hangs and fails.
The concurrency check for the advisory lock is a race, so I run it several times. Comment out the lock line in `resetController.js`, then run this in PowerShell (adjust for your shell):
 
```powershell
1..8 | ForEach-Object { npx cross-env NODE_ENV=test jest --runInBand tests/reset.test.js -t "10 simultaneous resets" }
```
 
Without the lock, that test failed in 8 of 8 runs for me; with the lock restored it failed in 0 of 15.
 
**Experiments I ran myself** (tick when done, so this log only claims what I have done):
 
- [ ] Ran the tests before adding the implementation and saw them fail with `501`
- [ ] Made each breakage above and saw a test fail
- [ ] Ran the lock experiment with and without the lock
- [ ] Rewrote the concept-check answers above in my own words
---
 
## Milestone 3: booking, lookup and Level 2 validation

### Built

`POST /bookings` (validated with Zod, trimmed and lower-cased input, slot existence and started checks against an injected clock), `GET /bookings/:id`, a row serializer, and 60 new tests.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| A new test passed while the feature did not exist yet ("every rejected request creates no booking") | A stub creates no bookings either, so "no rows" was true for the wrong reason | The test also asserts the status of each rejected request (400, 400, 404, 400) | "Nothing happened" is not evidence that the right thing was refused. Assert the refusal as well. |
| The spec says to trim `name` and `email`, but says nothing about `slot_id` | Trimming an identifier could make it stop matching the id I sent to `/reset` | Do not trim `slot_id`, but reject a value that is only spaces | When the spec is silent, choose the behaviour with the least surprise, then write it down as an assumption. |

### Concept check (answer without looking, then correct yourself)

**1. Why validate the body before touching the database?** A bad request should cost nothing and change nothing, and the database should only ever see values that have passed the rules.

**2. Why read the clock once per request?** So "has the slot started?" and `created_at` refer to the same instant, and so a test with a fixed clock gives one predictable answer.

**3. Why does a slot that starts exactly now count as started?** The spec says a slot that "has already started" is refused. At the exact start time it has started, so allowing it would let someone book a slot that is beginning at that moment. Stating the boundary and testing it removes the guesswork.

**4. Why is `slot_id` not trimmed, when `name` and `email` are?** `name` and `email` are values from a person, and the spec asks for them to be cleaned. `slot_id` is an identifier that must match what `/reset` stored, so changing it could break the match.

**5. Why does it matter that unknown fields are dropped?** Otherwise a caller could send `status: "cancelled"` or choose their own `id`. Only the three fields I validate reach the database, so the server controls everything else.

**6. Why map rows through a serializer instead of returning them?** It names each field the contract promises, so an internal column such as `seq` can never leak into a response by accident.

**7. Why does bad input get 400 before a missing slot gets 404?** A fixed order makes answers predictable and keeps bad input from reaching the database at all. The test "invalid input is rejected before the slot is looked up" pins it.

**8. What can still go wrong today, and why did I leave it?** Two simultaneous requests can book the same slot, because nothing prevents it yet. I left it on purpose: the database rule belongs in milestone 4, together with the failing concurrency test that proves it is needed. A `test.todo` marks the gap.

### Evidence, and how to rerun it

Break each of these on purpose, check that a test fails, then undo it:

- Remove the line `if (slot.start_at <= now) throw ...` in `bookingsController.js`.
- Change `<=` to `<` in that line (the exactly-now test should fail).
- Remove `.toLowerCase()` or `.trim()` in `bookingSchema.js`.
- Change `now` to `new Date()` in the insert parameters (the `created_at` test should fail).
- Change `randomUUID()` to `req.body.id || randomUUID()` (the "caller should not control" test should fail).

**Experiments I ran myself:**

- [ ] Ran the new tests before the implementation and saw them fail
- [ ] Made each breakage above and saw a test fail
- [ ] Explained the eight answers above in my own words
## Milestone 4: no double booking, and cancel

### Built

A partial unique index, a booking insert that returns 409 when a slot is taken, an atomic cancel, a 404 for a slot deleted mid-booking, and tests that fire 20 requests at once.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| Four new tests passed against code that had no cancel, no index and no 409 | "The losers get the error shape" looped over an empty list; two cancel tests never asserted that the cancel worked; one didn't check there was only one winner | Each now asserts the count or the status first | A loop over zero items passes. Assert the length before looping over results. |

### Concept check

**1. Why can't application code alone stop double booking?** Checking and then inserting leaves a gap, and two simultaneous requests can both pass the check. I measured it: with a check-then-insert version and no index, all 20 simultaneous requests "won" the same slot in 4 of 5 runs.

**2. Why a partial unique index instead of a plain unique constraint?** A plain one on `slot_id` would stop a slot ever being booked twice, even after a cancellation. Restricting it to `status = 'confirmed'` lets a cancelled booking free the slot.

**3. Why `ON CONFLICT DO NOTHING` instead of catching the unique-violation error?** A conflict becomes an ordinary empty result, so the transaction is never aborted. After a failed statement Postgres refuses everything else in that transaction, which would block saving idempotency keys later.

**4. Why is cancel one `UPDATE ... WHERE id = $1 AND status = 'confirmed'`?** It changes a booking only if it is still confirmed, in one atomic step, so ten simultaneous cancels give one winner.

**5. Why can cancelling an old booking never touch the slot's new booking?** The update targets the booking id, not the slot. The old booking is already cancelled, so nothing matches and the answer is 409.

**6. Why 20 parallel requests, and why does the test pool need to be large?** A smaller pool would queue requests and hide the race. Twenty connections make them genuinely overlap.

**7. What does error code 23503 mean here, and why 404?** A foreign key violation: `/reset` deleted the slot after I had checked it existed. From the caller's view the slot is gone, so 404.

**8. What did the naive version do?** Check-then-insert without the index let all 20 people book one slot in 4 of 5 runs, and with the index but unhandled it returned 500s.

### Evidence, and how to rerun it

On your test database, in Neon's SQL editor (test branch), run `DELETE FROM bookings; DROP INDEX one_confirmed_per_slot;`, then run `npm test -- concurrency`. It should fail. Restore it with `CREATE UNIQUE INDEX one_confirmed_per_slot ON bookings (slot_id) WHERE status = 'confirmed';`.

- [ ] Ran the Level 3 tests before the implementation and saw them fail
- [ ] Dropped the index, saw the concurrency test fail, and restored it
- [ ] Ran the concurrency tests about 20 times with no failure
- [ ] Explained the eight answers above in my own words

## Milestone 5: deployment

### Built

A smoke script, `migrate:prod`, a keep-alive workflow, a 10-second database connection timeout, and a deploy runbook (`docs/DEPLOY.md`).

### Concept check

**1. Why a smoke test when I have unit and integration tests?** Those run in my environment. The smoke test checks the deployed service, with the real hosting, environment variables and database.

**2. Why a separate `DATABASE_URL_PROD` variable?** So a migration can't run against the wrong database by accident.

**3. Why does a keep-alive ping cost something?** Render's 750 free hours are shared across my whole workspace, and Neon's compute budget is 100 compute-unit hours per project, so keeping things awake uses them up.

**4. What is the main deployment risk, and how do I measure it?** The first request after sleep. I leave the service idle for 20 minutes, run the smoke test, and record the first request's time.

**5. Why migrate by hand instead of on deploy?** `node-pg-migrate` is a dev dependency, and Render doesn't install those under `NODE_ENV=production`.

**Experiments I ran myself:**

- [ ] Ran the smoke test against the live service
- [ ] Measured a cold start after 20 idle minutes: ______ seconds
- [ ] Confirmed the keep-alive runs in the Actions tab
## Milestone 6: idempotency and pagination (Level 4)

### Built

Idempotency keys with fingerprints and a per-key lock, cursor pagination, and 60+ tests for both.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| A test passed against code that didn't have the feature, and another gave different results alone and in the suite | My slot fixture built the time `T010:00`, which is invalid, so `/reset` returned 400 and silently left old data in place | Fixed the fixture, and every `beforeEach` now asserts that the reset returned 200 | A fixture that fails quietly makes every later test meaningless. Make setup fail loudly. |
| The "no lock" breakage wasn't caught in 6 runs | Rate limiting spaces simultaneous requests a few milliseconds apart, so they rarely overlapped at the moment the lock protects | The test slows the key lookup on purpose, so the overlap happens every time | A race test that depends on timing luck proves nothing. Force the interleaving. |

### Concept check

**1. Why store a fingerprint, not just the key?** To tell a true retry from a different request that reuses the key.
**2. Why an advisory lock per key?** Two simultaneous retries would both find nothing and both do the work. The lock makes the second one wait and then find the first one's saved answer.
**3. Why look the key up before validating the body?** So that "same key, different body" is always 422, whether or not the new body is valid.
**4. Which answers are remembered, and why not 429 or 500?** Booking outcomes (201, 404, 400 started, 409). A 429 or 500 says nothing about the request itself, so a retry should be allowed to try again.
**5. Why keyset pagination, not offset?** A booking created between pages shifts offset results and causes skipped or repeated rows.
**6. Why fetch `limit + 1` rows?** To know whether another page exists without a second query, so an exactly-full last page ends with a null cursor.
**7. Why validate cursors so strictly?** They come from the caller. Only cursors the server issued should be accepted, and anything else must be a clean 400, never a database error.
**8. Why order by `seq` and not `created_at`?** `seq` is unique and increases with every insert. `created_at` can tie, especially with an injected clock.

- [ ] Ran the Level 4 tests before the implementation and saw them fail
- [ ] Removed the lock line in `idempotency.js` and saw the forced-overlap test fail
- [ ] Explained the eight answers above in my own words

## Milestone 7: rate limiting (Level 5)

### Built

A sliding one-minute window of 5 attempts per email, kept in Postgres, with `Retry-After`.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| The Level 3 test "same person clicking 10 times" started failing | That person is now rate limited after 5 attempts | The test now expects one 201, no 5xx, and 429 for the rest | A new rule changes old expectations. Update the old test deliberately and say why. |
| A deliberate breakage of the window boundary wasn't caught | My mutation script changed a comment that contained the same text as the SQL, so the query was only half changed | Applied the change to the SQL line | Check that a deliberate breakage really changed what you meant it to. |

### Concept check

**1. Why keep the counters in Postgres, not memory?** They survive restarts and are shared by every instance.
**2. Why a lock per email?** Ten simultaneous requests would all read "0 attempts so far" and all be let through.
**3. Why count before validating?** The spec says failed attempts count, and an invalid request still has a usable email.
**4. Why not record blocked requests?** They would extend their own block forever.
**5. Why round `Retry-After` up?** Rounding down could tell a client to retry while it is still blocked, and 0 would invite an immediate retry.
**6. Why use the injected clock?** So the minute window is tested by moving time, not waiting.
**7. Why do idempotent replays count?** I read "every attempt" literally. It is written down as an assumption.
**8. Why does reset clear the counters?** A caller reusing an email after a reset would otherwise get a surprise 429.

- [ ] Removed the lock line in `rateLimit.js` and saw the 10-at-once test fail
- [ ] Explained the eight answers above in my own words
## Stage A: roles, the page host and security headers

### Built

Two keys with roles, an admin-only guard, `/config.js`, static hosting before the key check, security headers, and startup configuration checks. 55 new tests.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| Two new tests passed before the feature existed | One checked "the data is still there" and one checked "`/config.js` has no admin key". The old code returned 401 for both, which also satisfies them | Each now asserts the specific answer first (403, and 200 for `/config.js`) | A test can pass because of a different behaviour. State the exact outcome you expect. |
| My first colour-contrast numbers said 1.00:1 | My pattern matched the wrong colour names in the design file | I evaluated the design's real configuration instead | If a result looks impossible, distrust the tool before the data. |
| A startup test seemed to show the server running without its admin key | My working copy had a `.env` file that refilled the variable I had removed | Hid the `.env` for the check and the server stopped correctly | A test environment can hide or invent behaviour. Know what is in it. |

### Concept check

**1. Why can't the page hold a secret?** Anything the browser can send, a person with developer tools can send too.
**2. So how is the key protected?** Its privileges are limited, so reading it gains nothing that visiting the page doesn't.
**3. Why 403 and not 401?** 401 means we don't know who you are. 403 means we know you, but this key isn't allowed to do that.
**4. Why does the guard run before the route's logic?** So a public key gets the same answer whether or not a booking exists, and can't use the difference to probe.
**5. Why is the page served before the key check?** A browser has no key when it first asks for the page.
**6. What does the Content Security Policy do?** It tells the browser to load only the site's own files, so injected script can't run or send data elsewhere.
**7. Why is a missing public key only a warning?** A new setting must not take down a deployment that already works.
**8. Why escape `<` in `/config.js`?** So a value can never close a `<script>` tag and start injected markup.

- [ ] Ran the new tests before the implementation and saw them fail
- [ ] Removed `requireAdmin` from the reset route and saw the test fail
- [ ] Explained the eight answers above in my own words
## Stage B: the booking page

### Built

A booking page from the blue design: slot list with day tabs and a provider filter, booking form, confirmation, and every error state, plus the logic, API layer, styles and 100+ tests.

### Went wrong, and how I found it

| Symptom | Real cause | Fix | Lesson |
|---|---|---|---|
| The whole page test suite failed to start | The newest jsdom depends on a package that only ships as an ES module, which Jest on Node 22 cannot load | Pinned jsdom 26.1.0 | "Latest" is not always compatible. Pin what you have actually run. |
| A test said CSS classes were missing, but they existed | My test guessed how the stylesheet spells special characters. It writes a comma as `\2c` | The test now reads the stylesheet the way a browser does and undoes the escapes | Don't guess an encoding. Decode it. |
| A stricter assertion failed: the tab read "Dec2 available" | Two adjacent elements had no space between them, so assistive technology reads them joined | Added a real space between them | The screen layout hid a problem that the text revealed. Test the text, not only the look. |
| 2 of my 22 deliberate breakages passed the tests | One test checked the button was disabled but not its label; another didn't cover the moment before the list refreshed | Added both checks | A breakage that survives shows a gap. It is the most useful result of the exercise. |
| The screenshot showed "UTC (UTC)" | Short and full time-zone names were identical | Name the zone once when they match | Tests cannot see how something reads. Look at it. |

### Concept check

**1. Why rebuild the Stitch export instead of using it?** It loaded code and fonts from other sites and used inline handlers, which the policy forbids.
**2. Why `textContent` and not `innerHTML`?** Names and provider names come from users. As markup, they could run script on every visitor's page.
**3. Why compile Tailwind and commit the CSS?** The page then depends on no build step or outside site, and a test fails if the committed file is out of date.
**4. Why does a retry reuse the `Idempotency-Key`?** So a network failure followed by a retry can never book twice.
**5. Why change the key when the details change?** Different details are a different booking. Reusing the key would be answered with 422.
**6. Why hide slots that have started?** Booking one returns 400, so offering it would only invite an error.
**7. Why refresh the list after a booking?** The slot is now taken. Leaving it displayed would invite a 409.
**8. What can jsdom not tell me?** How the page looks. That needs a real browser and a human.

- [ ] Ran the page tests before the page existed and saw them fail
- [ ] Broke the page on purpose (for example, change `textContent` to `innerHTML`) and saw a test fail
- [ ] Opened the live page on my phone and on a desktop browser
- [ ] Explained the eight answers above in my own words