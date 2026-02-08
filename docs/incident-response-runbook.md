# Incident Response Runbook

This runbook defines how to triage, mitigate, communicate, and close production incidents.

## Severity Levels

- `SEV-1`: Full outage, payment corruption risk, or data integrity risk.
- `SEV-2`: Major degradation (core journeys unreliable but partially working).
- `SEV-3`: Partial feature degradation with workaround.

## Immediate Actions (First 15 Minutes)

1. Declare incident and assign Incident Commander.
2. Freeze non-essential deploys.
3. Capture baseline evidence:
   - `/health`
   - `/metrics`
   - `/api/observability/summary`
   - recent structured logs and webhook errors
4. Decide severity and start incident channel/timeline.

## Triage Playbooks

### A) API Down / High 5xx

- Check service process and recent deploy SHA.
- Verify DB/Redis connectivity.
- If deploy-caused, trigger rollback immediately (see rollback runbook).
- If infra-caused, scale/restart as needed and communicate degraded status.

### B) Payment Webhook Delays / Mismatch

- Inspect `payment_webhook_events` processing status and `last_error`.
- Check Paymob callback signature failures and amount/currency mismatch logs.
- Confirm order state consistency (`pending`, `paid`, `failed`).
- Use retry-safe recovery endpoint for affected users.

### C) Session/Redis Instability

- Confirm `sessionStoreInfo` mode from startup logs.
- If memory fallback occurred unexpectedly in production, escalate to SEV-1/2.
- Restore Redis connectivity and verify new sessions persist.

### D) WebSocket/Realtime Degradation

- Validate `/ws/prep`, `/ws/classroom`, `/ws/support` handshake behavior.
- Check auth/origin failures versus transport/connectivity failures.
- Fallback user workflow to refresh/rejoin and support ticket escalation.

## Communication Template

Use this structure for stakeholder updates every 15-30 minutes:

- `Status`: Investigating / Mitigating / Monitoring / Resolved
- `Impact`: who is affected and what is broken
- `Scope`: regions/segments/endpoints
- `Mitigation`: what is being done now
- `ETA`: next update time (or unknown)

## Resolution Criteria

Incident can move to monitoring only when:

- Error rate is back within SLO threshold.
- Payment and order state transitions are consistent.
- No new high-severity alerts in two consecutive windows.

## Post-Incident (Within 24 Hours)

- Produce RCA with timeline and root cause.
- Add permanent fix tasks with owners and due dates.
- Update tests/runbooks/checklists to prevent recurrence.
- Share concise lessons learned with team/stakeholders.
