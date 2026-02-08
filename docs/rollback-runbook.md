# Rollback Runbook

Use this runbook when a deployment causes production instability.

## Rollback Triggers

Roll back immediately if any occurs after deploy:

- `SEV-1` outage
- payment/order integrity uncertainty
- sustained high error rate above alert threshold
- authentication/session failures at scale

## Preconditions

- Incident Commander assigned.
- Last known good release identified (commit SHA + deploy id).
- DB migration impact assessed (forward-only vs reversible).

## Standard Rollback Procedure

1. Pause new deploys.
2. Roll back backend service to last known good release in hosting platform.
3. Roll back frontend service if UI/API contract mismatch is involved.
4. Restart background worker processes tied to changed code.
5. Verify smoke checks:
   - `GET /health`
   - login/session
   - payment create intent
   - payment callback/webhook handling
   - one learner booking path and one support message path

## Database Rollback Guidance

- Prefer additive, backward-compatible migrations in normal releases.
- Do **not** run destructive rollback migrations during active incident unless required.
- If schema mismatch exists, restore service binary first, then decide on DB corrective action.
- If data corruption is suspected, move to backup restore strategy (`docs/backup-restore-runbook.md`).

## Verification Checklist After Rollback

- Error rate and latency return to baseline.
- New orders can be created and paid.
- No growth in failed webhook events.
- Sessions remain stable (no unexpected memory-store fallback).
- Alerts quiet for at least two evaluation windows.

## Roll-Forward Policy

- No immediate re-deploy until root cause is documented.
- Patch must include test coverage for the failed path.
- Run launch checklist again before redeploy (`docs/launch-readiness-checklist.md`).
