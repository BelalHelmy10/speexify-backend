# Teacher earnings rollout

Teacher earnings are denominated in EGP and stored in piastres. The legacy
`rateHourlyCents` and `ratePerSessionCents` fields are intentionally not used
by the earnings ledger because their historical currency is ambiguous.

## Safe rollout order

1. Run `npm run earnings:preflight` to confirm the current migration and rate
   state without changing data.
2. Deploy the additive Prisma migration before enabling the new earnings UI.
3. In Admin → User Management, explicitly set each teacher's hourly or
   per-session rate in EGP.
4. Add an effective-dated EGP rate history entry for each teacher. Historical
   backfill will not infer a rate from the teacher's current User record. The
   admin user update accepts `rateEffectiveFrom` (ISO date) and
   `/api/admin/users/:id/rate-history` exposes the recorded intervals.
5. Run `npm run earnings:preflight` again, then run
   `npm run earnings:backfill` and review the dry-run output. It must show
   the expected teacher counts and no unexpected `NOT CONFIGURED` rates.
6. Run `npm run earnings:backfill:apply` only after explicitly confirming the
   effective-dated history and the dry-run results.
7. Open a teacher account and an admin account to verify the teacher balance,
   session detail, and manual payout flow.

The backfill is explicit and idempotent: normal teacher/admin reads never
create missing historical earnings or rewrite existing snapshots. The apply
command can create missing rows only from a recorded effective-dated rate;
sessions without a historical rate remain visible as `NOT CONFIGURED` and
require an explicit admin adjustment or rate-history decision.

## Eligibility rule

Only sessions with `status = completed` are eligible. Canceled or scheduled
sessions never create payable amounts. A missing EGP rate creates a visible
zero-value configuration entry and cannot be included in a payout.
Missing, invalid, or reversed session timestamps do not create an earning. The
snapshot outbox job is marked `FAILED` with a review error, and any legacy
earning with invalid source timestamps is blocked from payout.

Completed sessions with an earnings record are retained for auditability and
cannot be hard-deleted. Use cancellation or another supported administrative
state change instead of deleting a session with earnings.

## Migration command

Use `npm run prisma:migrate` in the deployment environment. It requires the
existing `DATABASE_URL` and `DIRECT_URL` safeguards and should be run before
the application starts serving the new endpoints.

## Completion outbox and reconciliation

Session completion writes a unique `TeacherEarningSnapshotJob` row in the same
transaction as the `completed` status. The request may deliver the snapshot
inline, but a `PENDING`, `PROCESSING`, or `FAILED` job is always durable and is
safe to retry. Run `npm run worker:teacher-earnings` as a continuously running
worker (one or more instances are safe; database locks and row claims avoid
duplicate processing).

The worker retries with bounded exponential backoff and emits the
`teacher-earning-snapshot-failed` operational alert after a failed attempt.
Administrators can inspect unresolved jobs in the admin teacher-earnings API.
The observability summary and Prometheus endpoint expose completed sessions,
earning rows, missing earnings, and pending/failed/processing snapshot jobs.

Existing completed sessions from before this migration are intentionally not
auto-backfilled by the worker. Review the reconciliation gap and use the
explicit, rate-history-aware backfill process when an administrator approves
each historical decision.
