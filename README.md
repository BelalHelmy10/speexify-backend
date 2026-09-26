# Speexify – Backend API

Speexify is an online teaching platform that connects learners with teachers for 1:1 sessions.  
This repository contains the **backend API** (Express + Prisma + PostgreSQL) that powers the platform.

It includes:

- Authentication & sessions
- Learner onboarding & assessment
- Session booking, rescheduling & credits
- Admin tools (user management, teacher workload, manual session creation)
- Paymob-based payments (if enabled)

## Test Pyramid

- Unit tests: `npm run test:unit`
  - Pure logic and helpers with no external systems.
- Integration tests: `npm run test:integration`
  - Middleware and boundary behavior with mocked request/response objects.
- Critical E2E tests: `npm run test:e2e`
  - Key API journeys using `supertest` and real routing/session behavior.

Default local test command runs fast, stable layers only:

```bash
npm test
```

Full CI gate runs compile + unit + integration + critical E2E:

```bash
npm run ci:check
```

## Load Testing

Load profiles for `10k`, `100k`, and `1m` user-scale scenarios are available.

```bash
npm run loadtest:smoke
npm run loadtest:10k
npm run loadtest:100k
npm run loadtest:1m
```

Full guide and SLO thresholds:

- `docs/load-testing.md`

## Observability

Baseline observability now includes:

- Structured request logs with request/trace IDs
- Prometheus metrics endpoint: `GET /metrics`
- Admin metrics snapshot: `GET /api/observability/summary`
- In-process alerting with optional webhook notifications

Guide and env variables:

- `docs/observability-baseline.md`

## Security Audit + Pentest

External security audit readiness is now operational with:

- Disclosure endpoints: `/.well-known/security.txt` and `/security.txt`
- Automated preflight scanner: `npm run security:preflight`
- Dependency audit command: `npm run security:deps`
- Combined command: `npm run security:audit`
- Scheduled/manual CI workflow: `.github/workflows/security-audit.yml`

Execution runbook:

- `docs/security-audit-pentest.md`

## Privacy & Compliance

Privacy baseline controls are now available:

- Data-subject request lifecycle endpoints (`/api/privacy/...`)
- Self-service export endpoint for authenticated users
- Admin-reviewed deletion requests with controlled anonymization
- Retention cleanup tooling (`npm run privacy:retention:dry`, `npm run privacy:retention:apply`)

Implementation details and runbook:

- `docs/privacy-compliance.md`

## Launch Ops Runbooks

Production launch and incident operations are documented with:

- Launch gate checklist: `docs/launch-readiness-checklist.md`
- Incident response: `docs/incident-response-runbook.md`
- Rollback procedure: `docs/rollback-runbook.md`
- Backup/restore and drills: `docs/backup-restore-runbook.md`

Operational command:

```bash
npm run launch:check
```

---

## Architecture overview

High level:

```text
[ Next.js frontend ]  <--->  [ Express API ]  <--->  [ PostgreSQL ]
                                 |
                                 +--> Paymob (payments)
                                 +--> Email provider (password reset, etc.)
The backend is a Node.js/Express app in src/.

Data access is via Prisma (prisma/schema.prisma).

Authentication is cookie-based sessions (express-session).

Frontend talks to the backend via /api/... endpoints.

Tech stack
Runtime: Node.js (deployed on Render)

Framework: Express

ORM: Prisma + PostgreSQL

Auth: Sessions + cookies

Security: Helmet, CSRF middleware, login rate limiting

Logging: Pino (src/lib/logger.js)

Payments: Paymob (optional)

How to run everything locally
1. Prerequisites
Node.js (LTS recommended)

npm

PostgreSQL

The Speexify frontend repo (Next.js app)

2. Backend (this repo)
From the backend root folder:

Install dependencies:

bash
Copy code
npm install
Generate Prisma client:

bash
Copy code
npx prisma generate
Run migrations (creates DB tables):

bash
Copy code
npx prisma migrate dev
Start the backend in development:

bash
Copy code
npm run dev
The backend will listen on the port defined by PORT (default 5050).

Backend base URL locally:

text
Copy code
http://localhost:5050
3. Frontend (Next.js app)
In the frontend repo:

Install dependencies:

bash
Copy code
npm install
Start the dev server:

bash
Copy code
npm run dev
Frontend base URL locally:

text
Copy code
http://localhost:3000
4. Database (PostgreSQL)
You need a PostgreSQL instance. Options:

Local Postgres install, or

Docker, for example:

bash
Copy code
docker run --name speexify-db \
  -e POSTGRES_USER=speexify \
  -e POSTGRES_PASSWORD=speexify \
  -e POSTGRES_DB=speexify \
  -p 5432:5432 \
  -d postgres:15
Then set your DATABASE_URL in the backend .env to point to this DB.

Example:

bash
Copy code
DATABASE_URL=postgresql://speexify:speexify@localhost:5432/speexify
Environment variables
All environment variables are read and centralized in src/config/env.js.

Create a `.env` file in the backend root with values like these:

```bash
# Node / environment
NODE_ENV=development
PORT=5050

