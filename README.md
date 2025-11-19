# Speexify – Backend API

Speexify is an online teaching platform that connects learners with teachers for 1:1 sessions.  
This repository contains the **backend API** (Express + Prisma + PostgreSQL) that powers the platform.

It includes:

- Authentication & sessions
- Learner onboarding & assessment
- Session booking, rescheduling & credits
- Admin tools (user management, teacher workload, manual session creation)
- Paymob-based payments (if enabled)

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

Create a .env file in the backend root with values like these:

bash
Copy code
# Node / environment
NODE_ENV=development
PORT=5050

# Database
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB_NAME

# Session / cookies
SESSION_SECRET=change-me-in-production
COOKIE_DOMAIN=localhost
ALLOWED_ORIGINS=http://localhost:3000

# CSRF
CSRF_COOKIE_NAME=csrf-token
CSRF_HEADER_NAME=x-csrf-token

# Paymob (optional)
PAYMOB_API_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_IFRAME_ID=

# Logging
LOG_LEVEL=debug
What each variable does
NODE_ENV – development or production; affects logging, some behavior.

PORT – Port where the backend listens (e.g. 5050).

DATABASE_URL – Full PostgreSQL connection string for Prisma.

SESSION_SECRET – Secret string used to sign session cookies (must be long & random in production).

COOKIE_DOMAIN – Domain for cookies (e.g. localhost in dev, your real domain in production).

ALLOWED_ORIGINS – Comma-separated list of allowed frontend origins for CORS (e.g. http://localhost:3000).

CSRF_COOKIE_NAME – Cookie name where the CSRF token is stored.

CSRF_HEADER_NAME – Header name where frontend sends the CSRF token in requests.

PAYMOB_API_KEY / PAYMOB_INTEGRATION_ID / PAYMOB_IFRAME_ID – Config for Paymob payments (leave empty if not used yet).

LOG_LEVEL – Logging level for pino (debug, info, warn, error).

Deployment notes
Render (example)
Typical settings for deploying to Render:

Environment:

NODE_ENV=production

PORT=10000 (Render sets this internally – the app should use PORT from env)

DATABASE_URL – connection string to your managed PostgreSQL

SESSION_SECRET – long random string

COOKIE_DOMAIN – your domain (e.g. yourapp.com)

ALLOWED_ORIGINS – e.g. https://your-frontend-domain.com

Paymob variables if payments are enabled

Build command:

bash
Copy code
npm ci
Start command:

bash
Copy code
node index.js
This backend does not require any extra cron jobs by default.
If you later add reminder scripts or scheduled jobs, you can:

Create a separate worker service that runs a script periodically, or

Use an external cron service to hit a reminder endpoint.

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
