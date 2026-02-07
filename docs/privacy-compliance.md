# Privacy & Compliance Baseline

This backend now includes a privacy/compliance baseline suitable for EdTech operations:

- Data-subject request tracking (`privacy_requests` table)
- Self-service data export endpoint
- Deletion request workflow with admin review and account anonymization
- Retention cleanup tooling with explicit dry-run/apply modes

## API endpoints

Policy and rights metadata:

- `GET /api/privacy/policy`

Authenticated user endpoints:

- `GET /api/privacy/me/requests`
- `POST /api/privacy/me/requests`
  - body: `{ "type": "EXPORT" | "DELETE", "reason": "optional" }`
- `GET /api/privacy/me/export`

Admin-only endpoints:

- `GET /api/privacy/admin/requests`
- `PATCH /api/privacy/admin/requests/:id`
  - body: `{ "status": "PENDING" | "IN_REVIEW" | "COMPLETED" | "REJECTED", "notes": "optional" }`

## Deletion behavior

When a `DELETE` request is moved to `COMPLETED` by an admin:

- User account is anonymized and disabled
- Email is replaced with an irreversible redacted value
- Password is rotated to a random hash
- Verification/reset codes are deleted
- User notifications and availability records are removed
- Free-text fields in onboarding/assessment/support are sanitized

This preserves core relational integrity while removing direct personal identifiers.

## Retention cleanup

Retention cleanup script:

- `npm run privacy:retention:dry`
- `npm run privacy:retention:apply`

Cleanup targets:

- `VerificationCode` / `PasswordResetCode`
- Read notifications older than retention
- Audit records older than retention
- Resolved support tickets older than retention (cascades messages/attachments)

## Environment variables

- `PRIVACY_CONTACT_EMAIL` (default: `privacy@speexify.com`)
- `PRIVACY_POLICY_VERSION` (default: `2026-01`)
- `PRIVACY_RETENTION_DAYS_VERIFICATION_CODES` (default: `30`)
- `PRIVACY_RETENTION_DAYS_NOTIFICATIONS` (default: `180`)
- `PRIVACY_RETENTION_DAYS_AUDITS` (default: `730`)
- `PRIVACY_RETENTION_DAYS_SUPPORT_TICKETS` (default: `730`)