# Database
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB_NAME

# Session / cookies
SESSION_SECRET=change-me-in-production
COOKIE_DOMAIN=localhost
ALLOWED_ORIGINS=http://localhost:3000
REDIS_URL=redis://localhost:6379

# WebSocket security
WS_AUTH_ENABLED=true
WS_ALLOWED_ORIGINS=http://localhost:3000

# Security
GOOGLE_CLIENT_ID=your-production-client-id.apps.googleusercontent.com
UPLOADS_ENABLED=false
UPLOAD_STORAGE_ROOT=/var/lib/speexify/uploads
UPLOAD_MALWARE_SCAN_COMMAND=clamdscan
CALENDAR_FEED_TTL_DAYS=30

# Paymob (optional)
PAYMOB_API_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_IFRAME_ID=

# Resend transactional email (required for registration verification codes)
RESEND_API_KEY=
EMAIL_FROM=Speexify <no-reply@speexify.com>
RESEND_WEBHOOK_SECRET=

# Logging
LOG_LEVEL=debug
```

For production, `SESSION_SECRET` must be a long random value with at least 32 characters. Generate one locally with:

```bash
openssl rand -base64 48
```

Do not use `change-me-in-production`, `dev-secret`, or any human-readable phrase in production.

What each variable does
NODE_ENV – development or production; affects logging, some behavior.

PORT – Port where the backend listens (e.g. 5050).

DATABASE_URL – Full PostgreSQL connection string for Prisma.

SESSION_SECRET – Secret string used to sign session cookies (must be long, random, and at least 32 characters in production).

COOKIE_DOMAIN – Domain for cookies (e.g. localhost in dev, your real domain in production).

ALLOWED_ORIGINS – Comma-separated list of allowed frontend origins for CORS (e.g. http://localhost:3000).

UPLOADS_ENABLED – Explicit production upload policy. Set to `false` until durable external storage and malware scanning are configured; disabled upload and attachment endpoints return `503` and never write to the local filesystem. Set to `true` only with both `UPLOAD_STORAGE_ROOT` and `UPLOAD_MALWARE_SCAN_COMMAND` configured.

UPLOAD_STORAGE_ROOT – Absolute path to the durable shared filesystem mount used for avatars and support attachments. It is optional when uploads are disabled; when uploads are enabled in production, it is required and must not be the default process-local `uploads` directory.

UPLOAD_MALWARE_SCAN_COMMAND – Executable used to scan every avatar and support attachment before it is persisted or served. It is required only when uploads are enabled in production; `clamdscan` is the recommended ClamAV deployment command.

GOOGLE_CLIENT_ID – Server-only Google OAuth audience. It is required in production and must match the OAuth client whose authorized JavaScript origins include the deployed frontend.

CALENDAR_FEED_TTL_DAYS – Lifetime of newly generated opaque calendar links, clamped to 1–90 days. Calendar tokens are hashed in the database and can be revoked from Settings.

REDIS_URL – Redis connection string. Required in production and in the default E2E suite for sessions, shared WebSocket rooms, connection limits, and rate limits.

SESSION_REDIS_STRICT – Makes Redis session startup fail instead of falling back to memory. It defaults to enabled in production; keep it enabled outside local development too.

SESSION_FORCE_MEMORY – Local/unit-test-only switch for the in-memory session store. The default E2E suite deliberately uses Redis; use `npm run test:e2e:memory` only for an explicit fallback-mode test.

Notification delivery – Registration verification codes are sent synchronously and the API only confirms success after Resend accepts them. Booking, cancellation, feedback, and reminder flows enqueue email bodies in `NotificationDelivery` without calling the email provider in the request path; run `npm run worker:notification-delivery` in a durable worker process for those flows. Admins can inspect `/api/admin/notification-deliveries` and queue failed rows for retry.

Resend delivery feedback – Configure the Resend webhook URL as `https://<api-host>/api/webhooks/resend` and store its signing secret in `RESEND_WEBHOOK_SECRET`. Signed delivery, bounce, complaint, and failure events update the delivery ledger; bounced and complained addresses are stored in `EmailSuppression` and are excluded from future queues.

