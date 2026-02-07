# Backup And Restore Runbook

## Goals

- `RPO (data loss target)`: <= 24 hours from logical backups.
- `RTO (recovery target)`: <= 60 minutes for restore to a drill/staging environment.
- Keep backups verifiable and restorable, not just stored.

## Scope

- PostgreSQL database (primary critical data).
- Uploaded files under `uploads/` (support attachments).

## Required Tools

- `pg_dump`
- `pg_restore`
- `psql`
- `tar` (if backing up/restoring uploads)

## Scripts

- `npm run backup:create`
- `npm run backup:restore`
- `npm run backup:drill`

All scripts are in `scripts/` and use environment variables (below).

## Environment Variables

- `BACKUP_SOURCE_DATABASE_URL`
  - Source DB for backups.
  - Fallback: `DIRECT_URL`, then `DATABASE_URL`.
- `BACKUP_OUTPUT_DIR`
  - Where snapshots are stored.
  - Default: `<project>/backups`
- `BACKUP_LABEL`
  - Label suffix for snapshot IDs (example: `manual`, `daily`, `drill`).
- `BACKUP_RETENTION_DAYS`
  - Snapshot retention window.
  - Default: `14`
- `BACKUP_INCLUDE_UPLOADS`
  - `true/false`; include `uploads/` as `uploads.tar.gz`.
  - Default: `false`
- `BACKUP_UPLOADS_DIR`
  - Uploads directory path.
  - Default: `<project>/uploads`
- `RESTORE_DATABASE_URL`
  - Target DB for restore (required for `backup:restore`).
- `RESTORE_UPLOADS_DIR`
  - Destination uploads dir for restore.
  - Default: `<project>/uploads`
- `RECOVERY_DRILL_DATABASE_URL`
  - Separate drill DB (required for `backup:drill`).
  - Must not match source DB URL.

## Standard Operating Procedures

### 1) Create backup snapshot

```bash
npm run backup:create
```

Example with uploads:

```bash
BACKUP_INCLUDE_UPLOADS=true BACKUP_LABEL=daily npm run backup:create
```

Result:

- Creates `backups/<timestamp>-<label>/`
- Writes:
  - `database.dump`
  - `manifest.json`
  - `uploads.tar.gz` (optional)

### 2) Restore snapshot

Dry run first:

```bash
RESTORE_DATABASE_URL=postgres://... npm run backup:restore -- --dry-run --snapshot <snapshot-dir-or-manifest>
```

Actual restore:

```bash
RESTORE_DATABASE_URL=postgres://... npm run backup:restore -- --yes --snapshot <snapshot-dir-or-manifest>
```

Restore uploads too:

```bash
RESTORE_DATABASE_URL=postgres://... npm run backup:restore -- --yes --restore-uploads --snapshot <snapshot-dir-or-manifest>
```

### 3) Run recovery drill

Creates/uses snapshot, restores into drill DB, validates key table counts, and writes a drill report:

```bash
RECOVERY_DRILL_DATABASE_URL=postgres://... npm run backup:drill
```

Use latest existing snapshot without creating a new one:

```bash
RECOVERY_DRILL_DATABASE_URL=postgres://... npm run backup:drill -- --skip-backup
```

## Recovery Drill Policy

- Frequency: at least monthly.
- Run against a dedicated drill/staging database.
- Capture evidence from generated report in `backups/drills/`.
- Review failures immediately and fix runbook/scripts before next cycle.

## Production Policy Recommendations

- Keep managed DB point-in-time recovery enabled in your DB provider.
- Run logical backups at least daily (prefer every 6-12 hours at scale).
- Store backup artifacts in off-host durable storage (object storage).
- Encrypt backup storage and restrict access via least privilege.
- Alert if no successful backup has been created in the last 24 hours.

## Post-Restore Verification Checklist

- API boots with restored DB.
- Login works for test accounts.
- Recent sessions/tickets/orders are present.
- Notifications and support attachments are accessible.
- Critical counts are sane (`User`, `Session`, `Order`, `SupportTicket`).
