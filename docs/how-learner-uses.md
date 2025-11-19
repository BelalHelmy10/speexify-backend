# How a Learner Uses Speexify

## 1. Sign up

A learner creates an account using name, email, and password.  
Backend route used: `POST /auth/register`.

## 2. Log in

Learner logs in using email + password.  
Backend route: `POST /auth/login`.

A session cookie is created and stored in the browser.

---

## 3. Complete onboarding

The learner answers a short set of onboarding questions.  
Backend: `POST /me/onboarding`.

Data stored:

- goals
- level
- profile info
- optional preferences

---

## 4. Submit assessment

Learner writes a text sample or takes a small assessment.  
Backend: `POST /me/assessment`.

Admins and teachers can view it later.

---

## 5. Book sessions

From the dashboard/calendar, the learner picks a time.  
Backend: typically:

- `POST /sessions`  
  or
- `POST /me/sessions`

Backend checks:

- availability
- conflicts
- credits

---

## 6. Join session

Each session includes:

- start time
- teacher
- meeting url

The learner clicks **Join Meeting**.  
Frontend opens `meetingUrl`.

---

## 7. View progress

From `/progress`, the learner sees:

- total sessions
- total minutes
- activity chart
- average rating

Backend route: `GET /me/progress`.
