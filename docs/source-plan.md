# Source Plan — gateway-node-bootstrap v1

## Definition of success

> A fresh gateway node can be bootstrapped to a known-good state in under one
> hour, and the process is documented well enough to delegate confidently to
> another engineer or to Copilot.

---

## Why this exists

Gateway nodes are currently recovered through operator memory and ad-hoc
shell commands.  When a node is lost or needs to be replaced, recovery time
depends on who is available and whether they remember the steps.  This
repository exists to make recovery a repeatable, auditable, and delegatable
operation.

The scope is deliberately narrow:

- **One node at a time.** No fleet management, no multi-region control plane.
- **AWS-native primitives only.** IAM, S3, SSM Parameter Store, Secrets
  Manager, DynamoDB, KMS.  No Kubernetes, Nomad, or custom scheduler.
- **Plain TypeScript.** Readable by engineers who are not infrastructure
  specialists.

---

## Repository structure

```
gateway-node-bootstrap/
├── packages/
│   ├── manifest-types/      # Shared TypeScript schema — NodeManifest
│   ├── control-service/     # AWS CDK app (infrastructure) + future HTTP API
│   └── node-agent/          # Node-side bootstrap agent
├── docs/
│   ├── enrollment-trust-model.md   # Trust boundaries, secret handling
│   └── source-plan.md              # This file
├── package.json             # npm workspaces root
└── README.md                # Local dev and deploy overview
```

---

## Implementation phases

### Phase 0 — Foundation (this PR) ✅

- [x] Create TypeScript npm workspace
- [x] Define `NodeManifest` schema (`packages/manifest-types`)
- [x] Scaffold AWS CDK stack with S3, DynamoDB, SSM, KMS, IAM (`packages/control-service`)
- [x] Scaffold node bootstrap agent (`packages/node-agent`)
- [x] Document enrollment trust model (`docs/enrollment-trust-model.md`)
- [x] Commit source plan (`docs/source-plan.md`)

### Phase 1 — Minimal viable recovery

- [x] Control-service HTTP endpoint: `POST /v1/enroll` — issues a single-use
      enrollment token for a given instance-id (stored as SHA-256 hash in DynamoDB)
- [x] Control-service HTTP endpoint: `POST /v1/activate` — validates the token
      and returns the manifest S3 URI; marks enrollment active (single-use)
- [x] Control-service HTTP endpoint: `GET /v1/manifest` — returns the current
      `NodeManifest` JSON for an actively enrolled node
- [x] Control-service HTTP endpoint: `POST /v1/heartbeat` — records the node's
      last-applied revision and bootstrap status in DynamoDB
- [x] API Gateway REST API (stage `v1`) wiring all four Lambda handlers
- [x] Node agent: enrollment flow via `GATEWAY_ENROLLMENT_TOKEN` +
      `GATEWAY_CONTROL_SERVICE_URL` environment variables
- [x] Node agent: heartbeat reporting after successful (or degraded) bootstrap
- [x] Operator docs: `docs/aws-setup.md` covering deploy, enrollment, revocation
- [x] Node agent: implement `apt-get` package installation with idempotency
      checks (skip already-installed packages; compare against `minVersion`)
- [x] Node agent: `provisionHost()` — installs Docker CE + docker-compose-plugin
      on Debian/Ubuntu hosts (apt-based); no-op on pre-installed or non-apt hosts
- [x] Node agent: secret resolution — fetches `ComposeBundle.secretRefs` from
      AWS Secrets Manager and writes a mode-0600 `.env` file per bundle
- [x] Node agent: pinned image pull — pulls each `ImageRef` before
      `docker compose up` so failures surface before containers start
- [x] Node agent: idempotent re-apply — persists last-applied revision in
      `/opt/gateway/.bootstrap-state.json`; diffs on re-run and reports changes

### Phase 2 — Drift detection

- [ ] Cron job or EventBridge rule on the control service that periodically
      compares a node's `last-applied-revision` (from DynamoDB) against the
      current manifest revision
- [ ] Alert (SNS or PagerDuty) when a node's revision is stale beyond a
      configurable threshold
- [ ] Node agent: expose `GET /status` endpoint returning current revision and
      health check results

### Phase 2 — Recovery drill (Issues #18–#21)

- [x] Define minimum viable recovered node profile
      (`docs/profiles/edge-gateway-minimal.json`) — demonstrates enrollment,
      secret retrieval, container startup, and health reporting
- [x] Node agent: pre-flight check — warns when not running as root and logs
      active environment configuration before touching anything
