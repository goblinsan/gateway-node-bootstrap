import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { NodeManifest } from '@gateway-node-bootstrap/manifest-types';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const SSM_MANIFEST_PARAM = '/gateway/bootstrap/manifest-s3-uri';
const SUPPORTED_MANIFEST_VERSIONS: NodeManifest['manifestVersion'][] = ['1'];

/**
 * Returns the control service base URL from the environment, or undefined if
 * not configured.  Trailing slashes are stripped.
 */
function getControlServiceUrl(): string | undefined {
  return process.env.GATEWAY_CONTROL_SERVICE_URL?.replace(/\/$/, '');
}

/**
 * Derives the EC2 instance ID.  Prefers the GATEWAY_INSTANCE_ID environment
 * variable (useful in non-EC2 environments or tests).  Falls back to the
 * IMDSv2 metadata endpoint.  Returns undefined if neither is available.
 */
async function resolveInstanceId(): Promise<string | undefined> {
  if (process.env.GATEWAY_INSTANCE_ID) {
    return process.env.GATEWAY_INSTANCE_ID;
  }
  try {
    // IMDSv2: first obtain a session token, then fetch the instance-id
    const tokenResp = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(2000),
    });
    const imdsToken = await tokenResp.text();
    const idResp = await fetch(
      'http://169.254.169.254/latest/meta-data/instance-id',
      {
        headers: { 'X-aws-ec2-metadata-token': imdsToken },
        signal: AbortSignal.timeout(2000),
      }
    );
    return await idResp.text();
  } catch {
    return undefined;
  }
}

/**
 * Calls POST /activate on the control service to exchange an enrollment token
 * for the manifest S3 URI.  Returns the manifest URI on success.
 */
async function activateEnrollment(
  controlServiceUrl: string,
  instanceId: string,
  enrollmentToken: string
): Promise<string> {
  const resp = await fetch(`${controlServiceUrl}/v1/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, token: enrollmentToken }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`POST /activate failed (${resp.status}): ${body}`);
  }
  const data = (await resp.json()) as { manifestUri: string };
  return data.manifestUri;
}

/**
 * Reports a heartbeat to the control service.  Failures are logged but do not
 * abort the bootstrap process.
 */
async function reportHeartbeat(
  controlServiceUrl: string,
  instanceId: string,
  revision: string,
  bootstrapStatus: 'healthy' | 'degraded' | 'failed',
  healthCheckResults: Array<{ name: string; passed: boolean; detail?: string }>
): Promise<void> {
  try {
    const resp = await fetch(`${controlServiceUrl}/v1/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId,
        revision,
        bootstrapStatus,
        healthChecks: healthCheckResults,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(`[bootstrap] Heartbeat rejected (${resp.status}): ${body}`);
    } else {
      console.log(`[bootstrap] Heartbeat accepted (status=${bootstrapStatus})`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bootstrap] Failed to send heartbeat: ${msg}`);
  }
}

/** Fetches the manifest S3 URI from SSM Parameter Store (direct-access path). */
async function resolveManifestUriFromSsm(): Promise<string> {
  const ssm = new SSMClient({});
  const resp = await ssm.send(
    new GetParameterCommand({ Name: SSM_MANIFEST_PARAM })
  );
  const uri = resp.Parameter?.Value;
  if (!uri) {
    throw new Error(`SSM parameter ${SSM_MANIFEST_PARAM} is empty or missing`);
  }
  return uri;
}

/** Downloads an object from S3 and returns its body as a Buffer. */
async function fetchFromS3(s3Uri: string): Promise<Buffer> {
  const url = new URL(s3Uri);
  const bucket = url.hostname;
  const key = url.pathname.slice(1); // strip leading "/"
  const s3 = new S3Client({});
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) {
    throw new Error(`Empty response body for S3 object: ${s3Uri}`);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Verifies a buffer against an expected SHA-256 hex digest. */
function verifySha256(buf: Buffer, expected: string, label: string): void {
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`
    );
  }
}

/** Installs system packages listed in the manifest. */
function installPackages(packages: NodeManifest['runtimePackages']): void {
  if (packages.length === 0) return;
  const names = packages.map((p) => p.name).join(' ');
  console.log(`[bootstrap] Installing packages: ${names}`);
  execSync(`apt-get install -y ${names}`, { stdio: 'inherit' });
}

/** Downloads and applies a Docker Compose bundle. */
async function applyComposeBundle(
  bundle: NodeManifest['composeBundles'][number]
): Promise<void> {
  console.log(`[bootstrap] Applying compose bundle: ${bundle.name}`);
  const raw = await fetchFromS3(bundle.sourceUri);
  verifySha256(raw, bundle.sha256, `compose bundle '${bundle.name}'`);

  const dir = `/opt/gateway/compose/${bundle.name}`;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(dest, raw);
  execSync(`docker compose -f ${dest} up -d --remove-orphans`, {
    stdio: 'inherit',
  });
}

