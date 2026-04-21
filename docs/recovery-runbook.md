# Gateway-Node Recovery Runbook

**Goal:** Bootstrap a fresh gateway node to a known-good state in under one hour.

This runbook covers the complete end-to-end path: from a blank EC2 instance to a
fully enrolled, running, and health-reporting node.  It is written to be followed
by an engineer with AWS Console/CLI access who has never done this before.

---

## Pre-flight checklist

Before you touch the new node, verify that the control plane is already deployed:

| Check | Command | Expected |
|---|---|---|
| CDK stack deployed | `aws cloudformation describe-stacks --stack-name GatewayNodeBootstrap --query 'Stacks[0].StackStatus'` | `"UPDATE_COMPLETE"` or `"CREATE_COMPLETE"` |
| API URL available | `aws cloudformation describe-stacks --stack-name GatewayNodeBootstrap --query 'Stacks[0].Outputs'` | `ControlServiceApiUrl` present |
| Manifest uploaded to S3 | `aws s3 ls s3://BUCKET/manifests/current.json` | file listed |
| SSM parameter set | `aws ssm get-parameter --name /gateway/bootstrap/manifest-s3-uri` | URI matches the S3 path above |
| Node has instance profile | EC2 Console → Instance → Security → IAM role | `gateway-node-agent` attached |

**If the CDK stack is not deployed**, run `docs/aws-setup.md` first, then return here.

---

## Phase 1 — Enroll the node (operator, ~5 min)

Run these commands from your local machine (not the node itself).

### 1.1 Export the API base URL

```bash
export CONTROL_SERVICE_URL=$(aws cloudformation describe-stacks \
  --stack-name GatewayNodeBootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='ControlServiceApiUrl'].OutputValue" \
  --output text | sed 's|/$||')
echo "Control service: $CONTROL_SERVICE_URL"
```

### 1.2 Get the EC2 instance ID

```bash
# Replace with the actual new instance ID
export INSTANCE_ID="i-0abc123def456"
```

Or look it up:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=gateway-node" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" --output text
```

### 1.3 Issue the enrollment token

```bash
ENROLL_RESPONSE=$(curl -s -X POST "${CONTROL_SERVICE_URL}/v1/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"instanceId\": \"${INSTANCE_ID}\", \"profileId\": \"edge-gateway\"}")

echo "$ENROLL_RESPONSE"
# Expected: { "token": "<64-char hex>", "expiresAt": "..." }

