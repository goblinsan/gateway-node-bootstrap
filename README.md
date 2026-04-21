# gateway-node-bootstrap

A thin bootstrap foundation that makes gateway-node recovery repeatable
without dragging the broader system into a large platform rewrite.

**v1 goal:** a fresh gateway node can be bootstrapped to a known-good state
in under one hour, and the process is documented well enough to delegate
confidently.

---

## Repository structure

```
gateway-node-bootstrap/
├── packages/
│   ├── manifest-types/      # Shared TypeScript schema — NodeManifest
│   ├── control-service/     # AWS CDK infrastructure app
│   └── node-agent/          # Node-side bootstrap agent
├── docs/
│   ├── enrollment-trust-model.md   # Trust model, secret handling
│   └── source-plan.md              # Implementation phases and key contracts
├── package.json             # npm workspaces root
└── README.md
```

---

## Local development

### Prerequisites

- Node.js ≥ 20
- npm ≥ 10
- AWS CLI configured (for CDK commands)

### Install dependencies

```bash
npm install
```

### Build all packages

```bash
npm run build
```

### Lint

```bash
npm run lint
```

---

## Deploying the CDK stack

```bash
cd packages/control-service
npm run cdk -- bootstrap   # first time only, per account/region
npm run cdk -- diff        # review planned changes
npm run cdk -- deploy
```

The stack provisions:

| Resource | Purpose |
|---|---|
| S3 bucket | Stores compose bundles, unit files, and manifest snapshots |
| DynamoDB table | Records node enrollment state, heartbeat, and applied revisions |
| SSM Parameter | Holds the S3 URI of the current desired-state manifest |
| KMS key | Encrypts all resources; used to protect enrollment secrets |
| Secrets Manager secret | Placeholder demonstrating the `SecretRef` naming convention |
| IAM role `gateway-node-agent` | Assumed by nodes; grants minimal read access |
| Lambda × 4 | `enroll`, `activate`, `manifest`, `heartbeat` handlers |
| API Gateway | REST API at `https://<id>.execute-api.<region>.amazonaws.com/v1/` |

See [`docs/aws-setup.md`](docs/aws-setup.md) for the complete operator guide,
including how to upload the initial manifest and manage enrollment tokens.

---

## Control service API

| Method | Path | Actor | Description |
|---|---|---|---|
| `POST` | `/v1/enroll` | Operator | Creates a pending enrollment and returns a 60-minute single-use token |
| `POST` | `/v1/activate` | Node agent | Validates token, marks node active, returns manifest S3 URI |
| `GET` | `/v1/manifest?instanceId=…` | Node agent | Returns the current `NodeManifest` JSON for an enrolled node |
| `POST` | `/v1/heartbeat` | Node agent | Records last-applied revision and bootstrap status |

---

## Running the node agent

The node agent is intended to run on the gateway node itself (as root) with
the `gateway-node-agent` IAM instance profile attached.

```bash
cd packages/node-agent
npm run build
sudo node dist/index.js
```

### With enrollment token (recommended for new nodes)

```bash
export GATEWAY_CONTROL_SERVICE_URL="https://<id>.execute-api.<region>.amazonaws.com"
export GATEWAY_ENROLLMENT_TOKEN="<token from POST /v1/enroll>"
sudo -E node dist/index.js
```

### Direct SSM mode (no enrollment token)

```bash
sudo node dist/index.js   # reads manifest URI from SSM directly
```

The agent:

1. Reads the manifest S3 URI from SSM Parameter Store
2. Downloads and parses the `NodeManifest` JSON
3. Installs required system packages
4. Applies Docker Compose bundles (with SHA-256 verification)
5. Installs and enables systemd units (with SHA-256 verification)
6. Runs all declared health checks
7. Exits 0 on success, 1 on any failure

---

## Key documents

- [`docs/aws-setup.md`](docs/aws-setup.md) — operator guide: deploying the
  stack, uploading manifests, enrolling nodes, and revoking access.
- [`docs/enrollment-trust-model.md`](docs/enrollment-trust-model.md) — how
  nodes prove they are allowed to enroll, how secrets are retrieved, and how
  a compromised node is contained.
- [`docs/source-plan.md`](docs/source-plan.md) — the full implementation
  plan, phased roadmap, and delegation notes for Copilot.

---

## Design constraints

- Optimize for one-node recovery first.
- Plain, legible TypeScript and AWS-native primitives only.
- No private topology or secrets in the repo.
- No Kubernetes, Nomad, or custom scheduler in v1.