- [x] Node agent: manifest cross-reference validation — catches health checks
      that reference undefined compose bundles or systemd units before
      applying any changes
- [x] Node agent: security hardening — replaced shell-interpolated `execSync`
      calls with `execFileSync` for `systemctl` and `nc` to eliminate injection
      risk from manifest-supplied values
- [x] Recovery runbook: step-by-step fresh-node bootstrap guide
      (`docs/recovery-runbook.md`), including timing estimates and the top
      remaining manual gaps (Issues #19, #20, #21)

### Phase 3 — Drift detection

- [ ] Cron job or EventBridge rule on the control service that periodically
      compares a node's `last-applied-revision` (from DynamoDB) against the
      current manifest revision
- [ ] Alert (SNS or PagerDuty) when a node's revision is stale beyond a
      configurable threshold
- [ ] Node agent: expose `GET /status` endpoint returning current revision and
      health check results

### Phase 4 — Hardening and observability

- [ ] CloudWatch metrics: bootstrap duration, health check pass/fail counts
- [ ] OCI image digest pinning enforced at bootstrap time (reject manifests
      with mutable tags)
- [ ] Enrollment token revocation endpoint
- [ ] AMI or user-data automation for Node.js and agent installation
      (eliminates the largest manual gap from the recovery drill)

### Phase 5 — Encrypted backup and restore (Issues #23–#27) ✅

- [x] #23: Postgres schema and role model for sensitive state
      (`db/migrations/001_sensitive_state_schema.sql`)
      — `gateway_sensitive` schema, four least-privilege roles, application-layer
        AES-256-GCM encryption for sensitive fields, append-only `audit_log`
- [x] #24: Encrypted Postgres backup job (`packages/node-agent/src/db-backup.ts`)
      — `pg_dump → KMS GenerateDataKey → AES-256-GCM encrypt → S3 upload`
        with SSE-KMS, 90-day lifecycle, and CloudWatch metric emission
- [x] #25: Restore workflow (`packages/node-agent/src/db-restore.ts`,
      `docs/db-backup-restore.md`)
      — downloads from S3, KMS-decrypts DEK, AES-256-GCM decrypts dump,
        verifies SHA-256 integrity, runs pg_restore
- [x] #26: Backup monitoring and missing-backup alert
      — CloudWatch alarm `gateway-db-backup-missing` (treat-missing-data=BREACHING,
        25-hour window); SNS topic `gateway-db-backup-alerts`; CDK stack outputs
        `BackupAlertTopicArn`
- [x] #27: End-to-end restore drill (`packages/node-agent/src/db-restore-drill.ts`)
      — inserts canary row, takes real backup, restores into target DB, verifies
        canary row; reports timing and SHA-256 integrity

---

## Key contracts

### NodeManifest (schema version 1)

Defined in `packages/manifest-types/src/manifest.ts`.  See that file for
the full TypeScript definition.  The essential fields are:

| Field | Purpose |
|---|---|
| `manifestVersion` | Schema version — agent rejects unknown versions |
| `role` | Logical node role, e.g. `"edge-gateway"` |
| `revision` | Opaque token incremented on every manifest change |
| `runtimePackages` | System packages to install before services start |
| `composeBundles` | Docker Compose projects with SHA-256-verified sources |
| `systemdUnits` | Systemd unit files with SHA-256-verified sources |
| `healthChecks` | Checks that must pass for bootstrap to be declared successful |

### Enrollment flow

See `docs/enrollment-trust-model.md` and `docs/aws-setup.md` for the full
trust model and deployment steps.  Short form:

1. Operator calls `POST /v1/enroll` → receives a short-lived, single-use token
2. Token is passed to the node (e.g. via EC2 user-data or secure channel)
3. Node agent calls `POST /v1/activate` → receives manifest URI, begins bootstrap
4. Node agent reports `POST /v1/heartbeat` after bootstrap completes

---

## What this is NOT

- A replacement for `gateway-control-plane` deploy logic (v1 scope)
- A general-purpose package manager
- A multi-region failover control plane
- Anything requiring Kubernetes, Nomad, or a custom scheduler

---

## Delegation notes for Copilot

When working in this repository:

- `packages/manifest-types` is the shared contract; change it carefully and
  version any breaking changes.
- `packages/control-service` is a CDK app; run `npm run cdk -- diff` before
  deploying to review infrastructure changes.
- `packages/node-agent` runs on the node as root; keep it minimal, prefer
  explicit over implicit, and add SHA-256 verification for every downloaded
  artifact.
- Never commit secret values, private hostnames, or real IP addresses.
- Prefer AWS-managed primitives over self-managed equivalents.