export ENROLLMENT_TOKEN=$(echo "$ENROLL_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "Token expires: $(echo "$ENROLL_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['expiresAt'])")"
```

The token is valid for **60 minutes**.  Proceed to Phase 2 without delay.

### 1.4 Verify the pending enrollment

```bash
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"enrollment\"}}" \
  --query 'Item.status.S' --output text
# Expected: pending
```

---

## Phase 2 — Bootstrap the node (node, ~30–45 min)

SSH into the new node and run these commands as root.

### 2.1 Install Node.js (if not present)

```bash
node --version 2>/dev/null || {
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}
node --version   # must be >= 20
```

### 2.2 Install git and clone the agent (or copy pre-built dist/)

**Option A — clone and build on-node (requires internet access):**

```bash
apt-get install -y git
git clone https://github.com/goblinsan/gateway-node-bootstrap.git /opt/gateway/agent
cd /opt/gateway/agent
npm install
npm run build --workspace packages/node-agent
```

**Option B — copy pre-built artifacts (air-gapped or faster):**

```bash
# From your local machine:
scp -r packages/node-agent/dist ubuntu@<NODE_IP>:/opt/gateway/agent/dist
scp packages/node-agent/package.json ubuntu@<NODE_IP>:/opt/gateway/agent/
```

### 2.3 Set environment variables

```bash
export GATEWAY_CONTROL_SERVICE_URL="https://<API_ID>.execute-api.<REGION>.amazonaws.com"
export GATEWAY_ENROLLMENT_TOKEN="<token from Phase 1.3>"
# If the instance ID cannot be read from IMDS, set it explicitly:
# export GATEWAY_INSTANCE_ID="i-0abc123def456"
```

### 2.4 Run the bootstrap agent

```bash
cd /opt/gateway/agent
sudo -E node dist/index.js 2>&1 | tee /var/log/gateway-bootstrap.log
```

The agent will:

1. Pre-flight: log environment and warn if not running as root
2. Activate enrollment via `POST /v1/activate`
3. Download and verify the manifest from S3
4. Provision Docker CE (if not already installed) — ~10–15 min on first run
5. Install runtime packages (e.g., `curl`, `netcat-openbsd`)
6. Pull container images and start Docker Compose services
7. Run health checks
8. Report heartbeat to `POST /v1/heartbeat`
9. Save state to `/opt/gateway/.bootstrap-state.json`

**Expected final log line:**

```
[bootstrap] Node successfully bootstrapped to revision 1
```

---

## Phase 3 — Verify from the control plane (~5 min)

### 3.1 Confirm active enrollment

```bash
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"enrollment\"}}" \
  --output json | python3 -c "
import sys,json
item = json.load(sys.stdin)['Item']
print('status:', item['status']['S'])
print('profileId:', item['profileId']['S'])
"
# Expected: status: active
```

### 3.2 Confirm heartbeat received

```bash
aws dynamodb get-item \
  --table-name gateway-node-enrollment \
  --key "{\"nodeId\":{\"S\":\"${INSTANCE_ID}\"},\"sk\":{\"S\":\"heartbeat\"}}" \
  --output json | python3 -c "
import sys,json
item = json.load(sys.stdin)['Item']
print('bootstrapStatus:', item['bootstrapStatus']['S'])
print('revision:',        item['revision']['S'])
print('lastHeartbeatAt:', item['lastHeartbeatAt']['S'])
"
# Expected: bootstrapStatus: healthy
```

### 3.3 Spot-check the service on the node

```bash
# On the node:
docker compose -f /opt/gateway/compose/gateway-core/docker-compose.yml ps
curl -s http://localhost:8080/health
```

---

## Troubleshooting

### Token expired before activation

Re-enroll: call `POST /v1/enroll` again with the same `instanceId`.
If the node has already been activated (status `active`), revoke first (see `docs/aws-setup.md`).

### `POST /activate` returns 401 / token invalid

- Confirm the token was copied verbatim (64 hex characters, no trailing newline).
- Check that `GATEWAY_ENROLLMENT_TOKEN` is exported, not just assigned.
- Re-issue a new token.

### Docker installation fails / no internet access

The `provisionHost()` step requires outbound HTTPS to `download.docker.com`.
Ensure the security group allows egress on port 443, or pre-install Docker CE before running the agent.

### `apt-get install` fails on non-Ubuntu host

`provisionHost()` and `installPackages()` use `apt-get`.  On non-Debian/Ubuntu
hosts you must pre-install Docker CE and any runtime packages listed in the manifest.
The agent will skip `provisionHost()` automatically on non-apt systems.

### Node.js not found on fresh node

The agent itself requires Node.js ≥ 20 to run.  This is a known manual step
(see Phase 2.1 above).  Future work: bake Node.js into the AMI or user-data.

### Health checks fail immediately after bootstrap

- Docker Compose services may still be starting.  Re-run the agent (it is idempotent).
- Check container logs: `docker compose -f /opt/gateway/compose/<bundle>/docker-compose.yml logs`
- Ensure secrets referenced in `secretRefs` exist in Secrets Manager with the `/gateway/…` prefix.

### State file already exists (re-run scenario)

The agent compares the incoming revision against the saved state.  If the revision
has not changed it still re-verifies desired state.  To force a full re-apply,
delete the state file: `rm /opt/gateway/.bootstrap-state.json`.

---

## Recovery time estimates

Based on a clean Debian/Ubuntu EC2 instance:

| Phase | Step | Typical time |
|---|---|---|
| Pre-flight | Verify control plane and S3 | 2–3 min |
| Phase 1 | Enroll node (operator) | 2–5 min |
| Phase 2 | Install Node.js (if absent) | 1–2 min |
| Phase 2 | Clone/copy agent | 1–3 min |
| Phase 2 | Docker CE installation (first run) | 10–15 min |
| Phase 2 | Runtime package installation | 1–3 min |
| Phase 2 | Image pull | 2–10 min (image-size dependent) |
| Phase 2 | Compose up + health checks | 1–3 min |
| Phase 3 | Control-plane verification | 2 min |
| **Total** | | **~22–46 min** |

A repeat run (node already has Docker + Node.js) is **under 10 minutes**.

---

## Known manual gaps (top bottlenecks)

The following steps are not yet automated and represent the largest remaining
time sinks during a recovery:

| Gap | Impact | Suggested fix |
|---|---|---|
| Node.js must be installed manually before the agent can run | 1–2 min + operator knowledge | Bake Node ≥ 20 into the AMI, or add a user-data script that installs it automatically |
| Agent code must be copied or cloned onto the node | 1–3 min | Publish the built agent as an S3 artifact and add a one-liner bootstrap script (e.g., `curl | bash` or Systems Manager Run Command) |
| Enrollment token must be passed to the node out-of-band | Manual coordination | Use EC2 user-data or Systems Manager Parameter Store to deliver the token at launch time |
| Container images must be reachable at bootstrap time | Blocks Phase 2 | Pre-pull images to a private ECR registry in the same region; update the manifest to reference ECR URIs |
| Secrets must be pre-created in Secrets Manager | Operator setup before first run | Add a CDK construct or script that seeds required secrets from a local `.env.example` |

These gaps are the primary drivers for the next round of work.  Address them in
priority order to reduce recovery time toward the sub-15-minute target.

---

## Related documents

- [`docs/aws-setup.md`](aws-setup.md) — deploying the CDK stack, uploading manifests,
  managing enrollment tokens
- [`docs/enrollment-trust-model.md`](enrollment-trust-model.md) — trust boundaries
  and secret-handling design
- [`docs/profiles/edge-gateway-minimal.json`](profiles/edge-gateway-minimal.json) —
  reference manifest for the minimum viable profile
- [`docs/source-plan.md`](source-plan.md) — implementation phases and roadmap
