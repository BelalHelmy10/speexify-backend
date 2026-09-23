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
4. Run `npm run earnings:preflight` again, then run
   `npm run earnings:backfill` and review the dry-run output. It must show
   the expected teacher counts and no unexpected `NOT CONFIGURED` rates.
5. Run `npm run earnings:backfill:apply` once the rates are confirmed.
6. Open a teacher account and an admin account to verify the teacher balance,
   session detail, and manual payout flow.

The backfill is idempotent: each completed session has one earning entry, and
running it again does not rewrite existing snapshots or paid entries.

## Eligibility rule

Only sessions with `status = completed` are eligible. Canceled or scheduled
sessions never create payable amounts. A missing EGP rate creates a visible
zero-value configuration entry and cannot be included in a payout.

Completed sessions with an earnings record are retained for auditability and
cannot be hard-deleted. Use cancellation or another supported administrative
state change instead of deleting a session with earnings.

## Migration command

Use `npm run prisma:migrate` in the deployment environment. It requires the
existing `DATABASE_URL` and `DIRECT_URL` safeguards and should be run before
the application starts serving the new endpoints.