/** Downloads and enables a systemd unit. */
async function applySystemdUnit(
  unit: NodeManifest['systemdUnits'][number]
): Promise<void> {
  console.log(`[bootstrap] Installing systemd unit: ${unit.unitName}`);
  const raw = await fetchFromS3(unit.sourceUri);
  verifySha256(raw, unit.sha256, `systemd unit '${unit.unitName}'`);

  const dest = `/etc/systemd/system/${unit.unitName}`;
  fs.writeFileSync(dest, raw);
  execSync(`systemctl daemon-reload && systemctl enable --now ${unit.unitName}`, {
    stdio: 'inherit',
  });
}

/** Runs health checks and returns a list of failures. */
async function runHealthChecks(
  checks: NodeManifest['healthChecks']
): Promise<string[]> {
  const failures: string[] = [];
  for (const check of checks) {
    try {
      switch (check.type) {
        case 'http': {
          const timeout = (check.timeoutSeconds ?? 5) * 1000;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const resp = await fetch(check.url, { signal: controller.signal });
            const expected = check.expectedStatus ?? 200;
            if (resp.status !== expected) {
              failures.push(
                `HTTP check ${check.url} returned ${resp.status}, expected ${expected}`
              );
            }
          } finally {
            clearTimeout(timer);
          }
          break;
        }
        case 'tcp': {
          // Use netcat as a simple TCP probe
          execSync(
            `nc -z -w ${check.timeoutSeconds ?? 5} ${check.host} ${check.port}`
          );
          break;
        }
        case 'compose-service': {
          const result = execSync(
            `docker compose -f /opt/gateway/compose/${check.bundle}/docker-compose.yml ps --services --filter status=running`,
            { encoding: 'utf-8' }
          );
          if (!result.split('\n').includes(check.service)) {
            failures.push(
              `Compose service ${check.bundle}/${check.service} is not running`
            );
          }
          break;
        }
        case 'systemd-unit': {
          execSync(`systemctl is-active --quiet ${check.unitName}`);
          break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`Health check failed (${check.type}): ${msg}`);
    }
  }
  return failures;
}

/** Main bootstrap entrypoint. */
export async function bootstrap(): Promise<void> {
  console.log('[bootstrap] Starting gateway-node bootstrap agent');

  const controlServiceUrl = getControlServiceUrl();
  const enrollmentToken = process.env.GATEWAY_ENROLLMENT_TOKEN;

  // 1. Resolve the manifest URI.
  //    If an enrollment token is provided, activate through the control service.
  //    Otherwise fall back to reading the SSM parameter directly.
  let manifestUri: string;
  let instanceId: string | undefined;

  if (enrollmentToken && controlServiceUrl) {
    instanceId = await resolveInstanceId();
    if (!instanceId) {
      throw new Error(
        'GATEWAY_ENROLLMENT_TOKEN is set but instance ID could not be determined. ' +
          'Set GATEWAY_INSTANCE_ID or run on an EC2 instance with IMDS enabled.'
      );
    }
    console.log(`[bootstrap] Activating enrollment for instance ${instanceId}`);
    manifestUri = await activateEnrollment(controlServiceUrl, instanceId, enrollmentToken);
    console.log(`[bootstrap] Activation successful. Manifest URI: ${manifestUri}`);
  } else {
    console.log('[bootstrap] No enrollment token provided; reading manifest URI from SSM');
    manifestUri = await resolveManifestUriFromSsm();
    console.log(`[bootstrap] Manifest URI: ${manifestUri}`);
    // Attempt to derive the instance ID for heartbeat reporting even without enrollment
    if (controlServiceUrl) {
      instanceId = await resolveInstanceId();
    }
  }

  // 2. Download and parse manifest
  const raw = await fetchFromS3(manifestUri);
  const manifest: NodeManifest = JSON.parse(raw.toString('utf-8'));

  // 3. Validate manifest version
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.manifestVersion)) {
    throw new Error(
      `Unsupported manifest version: ${manifest.manifestVersion}. ` +
        `Supported: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}`
    );
  }

  console.log(
    `[bootstrap] Applying manifest: role=${manifest.role} ` +
      `profile="${manifest.profileName}" revision=${manifest.revision}`
  );

  // 4. Install runtime packages
  installPackages(manifest.runtimePackages);

  // 5. Apply compose bundles
  for (const bundle of manifest.composeBundles) {
    await applyComposeBundle(bundle);
  }

  // 6. Apply systemd units
  for (const unit of manifest.systemdUnits) {
    await applySystemdUnit(unit);
  }

  // 7. Run health checks
  const failures = await runHealthChecks(manifest.healthChecks);

  // 8. Report heartbeat if the control service is configured
  if (controlServiceUrl && instanceId) {
    const healthCheckResults = manifest.healthChecks.map((check, i) => ({
      name: `${check.type}-${i}`,
      passed: !failures.some((f) => f.includes(check.type)),
    }));
    await reportHeartbeat(
      controlServiceUrl,
      instanceId,
      manifest.revision,
      failures.length === 0 ? 'healthy' : 'degraded',
      healthCheckResults
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `[bootstrap] Bootstrap completed with health check failures:\n` +
        failures.map((f) => `  - ${f}`).join('\n')
    );
  }

  console.log(
    `[bootstrap] Node successfully bootstrapped to revision ${manifest.revision}`
  );
}