Operational monitoring – `/metrics` exposes Prometheus-compatible HTTP, payroll, business-event, email, pricing, CMS, authentication, and payment-webhook metrics when authorized with `OBS_METRICS_TOKEN`. Admins can inspect `/api/observability/summary` for the JSON snapshot and payment reconciliation failures. Configure `OBS_ALERT_WEBHOOK_URL` and keep `OBS_ALERTS_ENABLED=true` in production for alert delivery.

RATE_LIMIT_ALLOW_MEMORY_FALLBACK – Optional development override. Keep unset in production so rate limiting fails closed when Redis is unavailable.

WS_AUTH_ENABLED – Enables WebSocket auth for /ws/prep and /ws/classroom (set false only for local debugging).

WS_ALLOWED_ORIGINS – Comma-separated allowlist for WebSocket upgrade origins (falls back to ALLOWED_ORIGINS when omitted).

CSRF – The API issues a session-bound token from `/api/csrf-token`; mutating requests must send it in the `csrf-token` or `x-csrf-token` header. It is not accepted in URLs or request bodies.

PAYMOB_API_KEY / PAYMOB_INTEGRATION_ID / PAYMOB_IFRAME_ID – Config for Paymob payments (leave empty if not used yet).

LOG_LEVEL – Logging level for pino (debug, info, warn, error).

Deployment notes
Render (example)
Typical settings for deploying to Render:

Environment:

NODE_ENV=production

PORT=10000 (Render sets this internally – the app should use PORT from env)

DATABASE_URL – Supabase transaction pooler connection string for app runtime. It normally ends with `pooler.supabase.com:6543/postgres`.

DIRECT_URL – Supabase session pooler connection string for Prisma migrations on Render. It should use `pooler.supabase.com:5432/postgres`, not `db.<project-ref>.supabase.co:5432`, because Render cannot reach Supabase's IPv6-only direct host.

SESSION_SECRET – long random string, at least 32 characters. Generate with `openssl rand -base64 48`.

REDIS_URL – Render Redis connection string

COOKIE_DOMAIN – your cookie parent domain, for example `.speexify.com`. Leave unset if the API and frontend do not share a parent domain.

ALLOWED_ORIGINS – your exact frontend URL, for example `https://speexify.com`

WS_AUTH_ENABLED – keep true in production

WS_ALLOWED_ORIGINS – e.g. https://your-frontend-domain.com

Paymob variables if payments are enabled

Build command:

```bash
npm ci && npm run prisma:migrate
```

Before release, run `npm run security:audit:production` in the deployment
environment. It verifies the production environment variables, OAuth audience,
durable upload mount, malware scanner, and dependency audit; a local shell with
development `.env` values is intentionally not considered a production check.

Do not enter the build command as `npm ci node ... generate node ... migrate deploy`; without `&&`, Render runs it as one command and the Prisma migration step will not run correctly.

Start command:

```bash
node index.js
```
Session reminders now run in a separate worker process.

Use this command in a dedicated worker service:

```bash
npm run worker:session-reminders
```

Optional worker tuning env vars:

- `REMINDER_INTERVAL_MS` (default `300000`)
- `REMINDER_WINDOW_MINUTES` (default `6`)
- `REMINDER_LOCK_NAME` (default `session-reminders-scheduler`)
- `REMINDER_LOCK_LEASE_MS` (default `max(interval*4, 600000)`)

Teacher payroll snapshots use a transactional outbox and should run in a
dedicated worker service as well:

```bash
npm run worker:teacher-earnings
```

Optional payroll worker tuning env vars:

- `TEACHER_EARNINGS_INTERVAL_MS` (default `60000`)
- `TEACHER_EARNINGS_BATCH_SIZE` (default `50`)
- `TEACHER_EARNINGS_LOCK_NAME` (default `teacher-earning-snapshot-worker`)
- `TEACHER_EARNINGS_LOCK_LEASE_MS` (default `max(interval*4, 600000)`)

Notification delivery uses the same durable-worker pattern. In local
development, `npm run dev` starts the API and notification worker together.
In production, run the notification worker as a separate continuously running
service alongside the API:

```bash
npm run worker:notification-delivery
```

Optional notification worker tuning env vars:

- `NOTIFICATION_DELIVERY_INTERVAL_MS` (default `30000`)
- `NOTIFICATION_DELIVERY_BATCH_SIZE` (default `25`)

