# Operator Runbook — Gateway Node Bootstrap

**Audience:** any engineer with AWS CLI access who needs to operate the gateway
node: enroll a new node, verify backup health, run a restore drill, or escalate
a failure.

**Sensitive specifics** (real instance IDs, bucket names, KMS key ARNs, Postgres
credentials) are never committed here.  Keep them in a separate encrypted note
(e.g. a password manager entry or an encrypted ops doc).  This file uses
placeholders throughout.

---

## Quick-reference index

| Operation | Section |
|---|---|
| Enroll a new node | [Enrollment](#enrollment) |
| Run bootstrap agent on a fresh node | [Bootstrap](#bootstrap) |
| Check backup health | [Backup checks](#backup-checks) |
| Run a restore drill | [Restore drill](#restore-drill) |
| Revoke a compromised or decommissioned node | [Node revocation](#node-revocation) |
| Failure escalation | [Failure escalation](#failure-escalation) |

---

## Pre-flight: verify control plane is up

Before touching any node, confirm the control plane is ready:

```bash
# Stack status
aws cloudformation describe-stacks \
  --stack-name GatewayNodeBootstrap \
  --query 'Stacks[0].StackStatus' --output text
# Expected: UPDATE_COMPLETE or CREATE_COMPLETE

# Save the API URL for later steps
export CONTROL_SERVICE_URL=$(aws cloudformation describe-stacks \
  --stack-name GatewayNodeBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='ControlServiceApiUrl'].OutputValue" \
  --output text | sed 's|/$||')
echo "Control service: $CONTROL_SERVICE_URL"
```

If the stack is not deployed, follow `docs/aws-setup.md` first.

---

## Enrollment

**Time:** ~5 minutes.  Run from your local machine (not the node).

```bash
# Set the instance ID of the node you want to enroll
export INSTANCE_ID="i-REPLACE_WITH_REAL_INSTANCE_ID"

# Issue a 60-minute enrollment token
ENROLL_RESPONSE=$(curl -s -X POST "${CONTROL_SERVICE_URL}/v1/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"instanceId\": \"${INSTANCE_ID}\", \"profileId\": \"edge-gateway\"}")
echo "$ENROLL_RESPONSE"

# Parse and export the token
export ENROLLMENT_TOKEN=$(echo "$ENROLL_RESPONSE" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "Token expires: $(echo "$ENROLL_RESPONSE" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['expiresAt'])")"
```

Verify the pending record in DynamoDB:

```bash
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"enrollment\"}}" \
  --query 'Item.status.S' --output text
# Expected: pending
```

Pass `ENROLLMENT_TOKEN` and `CONTROL_SERVICE_URL` to the node through a secure
channel (EC2 user-data, Systems Manager Run Command, or a one-time secrets
channel).  The token expires in **60 minutes**.

For full enrollment details see `docs/recovery-runbook.md` §Phase 1 and
`docs/aws-setup.md` §Enrollment workflow.

---

## Bootstrap

**Time:** ~22–46 minutes on a fresh node; under 10 minutes on a repeat run.
Run these commands on the node as root.

```bash
# 1. Ensure Node.js ≥ 20 is present
node --version 2>/dev/null || {
  # Download the setup script and inspect it before running
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource-setup.sh
  # Review /tmp/nodesource-setup.sh before proceeding, then:
  bash /tmp/nodesource-setup.sh
  apt-get install -y nodejs
}

# 2. Get the agent (clone or copy pre-built dist/)
git clone https://github.com/goblinsan/gateway-node-bootstrap.git /opt/gateway/agent
cd /opt/gateway/agent && npm install && npm run build --workspace packages/node-agent

# 3. Set only the required environment variables
export GATEWAY_CONTROL_SERVICE_URL="REPLACE_WITH_CONTROL_SERVICE_URL"
export GATEWAY_ENROLLMENT_TOKEN="REPLACE_WITH_ENROLLMENT_TOKEN"

# 4. Run the agent with only those two variables in scope
sudo \
  GATEWAY_CONTROL_SERVICE_URL="$GATEWAY_CONTROL_SERVICE_URL" \
  GATEWAY_ENROLLMENT_TOKEN="$GATEWAY_ENROLLMENT_TOKEN" \
  node dist/index.js 2>&1 | tee /var/log/gateway-bootstrap.log
```

**Expected final log line:**

```
[bootstrap] Node successfully bootstrapped to revision 1
```

**Verify from the control plane:**

```bash
# Confirm node is active
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"enrollment\"}}" \
  --query 'Item.status.S' --output text
# Expected: active

# Confirm heartbeat received
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"heartbeat\"}}" \
  --output json | python3 -c "
import sys,json; item=json.load(sys.stdin)['Item']
print('bootstrapStatus:', item['bootstrapStatus']['S'])
print('revision:', item['revision']['S'])
"
# Expected: bootstrapStatus: healthy
```

For full bootstrap details and troubleshooting see `docs/recovery-runbook.md`.

---

## Backup checks

Run from your local machine at any time to confirm the backup pipeline is
healthy.

### Check the CloudWatch alarm state

```bash
aws cloudwatch describe-alarms \
  --alarm-names gateway-db-backup-missing \
  --query 'MetricAlarms[0].StateValue' --output text
# Expected: OK
# ALARM means no successful backup in the last 25 hours
```

### Check the latest backup pointer in S3

```bash
export ARTIFACT_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name GatewayNodeBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" \
  --output text)

aws s3 cp "s3://${ARTIFACT_BUCKET}/backups/postgres/latest.json" - | python3 -m json.tool
# Shows the S3 prefix, timestamp, and size of the most recent backup
```

### Check the backup journal on the node

```bash
# On the node:
journalctl -u gateway-db-backup --since "24 hours ago"
# Look for: [db-backup] Backup complete
```

If the alarm is in `ALARM` state or the latest.json is missing, treat it as an
escalation event — see [Failure escalation](#failure-escalation).

For backup setup details (cron timer, environment variables, SNS subscription)
see `docs/db-backup-restore.md` §Running the backup job.

---

## Restore drill

Run periodically (at minimum monthly) to prove the restore path works.

```bash
# On the node (or a dedicated drill host with access to S3 and a test DB):
export BACKUP_KMS_KEY_ID="arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
export BACKUP_S3_BUCKET="REPLACE_WITH_ARTIFACT_BUCKET_NAME"

# SOURCE database (read from)
export PGHOST="localhost"
export PGDATABASE="gateway"
export PGUSER="gateway_backup_user"
export PGPASSWORD="REPLACE_FROM_SECRETS_MANAGER"

# TARGET database (written to — use a separate schema/DB to avoid clobbering live data)
export RESTORE_PGDATABASE="gateway_restore_test"
export RESTORE_PGUSER="postgres"
export RESTORE_PGPASSWORD="REPLACE_WITH_SUPERUSER_PASSWORD"

cd /opt/gateway/agent
node dist/db-restore-drill.js
```

**Expected output:**

```
[drill] DRILL PASSED in N ms total (backup: N ms, restore: N ms)
```

Capture the printed JSON report as drill evidence.  A `verificationPassed:
true` result confirms the full backup → encrypt → upload → download → decrypt →
restore → verify cycle is working end-to-end.

For full restore details and troubleshooting see `docs/db-backup-restore.md`.

---

## Node revocation

To prevent a compromised or decommissioned node from fetching manifests:

```bash
aws dynamodb update-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"enrollment\"}}" \
  --update-expression 'SET #s = :revoked, lastUpdated = :now' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values \
    "{\":revoked\":{\"S\":\"revoked\"},\":now\":{\"S\":\"$(date -u +%FT%TZ)\"}}"
```

Then terminate the EC2 instance.  Its IAM instance profile cannot be
transferred, so revocation is immediate once the instance is stopped.

---

## Failure escalation

Use this table to decide how urgently to respond to a failure, and what to do
first.

| Failure | Severity | First action |
|---|---|---|
| Backup alarm in `ALARM` state | High — data loss risk if the node is lost | Check node backup journal; re-run `node dist/db-backup.js` manually; confirm `latest.json` updated |
| Enrollment token expired before use | Low | Re-issue via `POST /v1/enroll`; re-run the agent |
| `POST /activate` returns 401 | Low | Verify token was copied verbatim; re-issue |
| Docker installation fails (no internet) | Medium | Confirm security-group allows egress port 443; pre-install Docker CE on the AMI or user-data |
| Health checks fail after bootstrap | Medium | Wait 60 s and re-run agent (idempotent); check `docker compose logs`; verify secrets exist in Secrets Manager |
| Control plane stack not deployed | Critical | Run `docs/aws-setup.md` first; CDK deploy required before any enrollment |
| Restore drill `verificationPassed: false` | High — backup integrity compromised | Do not use that backup; select an earlier `RESTORE_S3_PREFIX`; investigate the dump integrity failure |
| Node reports `bootstrapStatus: failed` | High | Check `/var/log/gateway-bootstrap.log`; resolve the blocking error; re-run agent |

### Escalation contacts

> Store real contacts in your encrypted ops notes, not here.
>
> Placeholder: On-call engineer → `#gateway-ops` Slack channel →
> incident lead defined in your incident management system.

---

## Related documents

- [`docs/recovery-runbook.md`](recovery-runbook.md) — full step-by-step fresh-node
  bootstrap guide with timing estimates
- [`docs/db-backup-restore.md`](db-backup-restore.md) — backup job setup,
  manual restore procedure, and restore drill
- [`docs/aws-setup.md`](aws-setup.md) — CDK stack deployment and IAM setup
- [`docs/enrollment-trust-model.md`](enrollment-trust-model.md) — trust
  boundaries and secret-handling design
- [`docs/weekly-checklist.md`](weekly-checklist.md) — weekly execution checklist
- [`docs/coach-summary.md`](coach-summary.md) — coach-facing project status format
