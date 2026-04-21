# AWS Setup — Operator Guide

This document covers the AWS resources provisioned by the CDK stack, the IAM
roles required, the enrollment workflow, and the manual steps needed after the
initial deployment.  All examples use placeholder values; never commit real
account IDs, secret names, or private IP addresses.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| AWS account | A dedicated account or sub-account is recommended |
| AWS CLI ≥ 2.x | Configured with credentials that have `AdministratorAccess` or the minimal deploy policy described below |
| Node.js ≥ 20 | Required to run CDK |
| CDK bootstrapped | Run `cdk bootstrap` once per account/region before the first deploy |

---

## Deploying the stack

```bash
cd packages/control-service

# First time only — bootstraps the CDK toolkit resources in your account
npm run cdk -- bootstrap aws://<ACCOUNT_ID>/<REGION>

# Review planned changes without deploying
npm run cdk -- diff

# Deploy
npm run cdk -- deploy
```

After deployment the CDK output prints the key resource identifiers:

```
Outputs:
GatewayNodeBootstrap.ArtifactBucketName    = gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>
GatewayNodeBootstrap.EnrollmentTableName   = gateway-node-enrollment
GatewayNodeBootstrap.NodeAgentRoleArn      = arn:aws:iam::<ACCOUNT>:role/gateway-node-agent
GatewayNodeBootstrap.ControlServiceApiUrl  = https://<API_ID>.execute-api.<REGION>.amazonaws.com/v1/
```

Save the `ControlServiceApiUrl` — nodes need it to complete enrollment.

---

## AWS resources provisioned

| Resource | Name / Pattern | Purpose |
|---|---|---|
| KMS key | (auto-generated) | Encrypts S3 objects, DynamoDB table, and Secrets Manager secrets |
| S3 bucket | `gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>` | Stores compose bundles, systemd units, and manifest JSON |
| DynamoDB table | `gateway-node-enrollment` | Enrollment records, heartbeat state, last-applied revision |
| SSM Parameter | `/gateway/bootstrap/manifest-s3-uri` | S3 URI of the current desired-state manifest |
| Secrets Manager secret | `/gateway/bootstrap/example-node-secret` | Placeholder — replace with real node secrets using the `/gateway/…` prefix |
| IAM role | `gateway-node-agent` | Instance profile role for EC2 nodes; grants minimal read access |
| Lambda × 4 | `EnrollFunction`, `ActivateFunction`, `ManifestFunction`, `HeartbeatFunction` | Control-service API handlers |
| API Gateway | `gateway-node-bootstrap-api` (stage `v1`) | REST API exposing the four endpoints |

---

## Required IAM permissions for deployment

The IAM principal used to run `cdk deploy` needs, at minimum:

- `cloudformation:*` on the stack
- `iam:*` (to create roles and instance profiles)
- `s3:*` on the artifact bucket and the CDK staging bucket
- `kms:*`
- `dynamodb:*`
- `ssm:PutParameter`, `ssm:GetParameter`
- `secretsmanager:CreateSecret`, `secretsmanager:PutSecretValue`
- `lambda:*`
- `apigateway:*`
- `logs:*` (CloudWatch Logs for Lambda)

Using `AdministratorAccess` is acceptable for initial setup.  Scope it down
after the first successful deploy.

---

## Uploading the initial manifest

After deploying, upload a `NodeManifest` JSON to the S3 bucket so nodes have
something to fetch:

```bash
# Replace placeholders with real values
aws s3 cp /path/to/current.json \
  s3://gateway-node-bootstrap-artifacts-<ACCOUNT>-<REGION>/manifests/current.json
```

The `NodeManifest` schema is defined in
`packages/manifest-types/src/manifest.ts`.  A minimal example:

```json
{
  "manifestVersion": "1",
  "role": "edge-gateway",
  "profileName": "Example profile",
  "revision": "1",
  "runtimePackages": [],
  "composeBundles": [],
  "systemdUnits": [],
  "healthChecks": []
}
```

