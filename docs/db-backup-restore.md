# DB Backup and Restore Runbook

**Goal:** Recover the `gateway_sensitive` Postgres schema from an encrypted
S3 backup in under 30 minutes on a fresh database instance.

This runbook covers the complete path: from an existing backup set in S3 to a
verified, usable database restore.  It is written to be followed by an engineer
with AWS CLI access who has never run a restore before.

Secrets (KMS key IDs, Postgres credentials, S3 bucket names) are never
committed to git.  Use the CDK stack outputs and AWS Secrets Manager to
retrieve them.

---

## Architecture overview

```
Gateway node
  ├─ Postgres (local)
  │   └─ schema: gateway_sensitive
  │       ├─ node_credentials   (AES-256-GCM encrypted fields)
  │       ├─ audit_log          (append-only)
  │       └─ backup_manifest    (backup run history)
  │
  └─ db-backup.ts  (cron job, e.g. daily at 02:00 UTC)
      │
      ├─ pg_dump --schema=gateway_sensitive → temp file
      ├─ KMS:GenerateDataKey → plaintext DEK + encrypted DEK
      ├─ AES-256-GCM encrypt dump with plaintext DEK
      ├─ zero-fill plaintext DEK from memory
      ├─ S3:PutObject → backups/postgres/<timestamp>/dump.enc
      ├─ S3:PutObject → backups/postgres/<timestamp>/dek.enc
      ├─ S3:PutObject → backups/postgres/<timestamp>/meta.json
      ├─ S3:PutObject → backups/postgres/latest.json  (pointer)
      └─ CloudWatch:PutMetricData → GatewayNodeBootstrap/DBBackup/BackupSuccess
```

Encrypted objects are also protected by S3 SSE-KMS at rest (layered
encryption: AES-256-GCM client-side + KMS-managed server-side).

The `backups/postgres/` prefix has a 90-day expiry lifecycle rule and S3
versioning enabled, so accidental overwrites are recoverable within 30 days.

---

## Postgres schema deployment

### First-time setup

Apply the schema migration to the target Postgres instance:

```bash
psql -U postgres -d <DATABASE_NAME> \
  -f db/migrations/001_sensitive_state_schema.sql
```

Create application service accounts and assign roles:

```bash
# Reader account (read-only application code)
psql -U postgres -d <DATABASE_NAME> -c "
  CREATE USER gateway_app_reader WITH PASSWORD '<STRONG_RANDOM_PASSWORD>';
  GRANT gateway_reader TO gateway_app_reader;
"

# Writer account (application code that inserts/updates)
psql -U postgres -d <DATABASE_NAME> -c "
  CREATE USER gateway_app_writer WITH PASSWORD '<STRONG_RANDOM_PASSWORD>';
  GRANT gateway_writer TO gateway_app_writer;
"

# Backup account (used by the pg_dump job; SELECT only)
psql -U postgres -d <DATABASE_NAME> -c "
  CREATE USER gateway_backup_user WITH PASSWORD '<STRONG_RANDOM_PASSWORD>';
  GRANT gateway_backup TO gateway_backup_user;
"
```

Store each password in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name "/gateway/postgres/app-writer-password" \
  --secret-string "REPLACE_WITH_REAL_VALUE"
```

---

## Running the backup job

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `BACKUP_KMS_KEY_ID` | Yes | KMS key ARN or alias from the CDK stack (`BootstrapKey`) |
| `BACKUP_S3_BUCKET` | Yes | Artifact bucket name (CDK output `ArtifactBucketName`) |
| `PGHOST` | Yes | Postgres host |
| `PGPORT` | No | Postgres port (default: 5432) |
| `PGDATABASE` | Yes | Database name |
| `PGUSER` | Yes | Postgres user (`gateway_backup_user`) |
| `PGPASSWORD` | Yes | Password for the backup user |
| `BACKUP_DB_SCHEMA` | No | Schema to dump (default: `gateway_sensitive`) |

### Manual run

```bash
export BACKUP_KMS_KEY_ID="arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>"
export BACKUP_S3_BUCKET="gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>"
export PGHOST="localhost"
export PGDATABASE="gateway"
export PGUSER="gateway_backup_user"
export PGPASSWORD="<from Secrets Manager>"

