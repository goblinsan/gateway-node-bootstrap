# Enrollment Trust Model

## Purpose

This document defines the trust boundaries for gateway-node enrollment and
bootstrap.  It describes what each party must prove, how credentials flow,
and how a compromised node is contained.  All examples are abstract; no
private hostnames, IP addresses, credentials, or recovery details are
included.

---

## Actors

| Actor | Description |
|---|---|
| **Operator** | Human or CI process that triggers an enrollment or recovery |
| **Control service** | AWS-hosted API that issues enrollment tokens and holds desired-state manifests |
| **Node agent** | Process running on the gateway node that applies the manifest |
| **AWS primitives** | IAM, SSM Parameter Store, Secrets Manager, KMS, S3 |

---

## How a fresh node proves it is allowed to enroll

1. **Instance-level identity** — The node must run on an EC2 instance that
   carries the `gateway-node-agent` IAM instance profile (see
   `packages/control-service/src/stacks/bootstrap-stack.ts`).  The instance
   profile is the first layer of trust: only instances launched by the
   authorized account into the authorized launch template receive it.

2. **Enrollment token** — Before bootstrap begins, the operator (or an
   automated pipeline) calls the control-service enrollment endpoint and
   receives a short-lived, single-use token.  The token is:
   - signed with the bootstrap KMS key (HMAC-SHA256 or KMS asymmetric sign)
   - scoped to the requesting node's EC2 instance-id
   - valid for a configurable short window (default: 60 minutes)
   - stored as a pending record in the DynamoDB enrollment table

3. **Agent token presentation** — The node agent presents the token to the
   control service alongside its EC2 instance-id metadata.  The control
   service verifies the signature and marks the enrollment record `active`.
   The token is immediately invalidated after first use.

---

## How short-lived tokens or signed enrollment links are issued

```
Operator  ──POST /enroll──►  Control Service
                              │
                              ├─ verify caller has iam:PassRole on node-agent role
                              ├─ create enrollment record in DynamoDB (status=pending)
                              ├─ sign {instanceId, expiry} with KMS
                              └─ return signed token (TTL ≤ 60 min)

Node Agent  ──POST /activate──►  Control Service
                                  │
                                  ├─ verify KMS signature
                                  ├─ check instanceId matches EC2 IMDS
                                  ├─ check token not expired and not already used
                                  ├─ mark enrollment record active
                                  └─ return manifest S3 URI (or node reads SSM directly)
```

The token is never stored on disk on the node; it is consumed in memory
during the activation call.

---

## How secrets are retrieved without committing them to git

The `NodeManifest` schema (see `packages/manifest-types/src/manifest.ts`)
uses `SecretRef` values — AWS Secrets Manager paths such as
`/gateway/prod/api-key` — rather than literal secret values.

At runtime the node agent:

1. Reads the secret names from the manifest's `secretRefs` arrays.
2. Calls `secretsmanager:GetSecretValue` using the `gateway-node-agent` IAM
   role (authorized by the bootstrap KMS key grant).
3. Injects the values into environment variables or a runtime-only secrets
   directory with mode `0600`, owned by the service user.
4. Secret values are never written to disk in plaintext beyond the runtime
   secrets directory, which is mounted as `tmpfs` where the OS supports it.

No secret values appear in:
- the git repository
- S3 manifest objects
- DynamoDB enrollment records
- CloudWatch Logs (log filtering strips patterns matching known secret name prefixes)

---

## How compromise of a node is contained

| Containment layer | Mechanism |
|---|---|
| **Token single-use** | Enrollment tokens are consumed on first use; a stolen token cannot re-enroll |
| **IAM scope** | `gateway-node-agent` role can only read artifacts and its own secrets; it cannot write to S3, update DynamoDB, or call IAM |
| **Resource tags** | The role's `secretsmanager:GetSecretValue` is restricted to secrets tagged `gateway:node-agent=true`; it cannot read control-plane secrets |
| **KMS grant** | The node role can only `Decrypt` and `GenerateDataKey`; it cannot manage the key or view key metadata |
| **Enrollment revocation** | The operator updates the DynamoDB record to `status=revoked`; the control service rejects all future activation attempts from that instance-id |
| **Node isolation** | The compromised instance is terminated via EC2; its instance profile cannot be transferred to another instance |
| **Audit trail** | All IAM calls are logged in CloudTrail; all enrollment state changes are recorded in DynamoDB with a `lastUpdated` timestamp |

---

## What data belongs where

| Store | What goes there | What must NOT go there |
|---|---|---|
| **DynamoDB** | Enrollment records, node status, last-applied manifest revision | Secret values, private keys |
| **S3** | Compose bundles, systemd unit files, manifest JSON snapshots | Secret values, private TLS certificates |
| **SSM Parameter Store** | Manifest S3 URI pointer, non-secret configuration strings | Secret values (use Secrets Manager for those) |
| **Secrets Manager** | All runtime secrets referenced by `SecretRef` in the manifest | Anything that belongs in the manifest (structural config belongs in S3) |
| **KMS** | Encryption keys only — managed by AWS | Key material in plaintext (KMS manages this) |
| **Git** | Schema types, CDK infrastructure code, agent source, documentation | Secret values, private hostnames, credentials |

---

## Threat model summary (v1 scope)

| Threat | Mitigation |
|---|---|
| Unauthorized node enrollment | Instance profile + short-lived signed token required |
| Token replay | Single-use tokens, short TTL, instance-id binding |
| Manifest tampering | SHA-256 verification of every artifact before application |
| Secret leakage via logs | Log filtering; no secret values in manifests or DynamoDB |
| Stolen node credentials | IAM scope limits blast radius; revocation removes all access |
| Supply-chain compromise of images | OCI digest pinning in manifest (`ImageRef`) |

This model is intentionally conservative for v1 (single-node recovery).
Multi-node attestation, hardware TPM binding, or SPIFFE/SPIRE integration
are explicitly out of scope until the single-node path is proven.
