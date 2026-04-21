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

- [ ] Control-service HTTP endpoint: `POST /enroll` — issues a signed
      enrollment token for a given instance-id
- [ ] Control-service HTTP endpoint: `POST /activate` — validates the token
      and returns the manifest S3 URI
- [ ] Node agent: implement `apt-get` package installation with idempotency
      checks (skip already-installed packages)
- [ ] Node agent: implement Docker Compose bundle apply with SHA-256
      verification
- [ ] Node agent: implement health check runner (HTTP and compose-service
      checks at minimum)
- [ ] Node agent: write `last-applied-revision` file after successful
      bootstrap so re-runs are idempotent
- [ ] End-to-end test: stand up a local Ubuntu container and run the agent
      against a sample manifest; verify health checks pass within 60 minutes

### Phase 2 — Drift detection

- [ ] Cron job or EventBridge rule on the control service that periodically
      compares a node's `last-applied-revision` (from DynamoDB) against the
      current manifest revision
- [ ] Alert (SNS or PagerDuty) when a node's revision is stale beyond a
      configurable threshold
- [ ] Node agent: expose `GET /status` endpoint returning current revision and
      health check results

### Phase 3 — Hardening and observability

- [ ] CloudWatch metrics: bootstrap duration, health check pass/fail counts
- [ ] OCI image digest pinning enforced at bootstrap time (reject manifests
      with mutable tags)
- [ ] Enrollment token revocation endpoint
- [ ] Runbook: how to recover a node from scratch using this system

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

See `docs/enrollment-trust-model.md` for the full trust model.  Short form:

1. Operator calls `POST /enroll` → receives a short-lived, KMS-signed token
2. Token is passed to the node (e.g. via EC2 user-data or secure channel)
3. Node agent calls `POST /activate` → receives manifest URI, begins bootstrap

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