cd /opt/gateway/agent
node dist/db-backup.js
```

### Scheduled cron (systemd timer example)

Create `/etc/systemd/system/gateway-db-backup.service`:

```ini
[Unit]
Description=Gateway sensitive-state DB backup
After=network.target postgresql.service

[Service]
Type=oneshot
User=gateway
EnvironmentFile=/opt/gateway/.backup-env
ExecStart=/usr/bin/node /opt/gateway/agent/dist/db-backup.js
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gateway-db-backup
```

Create `/etc/systemd/system/gateway-db-backup.timer`:

```ini
[Unit]
Description=Run gateway DB backup daily at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Enable the timer:

```bash
systemctl daemon-reload
systemctl enable --now gateway-db-backup.timer
systemctl list-timers gateway-db-backup.timer
```

The `/opt/gateway/.backup-env` file must be mode `0600` and contain the
environment variables listed above.  Never commit it to git.

---

## Restore procedure

### Pre-restore checklist

| Check | Command | Expected |
|---|---|---|
| Target Postgres is running | `pg_isready -h $PGHOST` | `accepting connections` |
| Target schema migration applied | `psql -c '\dn gateway_sensitive'` | schema listed |
| KMS key accessible | `aws kms describe-key --key-id $BACKUP_KMS_KEY_ID` | `KeyState: Enabled` |
| Latest backup exists in S3 | `aws s3 ls s3://$BACKUP_S3_BUCKET/backups/postgres/latest.json` | file listed |
| Node has IAM permissions | `aws sts get-caller-identity` | node agent role ARN |

### Step 1 — Set environment variables

```bash
export BACKUP_KMS_KEY_ID="arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>"
export BACKUP_S3_BUCKET="gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>"

# TARGET database connection (where data will be restored)
export PGHOST="localhost"
export PGDATABASE="gateway"
export PGUSER="postgres"
export PGPASSWORD="<superuser password>"
```

To restore a specific backup rather than the latest, set:

```bash
export RESTORE_S3_PREFIX="s3://$BACKUP_S3_BUCKET/backups/postgres/2026-01-15T02-00-00-000Z/"
```

To drop and recreate existing objects before restoring:

```bash
export RESTORE_CLEAN="true"
```

### Step 2 — Run the restore

```bash
cd /opt/gateway/agent
node dist/db-restore.js
```

The restore script will:

1. Discover the latest backup (or use `RESTORE_S3_PREFIX`)
2. Print the backup timestamp and expected dump size
3. Download and KMS-decrypt the data key
4. Download, decrypt (AES-256-GCM), and checksum-verify the dump
5. Run `pg_restore` to reload the schema
6. Print the total restore duration

### Step 3 — Verify the restore

```bash
# Confirm the schema and tables exist
psql -U postgres -d gateway -c '\dt gateway_sensitive.*'

# Spot-check the audit_log row count
psql -U postgres -d gateway -c \
  'SELECT count(*) FROM gateway_sensitive.audit_log;'

# Confirm the latest backup_manifest record shows "success"
psql -U postgres -d gateway -c \
  "SELECT started_at, status, s3_uri FROM gateway_sensitive.backup_manifest
   ORDER BY started_at DESC LIMIT 5;"
```

---

## End-to-end restore drill (#27)

Run the drill script to exercise the full backup → restore → verify cycle
against a disposable database. The drill inserts a canary row, takes a real
backup, restores into the target, and confirms the canary row is present.