---

## Enrollment workflow

### Step 1 — Enroll a node (operator action)

Call `POST /v1/enroll` with the EC2 instance ID of the node you want to
bootstrap.  You must have AWS credentials that allow calling the API (or use an
API key / IAM auth if you add it later).

```bash
CONTROL_SERVICE_URL="https://<API_ID>.execute-api.<REGION>.amazonaws.com"

curl -s -X POST "${CONTROL_SERVICE_URL}/v1/enroll" \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "i-0abc123def456", "profileId": "edge-gateway"}'
```

Response:

```json
{ "token": "<64-char hex token>", "expiresAt": "2026-04-21T02:00:00.000Z" }
```

The token is valid for **60 minutes**.  Pass it to the node securely (e.g.
via EC2 user-data, AWS Systems Manager Run Command, or a one-time secrets
channel).

### Step 2 — Activate enrollment (node action)

The node agent activates automatically when `GATEWAY_ENROLLMENT_TOKEN` and
`GATEWAY_CONTROL_SERVICE_URL` are set in the environment:

```bash
export GATEWAY_CONTROL_SERVICE_URL="https://<API_ID>.execute-api.<REGION>.amazonaws.com"
export GATEWAY_ENROLLMENT_TOKEN="<token from step 1>"
# GATEWAY_INSTANCE_ID is optional — derived from IMDS if omitted
sudo -E node dist/index.js
```

The agent will:
1. Call `POST /v1/activate` to validate the token and receive the manifest URI
2. Download and apply the manifest
3. Report a heartbeat to `POST /v1/heartbeat`

### Step 3 — Verify enrollment

Check the DynamoDB table to confirm the node is active:

```bash
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key '{"nodeId":{"S":"i-0abc123def456"},"sk":{"S":"enrollment"}}' \
  --output json
```

The `status` field should be `"active"`.

---

## Revoking a node

To prevent a compromised or decommissioned node from requesting manifests:

```bash
aws dynamodb update-item \
  --table-name gateway-node-enrollment \
  --key '{"nodeId":{"S":"i-0abc123def456"},"sk":{"S":"enrollment"}}' \
  --update-expression 'SET #s = :revoked, lastUpdated = :now' \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":revoked":{"S":"revoked"},":now":{"S":"'"$(date -u +%FT%TZ)"'"}}'
```

Then terminate the EC2 instance.  Its instance profile cannot be transferred.

---

## Environment variables for the node agent

| Variable | Required | Description |
|---|---|---|
| `GATEWAY_CONTROL_SERVICE_URL` | Optional | Base URL of the control service API (e.g. `https://<id>.execute-api.<region>.amazonaws.com`) |
| `GATEWAY_ENROLLMENT_TOKEN` | Optional | Short-lived enrollment token issued by `POST /v1/enroll` |
| `GATEWAY_INSTANCE_ID` | Optional | Override for EC2 instance ID (defaults to IMDS lookup) |

If `GATEWAY_ENROLLMENT_TOKEN` is **not** set, the agent reads the manifest URI
directly from SSM Parameter Store (requires the `gateway-node-agent` IAM role).

---

## Adding real node secrets

Replace the placeholder secret with your actual node secrets using the
`/gateway/…` naming prefix so the `gateway-node-agent` IAM role can read them:

```bash
aws secretsmanager create-secret \
  --name "/gateway/production/vpn-psk" \
  --secret-string "REPLACE_WITH_REAL_VALUE"
```

Reference the secret in your manifest's `secretRefs` array:

```json
"secretRefs": ["/gateway/production/vpn-psk"]
```

---

## What must NOT be committed to git

- Real account IDs, bucket names, or ARNs (use CDK tokens like `this.account`)
- Secret values, VPN pre-shared keys, TLS private keys
- Private hostnames or IP addresses
- Any file that contains real credentials

See `docs/enrollment-trust-model.md` for the full trust boundary model.