“How to…” – product usage
This section explains how each role uses the product in simple terms.

How a learner uses the product
Sign up

Goes to the register page in the frontend.

Creates an account with name, email, and password.

Backend creates a User with role learner.

Complete onboarding

Visits an onboarding flow (questions about goals, experience, etc.).

Answers are sent to POST /me/onboarding.

Backend stores onboarding answers and can use them for matching / personalization.

Submit an assessment

Visits the assessment page.

Writes a text sample.

Frontend sends to POST /me/assessment.

Backend stores assessment so teachers can review level.

Book sessions

Learner uses dashboard/calendar to pick a time.

Frontend calls a booking endpoint (e.g. POST /sessions).

Backend:

Checks remaining credits.

Checks for scheduling conflicts.

Creates a Session tied to learner (and optionally a teacher).

Attend sessions

On the dashboard, sees upcoming sessions with:

Date/time

Teacher

meetingUrl

Clicks Join meeting to open the meeting link (Zoom, Meet, etc.).

Leave feedback and track progress

After the session, learner may see a prompt to leave feedback.

Feedback is sent to a feedback endpoint and stored in SessionFeedback.

On the progress page, learner can see:

Total sessions

Total minutes

Average rating

Activity over time

How a teacher uses the product
Access as teacher

A teacher is a User with role teacher.

An admin typically promotes a user to teacher.

View schedule

Logs in and views upcoming sessions assigned to them.

Frontend calls endpoints like GET /me/sessions or filtered GET /sessions.

Join sessions

Each session shows:

Learner

Time

Meeting link

Teacher clicks Join meeting to open the meetingUrl.

Submit session feedback

After a session, teacher goes to a feedback page (e.g. /dashboard/sessions/[id]/feedback).

Frontend calls POST /sessions/:id/feedback/teacher with:

Message to learner

Comments on session

Future steps

Backend stores this in SessionFeedback and can treat it as session completion.

Review workload (if allowed)

Admin dashboard provides workload views grouped by teacher, such as:

Number of sessions

Hours

Payroll info

This data comes from endpoints like GET /admin/teachers/workload.

How an admin uses the product
Log in as admin

Admin is a User with role admin.

Uses the same login page as others.

Sees an Admin Dashboard (e.g. /admin).

Manage users

Using endpoints under /admin/users, admin can:

Search users by name or email.

Change roles between learner, teacher, and admin.

Enable or disable accounts (toggle isDisabled).

Trigger password reset emails for users.

Impersonate users

Admin can temporarily impersonate another user:

POST /admin/impersonate/:id

POST /admin/impersonate/stop

Useful for debugging and support: see exactly what a learner or teacher sees.

Manage sessions

Admin can:

View all sessions with filters (by teacher, learner, date range, search query).

Create sessions for learners via POST /admin/sessions.

Edit sessions via PATCH /admin/sessions/:id:

Change time

Change assigned teacher

Update meeting link or notes

Delete sessions via DELETE /admin/sessions/:id.

Monitor teacher workload and payroll

Admin uses GET /admin/teachers/workload to see, per teacher:

Number of sessions

Hours taught

Hourly rate

Total payroll

Helps with payments and capacity planning.

Where to go next
Backend code: src/ (routes, services, middleware, config).

Database schema: prisma/schema.prisma.

Frontend app: separate Next.js repo that talks to this backend.

This README is intended to be enough for a new developer or operator to:

Understand the architecture at a high level,

Run backend + frontend + DB locally,

Configure environment variables,

Deploy the backend,

And understand how learners, teachers, and admins use the product.

pgsql
Copy code




```

## Backup And Recovery

Step 18 introduces executable backup/restore scripts plus a recovery drill flow.

### Commands

```bash
# Create snapshot (DB only by default)
npm run backup:create

# Create snapshot with uploads archive
BACKUP_INCLUDE_UPLOADS=true npm run backup:create

# Restore (dry run)
RESTORE_DATABASE_URL=postgres://... npm run backup:restore -- --dry-run --snapshot <snapshot>

# Restore (confirmed)
RESTORE_DATABASE_URL=postgres://... npm run backup:restore -- --yes --snapshot <snapshot>

# Monthly recovery drill (must target separate drill DB)
RECOVERY_DRILL_DATABASE_URL=postgres://... npm run backup:drill
```

### Runbook

See `/docs/backup-restore-runbook.md` for:

- RPO/RTO targets
- Backup retention policy
- Recovery drill procedure
- Post-restore verification checklist
