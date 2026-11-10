# Deploying the clinic booking API
 
Production is a Render web service (the Node app) talking to a Neon Postgres database. Follow the steps in order. Each one ends with a way to check it worked.
 
## What the free tiers do (checked against Render's and Neon's own docs, November 2026)
 
These facts decide the keep-alive design, so check them again before relying on them.
 
| | Free-tier behaviour |
|---|---|
| **Render web service** | Spins down after 15 minutes without inbound traffic. Waking it takes up to about a minute. Render may also restart a free service at any time. |
| **Render hours** | 750 free instance hours per workspace per month, shared by every free service in the workspace. One service awake all month uses about 720 to 744 hours. If the workspace runs out, Render suspends all its free web services until the month resets. |
| **Neon compute** | Suspends after 5 minutes of inactivity (cannot be turned off on the free plan) and wakes in a few hundred milliseconds on the next connection. |
| **Neon budget** | 100 compute-unit hours per project per month. Compute-unit hours = compute size multiplied by hours the compute is awake. |
 
**Consequences**
- The first request after Render has slept is the main risk, because of the minute-long wake. A periodic ping prevents it.
- Neon's wake is quick enough that a grader would barely notice it.
- If your Render workspace also hosts another always-on free service (for example your social app), the two together can exceed 750 hours and **suspend both**. Check the Render dashboard before relying on a keep-alive ping.
## 1. Create the production database
 
1. In the Neon project, create a third branch named `production`. Dev and test stay as they are.
2. Copy its **direct** connection string (no `-pooler` in the host).
3. Put it in your local `.env` as `DATABASE_URL_PROD=...`. Never commit it.
## 2. Migrate production, from your machine
 
```powershell
npm run migrate:prod
```
 
This reads `DATABASE_URL_PROD` only, so it can never run against the dev database by accident. Check it worked in Neon's SQL editor, on the `production` branch:
 
```sql
SELECT name FROM pgmigrations ORDER BY id;
SELECT indexname FROM pg_indexes WHERE indexname = 'one_confirmed_per_slot';
```
 
You should see both migrations and the index. Migrations are run by hand because `node-pg-migrate` is a dev dependency, and Render installs without dev dependencies when `NODE_ENV=production`. Run this step again whenever you add a migration.
 
## 3. Create the Render web service
 
Push your work to GitHub and merge the branch into `main` first (the service deploys `main`). Then in Render: **New**, then **Web Service**, then pick the repo.
 
| Setting | Value |
|---|---|
| Region | The same region as your Neon database (fewer milliseconds on every query) |
| Branch | `main` |
| Build command | `npm ci` |
| Start command | `npm start` |
| Instance type | Free |
| Health check path | `/health` |
| Auto-deploy | After CI checks pass, if offered; otherwise on commit |
 
Environment variables:
 
| Name | Value |
|---|---|
| `API_KEY` | A new random value, different from your local one |
| `DATABASE_URL` | The production direct connection string |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | optional, default `info` |
 
Render supplies `PORT` itself, and the app already reads it.
 
**Check:** open `https://<your-service>.onrender.com/health`. You should see `{"status":"ok","database":"connected"}`.
 
## 4. Run the smoke test against the live service
 
```powershell
$env:BASE_URL = "https://<your-service>.onrender.com"
$env:API_KEY  = "<the production key>"
npm run smoke
```
 
It walks the whole journey (key checks, reset, book, look up, double-book, 10 simultaneous bookings, cancel, validation errors) and prints `ok` or `FAIL` for each step. Every step should be `ok`. The first line also shows how long a cold request took. Run it again after every deploy.
 
## 5. Cold-start check
 
1. Leave the service completely untouched for at least 20 minutes (long enough for both Render and Neon to sleep).
2. Run `npm run smoke` and note the time on the first line.
3. Write the number in the README. If it is close to a minute, set up the keep-alive below.
## 6. Keep-alive (during grading only)
 
The workflow `.github/workflows/keepalive.yml` calls `/health` every 10 minutes, which is inside Render's 15-minute window.
 
1. In the GitHub repo: Settings, then Secrets and variables, then Actions, then Variables. Add `HEALTH_URL` = `https://<your-service>.onrender.com/health`.
2. Scheduled workflows only run from the **default branch**, so merge to `main` first.
3. Check the Actions tab for `keepalive` runs, or start one with **Run workflow**.
Things to know:
- `/health` also queries the database, so each ping wakes Neon, which then sleeps again after 5 idle minutes. Check **compute size** and the **usage** page in the Neon console: at 10-minute pings the compute is awake roughly half the time. I have not checked your project's compute size, so confirm the monthly total stays under 100 compute-unit hours. If it won't, ping a path that doesn't touch the database (any unknown path such as `/ping` answers 401 without a key) and let Neon wake on demand.
- GitHub can delay scheduled runs, and may disable schedules in a repository with no activity for 60 days. In a private repository, scheduled runs use your free Actions minutes. As a backup you can add a free external pinger (for example cron-job.org) pointing at the same URL.
- **Turn the keep-alive off once the assessment team has contacted you**, to stop using free hours.
## 7. After you submit: freeze
 
They ask you to keep the service running and unchanged until they contact you.
 
- Do not push to `main`. Turn on branch protection for `main`, and set Render's auto-deploy to **Off**.
- Do not run `/reset` or the smoke test again. The graders reset the data themselves.
- Keep the keep-alive on, and check the Render and Neon dashboards once a day for suspensions.
## Troubleshooting
 
| Symptom | Likely cause |
|---|---|
| Every request returns 401 | The `API_KEY` in Render differs from the key you are sending |
| `/health` returns 503 | The database is unreachable: check `DATABASE_URL`, and that the Neon project isn't suspended or out of budget. The Render logs show the underlying error |
| First request takes about a minute | Render woke from sleep. See section 6 |
| Booking returns 500 | Migrations were not run on the production database. Run `npm run migrate:prod` |
| `idle pool client error` in the logs | A pooled connection was dropped while idle. It is handled and the pool replaces it |