```bash
# SOURCE database (read from)
export PGHOST="localhost"
export PGDATABASE="gateway"
export PGUSER="gateway_backup_user"
export PGPASSWORD="<backup user password>"

# TARGET database (written to; can be a separate DB on the same Postgres)
export RESTORE_PGDATABASE="gateway_restore_test"
export RESTORE_PGUSER="postgres"
export RESTORE_PGPASSWORD="<superuser password>"

export BACKUP_KMS_KEY_ID="arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>"
export BACKUP_S3_BUCKET="gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>"

cd /opt/gateway/agent
node dist/db-restore-drill.js
```

The drill prints a JSON report showing canary ID, backup URI, backup duration,
restore duration, SHA-256 integrity hash, and whether the canary row was found.
Capture this output as your restore drill evidence:

```
=== Restore Drill Report ===
{
  "canaryId": "...",
  "backupUri": "s3://...",
  "backupDurationMs": 4823,
  "restoreResult": {
    "backupPrefix": "s3://...",
    "durationMs": 3102,
    "dumpSha256": "abc123...",
    "dumpSizeBytes": 98304
  },
  "verificationPassed": true,
  "totalDurationMs": 8231,
  "notes": [...]
}

[drill] DRILL PASSED in 8231 ms total (backup: 4823 ms, restore: 3102 ms)
```

---

## Backup monitoring and alerts (#26)

The CDK stack provisions:

| Resource | Name | Purpose |
|---|---|---|
| CloudWatch alarm | `gateway-db-backup-missing` | Fires when no successful backup in 25 hours |
| SNS topic | `gateway-db-backup-alerts` | Receives alarm notifications |

To subscribe an email address:

```bash
aws sns subscribe \
  --topic-arn $(aws cloudformation describe-stacks \
    --stack-name GatewayNodeBootstrap \
    --query "Stacks[0].Outputs[?OutputKey=='BackupAlertTopicArn'].OutputValue" \
    --output text) \
  --protocol email \
  --notification-endpoint ops@example.com
```

Check the current alarm state:

```bash
aws cloudwatch describe-alarms \
  --alarm-names gateway-db-backup-missing \
  --query 'MetricAlarms[0].StateValue'
```

A `ALARM` state means either the backup job failed or has not run in the last
25 hours.  Check the systemd journal on the node:

```bash
journalctl -u gateway-db-backup --since "24 hours ago"
```

---

## Troubleshooting

### `pg_dump` fails with authentication error

Confirm `PGUSER` has the `gateway_backup` role and that `PGPASSWORD` is
correct.  The backup job never logs the password.

### KMS `AccessDenied` during `GenerateDataKey` or `Decrypt`

The node must be running with the `gateway-node-agent` IAM role, which has
`kms:Decrypt` and `kms:GenerateDataKey` on the bootstrap KMS key.  Run
`aws sts get-caller-identity` to verify the assumed role.

### `Dump integrity check failed`

The downloaded ciphertext does not match the plaintext SHA-256 stored in
`meta.json`.  Do not proceed with this backup.  Select an earlier backup by
setting `RESTORE_S3_PREFIX` to a previous timestamp prefix.

### Restore drill canary verification fails

The canary row was not found in the restore target.  Possible causes:
- The dump was taken before the canary INSERT committed
- `pg_restore` exited with a non-zero status (check the output above)
- The restore target database is pointing at the wrong host/port

---

## Related documents

- [`docs/aws-setup.md`](aws-setup.md) — CDK stack deployment and IAM setup
- [`docs/enrollment-trust-model.md`](enrollment-trust-model.md) — trust boundaries
- [`db/migrations/001_sensitive_state_schema.sql`](../db/migrations/001_sensitive_state_schema.sql) — schema DDL
- [`packages/node-agent/src/db-backup.ts`](../packages/node-agent/src/db-backup.ts) — backup implementation
- [`packages/node-agent/src/db-restore.ts`](../packages/node-agent/src/db-restore.ts) — restore implementation
- [`packages/node-agent/src/db-restore-drill.ts`](../packages/node-agent/src/db-restore-drill.ts) — end-to-end drill
