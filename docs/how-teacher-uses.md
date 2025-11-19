# How a Teacher Uses Speexify

## 1. Account is created by admin

A teacher is simply a `User` with role `teacher`.

Admins set this via:
`PATCH /admin/users/:id { role: "teacher" }`

---

## 2. View upcoming sessions

Teacher logs in and sees:

- list of upcoming sessions
- information about learner
- meeting links

Backend route:  
`GET /me/sessions` or `GET /sessions?teacherId=...`

---

## 3. Join a session

The teacher clicks **Join meeting**.  
The meeting link is stored in `session.meetingUrl`.

---

## 4. Submit session feedback

After each session, teacher fills:

- message to learner
- comments
- next steps

Backend route:
`POST /sessions/:id/feedback/teacher`

Data is saved and associated with the session.

---

## 5. Review workload (optional)

Admins can also view workload.  
The teacher may see their own data depending on the frontend.

Backend route:
`GET /admin/teachers/workload?teacherId=X`

Shows:

- total sessions
- total hours
- hourly rate
- payroll total
