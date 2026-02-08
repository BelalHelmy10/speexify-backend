# Launch Readiness Checklist

Use this checklist as a release gate before any production launch.

## 1. Release Candidate Integrity

- Backend `main` branch is green in CI (`npm run ci:check`).
- Frontend build passes (`npm run build`) and deploy artifact is generated.
- Migration plan is defined (what migration runs, expected duration, rollback impact).
- Release owner and rollback owner are assigned.

## 2. Environment And Secrets

Run:

```bash
npm run launch:check
npm run launch:check:strict
```

Required to pass before go-live:

- `DATABASE_URL`, `SESSION_SECRET`, `ALLOWED_ORIGINS`
- Paymob secrets: `PAYMOB_API_KEY`, `PAYMOB_INTEGRATION_ID`, `PAYMOB_IFRAME_ID`, `PAYMOB_HMAC_SECRET`

Recommended hardening:

- Redis configured with strict mode (`REDIS_URL`, `SESSION_REDIS_STRICT=true`)
- Metrics protected (`OBS_METRICS_TOKEN`)
- Alerts enabled (`OBS_ALERTS_ENABLED=true`)

## 3. Data Protection And Recovery

- Latest backup exists and is verified.
- Recovery drill has passed in the last 30 days:

```bash
npm run backup:drill
```

- Privacy retention dry run reviewed:

```bash
npm run privacy:retention:dry
```

## 4. Payments And Revenue Safety

- End-to-end payment flow tested (create intent, webhook paid, credits granted).
- Webhook dedupe/retry flow tested (duplicate callback returns safe response).
- Failed payment recovery tested:
  - `GET /api/payments/orders/recovery`
  - `POST /api/payments/orders/:orderId/retry-intent`
- Manual support fallback prepared for disputed/uncertain payments.

## 5. Scale, Reliability, And Observability

- Load smoke test run and results accepted (`npm run loadtest:smoke`).
- Health checks are green: `/health`, DB check endpoint.
- Observability endpoints are reachable:
  - `/metrics`
  - `/api/observability/summary`
- Alert channel validated with a real test alert.

## 6. Egypt-Specific Readiness

- Low-bandwidth checkout flow tested on throttled 3G/2G profile.
- Arabic and English copy verified for checkout/payment/support critical paths.
- Payment recovery messages are clear in both languages.
- Support response SOP for payment delays and mobile network interruptions is documented.

## 7. Operational Readiness (People + Process)

- Incident commander for launch window is on-call.
- Runbooks are reviewed:
  - `docs/incident-response-runbook.md`
  - `docs/rollback-runbook.md`
- Communication templates are ready (internal + customer-facing).

## Go/No-Go Rule

- `GO`: zero critical failures, no unknowns on payments/data integrity.
- `NO-GO`: any failure in secrets, backups, payment integrity, or rollback uncertainty.
