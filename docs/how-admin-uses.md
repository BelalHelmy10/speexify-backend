# How an Admin Uses Speexify

## 1. Log in as admin

Admin is a user with `role = "admin"`.

Admins see `/admin` dashboard in frontend.

---

## 2. Manage users

Admin can:

- search users
- change roles
- disable/enable accounts
- send reset emails

Backend:

- `GET /admin/users`
- `PATCH /admin/users/:id`
- `POST /admin/users/:id/reset-password`

---

## 3. Impersonate users

Admin can view the system from another user’s view.

Backend:

- `POST /admin/impersonate/:id`
- `POST /admin/impersonate/stop`

Useful for:

- debugging
- support
- verifying a learner or teacher issue

---

## 4. Manage sessions

Admin can:

- view all sessions
- create sessions
- edit sessions
- delete sessions

Backend:

- `GET /admin/sessions`
- `POST /admin/sessions`
- `PATCH /admin/sessions/:id`
- `DELETE /admin/sessions/:id`

---

## 5. View teacher workload (payroll)

Backend:
`GET /admin/teachers/workload`

Shows:

- list of teachers
- hours worked
- number of sessions
- payroll info
- teaching method

Used for monthly invoices/payments.
