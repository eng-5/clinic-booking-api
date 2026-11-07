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
 
## Milestone 3 onward
 
Entries are added as each milestone is finished, using the same four headings: built, went wrong, concept check, evidence.