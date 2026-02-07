# Load Testing (10k / 100k / 1M)

This project includes a built-in load runner at:

- `scripts/loadTestRunner.js`

It executes a weighted API mix against production-like endpoints:

- `GET /health` (20%)
- `GET /api/message` (20%)
- `GET /api/csrf-token` (20%)
- `GET /api/packages?audience=INDIVIDUAL` (40%)

## Scenarios

| Scenario | Target RPS | Duration | Ramp | Max Inflight |
|---|---:|---:|---:|---:|
| `10k` | 120 | 300s | 60s | 350 |
| `100k` | 900 | 600s | 120s | 1500 |
| `1m` | 6000 | 900s | 180s | 8000 |

## SLOs

| Scenario | Availability | p95 | p99 | Injector Drop |
|---|---:|---:|---:|---:|
| `10k` | >= 99.5% | <= 500ms | <= 1000ms | <= 1% |
| `100k` | >= 99.0% | <= 800ms | <= 1800ms | <= 2% |
| `1m` | >= 98.5% | <= 1200ms | <= 2500ms | <= 5% |

If any SLO fails, the load command exits with code `1`.

## Run commands

```bash
# Quick local check
npm run loadtest:smoke

# Full profiles
npm run loadtest:10k
npm run loadtest:100k
npm run loadtest:1m
```

## Environment controls

- `LOADTEST_BASE_URL` (default: `http://localhost:5050`)
- `LOADTEST_TIMEOUT_MS` (default: `5000`)
- `LOADTEST_SCALE` (default: `1`)
- `LOADTEST_DURATION_SEC` (optional override)
- `LOADTEST_RAMP_SEC` (optional override)
- `LOADTEST_MAX_INFLIGHT` (optional override)

Example:

```bash
LOADTEST_BASE_URL=https://api-staging.speexify.com LOADTEST_SCALE=0.5 npm run loadtest:100k
```

## Reports

Each run writes a JSON report to:

- `reports/load/<timestamp>-<scenario>.json`

Use these reports to compare releases and verify trend stability before launch.
