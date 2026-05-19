# Observability Baseline

This backend now includes a baseline observability stack:

- Structured JSON logs via Pino
- Per-request tracing context (`requestId`, `traceId`, `spanId`)
- Prometheus-compatible metrics endpoint (`/metrics`)
- Admin metrics summary endpoint (`/api/observability/summary`)
- In-process alert evaluator with optional webhook delivery

## Request tracing and logs

Every request now gets:

- `x-request-id` response header
- `x-trace-id` response header

Completed request logs include method, route, status code, latency, identity hints, and trace fields.

## Metrics endpoints

- `GET /metrics`
  - Prometheus text format
  - Requires `OBS_METRICS_TOKEN`
  - Pass token with header `x-metrics-token`

- `GET /api/observability/summary?windowMs=<ms>`
  - Admin-only JSON snapshot for dashboard/debug usage
  - Includes totals, rolling window error/latency, status breakdown, and top routes

## Alerting

The alert loop runs in-process and evaluates rolling metrics.  
It fires alerts when thresholds are exceeded and respects cooldown to avoid alert spam.

Optional webhook support:

- `OBS_ALERT_WEBHOOK_URL`

## Environment variables

Tracing / Sentry:

- `SENTRY_TRACES_SAMPLE_RATE` (0..1, default: `0.1` prod, `1` non-prod)
- `SENTRY_PROFILES_SAMPLE_RATE` (0..1, default: `0`)

Metrics:

- `OBS_METRICS_TOKEN` (required in production; `/metrics` returns `401` without it)

Alerts:

- `OBS_ALERTS_ENABLED` (default: `true` except test)
- `OBS_ALERT_WINDOW_MS` (default: `300000`)
- `OBS_ALERT_CHECK_INTERVAL_MS` (default: `60000`)
- `OBS_ALERT_COOLDOWN_MS` (default: `600000`)
- `OBS_ALERT_ERROR_RATE_PCT` (default: `5`)
- `OBS_ALERT_P95_MS` (default: `1200`)
- `OBS_ALERT_MIN_REQUESTS` (default: `100`)
- `OBS_ALERT_WEBHOOK_URL` (optional)
