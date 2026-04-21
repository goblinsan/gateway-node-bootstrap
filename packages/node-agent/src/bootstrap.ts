import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { NodeManifest } from '@gateway-node-bootstrap/manifest-types';
import { execSync, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const SSM_MANIFEST_PARAM = '/gateway/bootstrap/manifest-s3-uri';
const SUPPORTED_MANIFEST_VERSIONS: NodeManifest['manifestVersion'][] = ['1'];

/** Path to the on-disk state file that persists the last-applied manifest revision. */
const STATE_FILE = '/opt/gateway/.bootstrap-state.json';

/** Persisted record of the last successfully applied manifest. */
interface BootstrapState {
  revision: string;
  appliedAt: string;
  role: string;
  profileName: string;
  composeBundleNames: string[];
  systemdUnitNames: string[];
}

/**
 * Returns the control service base URL from the environment, or undefined if
 * not configured.  Trailing slashes are stripped.
 */
function getControlServiceUrl(): string | undefined {
  return process.env.GATEWAY_CONTROL_SERVICE_URL?.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Bootstrap state — persists last-applied revision for idempotent re-apply
// ---------------------------------------------------------------------------

/** Loads the saved bootstrap state from disk, or returns null if none exists. */
function loadBootstrapState(): BootstrapState | null {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data) as BootstrapState;
  } catch {
    return null;
  }
}

/** Saves the current manifest as the applied state to disk. */
function saveBootstrapState(manifest: NodeManifest): void {
  const state: BootstrapState = {
    revision: manifest.revision,
    appliedAt: new Date().toISOString(),
    role: manifest.role,
    profileName: manifest.profileName,
    composeBundleNames: manifest.composeBundles.map((b) => b.name),
    systemdUnitNames: manifest.systemdUnits.map((u) => u.unitName),
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log(`[bootstrap] State saved to ${STATE_FILE}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bootstrap] Failed to save state file: ${msg}`);
  }
}

/**
 * Computes the diff between the previously applied state and the incoming
 * manifest.  Returns whether a revision change occurred and a list of
 * human-readable change descriptions.
 */
function computeManifestDiff(
  previous: BootstrapState | null,
  manifest: NodeManifest
): { changed: boolean; details: string[] } {
  if (!previous) {
    return { changed: true, details: ['No previous state — fresh bootstrap'] };
  }

  const details: string[] = [];

  if (previous.revision !== manifest.revision) {
    details.push(`Revision changed: ${previous.revision} → ${manifest.revision}`);
  }

  const prevBundles = new Set(previous.composeBundleNames);
  const curBundles = new Set(manifest.composeBundles.map((b) => b.name));
  for (const b of curBundles) {
    if (!prevBundles.has(b)) details.push(`New compose bundle: ${b}`);
  }
  for (const b of prevBundles) {
    if (!curBundles.has(b)) details.push(`Removed compose bundle: ${b}`);
  }

  const prevUnits = new Set(previous.systemdUnitNames);
  const curUnits = new Set(manifest.systemdUnits.map((u) => u.unitName));
  for (const u of curUnits) {
    if (!prevUnits.has(u)) details.push(`New systemd unit: ${u}`);
  }
  for (const u of prevUnits) {
    if (!curUnits.has(u)) details.push(`Removed systemd unit: ${u}`);
  }

  return {
    changed: previous.revision !== manifest.revision,
    details,
  };
}

/**
 * Checks preconditions before beginning bootstrap.  Emits warnings for
 * operator-correctable issues (non-root, missing env vars) rather than
 * hard-failing, so that the log output is maximally helpful when diagnosing
 * a first-run failure.
 */
function preFlightCheck(): void {
  // Root check — package installation, Docker, and systemd all require root.
  if (
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
  ) {
    console.warn(
      '[bootstrap] WARNING: not running as root. Package installation, Docker, ' +
        'and systemd operations will likely fail. Re-run with: sudo -E node dist/index.js'
    );
  }

  // Log the active environment so operators can quickly see the bootstrap mode.
  const controlServiceUrl = process.env.GATEWAY_CONTROL_SERVICE_URL;
  const enrollmentToken = process.env.GATEWAY_ENROLLMENT_TOKEN;
  const instanceId = process.env.GATEWAY_INSTANCE_ID;
  console.log('[bootstrap] Pre-flight environment check:');
  console.log(
    `  GATEWAY_CONTROL_SERVICE_URL: ${
      controlServiceUrl ?? '(not set -- will read manifest URI from SSM directly)'
    }`
  );
  console.log(
    `  GATEWAY_ENROLLMENT_TOKEN:    ${enrollmentToken ? '(set)' : '(not set -- SSM direct-access mode)'}`
  );
  console.log(
    `  GATEWAY_INSTANCE_ID:         ${instanceId ?? '(not set -- will derive from IMDS)'}`
  );
}

/**
 * Validates cross-references within the manifest (e.g. health checks that
 * reference compose bundles or systemd units that do not exist in this
 * manifest).  Throws if any reference is unresolvable so the operator learns
 * early rather than at the health-check stage.
 */
function validateManifest(manifest: NodeManifest): void {
  const bundleNames = new Set(manifest.composeBundles.map((b) => b.name));
  const unitNames = new Set(manifest.systemdUnits.map((u) => u.unitName));

  for (const check of manifest.healthChecks) {
    if (check.type === 'compose-service' && !bundleNames.has(check.bundle)) {
      throw new Error(
        `Manifest validation error: health check references unknown compose bundle '${check.bundle}'. ` +
          `Defined bundles: ${[...bundleNames].join(', ') || '(none)'}`
      );
    }
    if (check.type === 'systemd-unit' && !unitNames.has(check.unitName)) {
      throw new Error(
        `Manifest validation error: health check references unknown systemd unit '${check.unitName}'. ` +
          `Defined units: ${[...unitNames].join(', ') || '(none)'}`
      );
    }
  }
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

// ---------------------------------------------------------------------------
// Host provisioning (Issue #13)
// ---------------------------------------------------------------------------

/**
 * Ensures the host has Docker CE and the Docker Compose plugin installed.
 * Targets Debian/Ubuntu (apt-get).  On non-apt systems the step is skipped
 * with a warning so operators can pre-install Docker themselves.
 */
function provisionHost(): void {
  // Only apt-based distros are supported in v1
  try {
    execSync('which apt-get', { stdio: 'pipe' });
  } catch {
    console.log(
      '[bootstrap] apt-get not found — skipping Docker installation ' +
        '(pre-install Docker manually on non-Debian/Ubuntu hosts)'
    );
    return;
  }

  // Check whether Docker is already installed
  let dockerInstalled = false;
  try {
    execSync('docker --version', { stdio: 'pipe' });
    dockerInstalled = true;
    console.log('[bootstrap] Docker is already installed');
  } catch {
    // Will install below
  }

  if (!dockerInstalled) {
    console.log('[bootstrap] Installing Docker CE from the official apt repository');
    // Install Docker CE using the official upstream apt repository.
    // This follows https://docs.docker.com/engine/install/ubuntu/ and pins to
    // the "stable" channel — the latest stable release from Docker, Inc.
    execSync(
      'apt-get update -qq && ' +
        'apt-get install -y ca-certificates curl gnupg && ' +
        'install -m 0755 -d /etc/apt/keyrings && ' +
        'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | ' +
        'gpg --dearmor -o /etc/apt/keyrings/docker.gpg && ' +
        'chmod a+r /etc/apt/keyrings/docker.gpg && ' +
        '. /etc/os-release && ' +
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ' +
        'https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" ' +
        '| tee /etc/apt/sources.list.d/docker.list > /dev/null && ' +
        'apt-get update -qq && ' +
        'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      { stdio: 'inherit' }
    );
    return;
  }

  // Docker is present — ensure the Compose plugin is available too
  try {
    execSync('docker compose version', { stdio: 'pipe' });
    console.log('[bootstrap] Docker Compose plugin is available');
  } catch {
    console.log('[bootstrap] Installing docker-compose-plugin');
    execSync('apt-get install -y docker-compose-plugin', { stdio: 'inherit' });
  }
}

// ---------------------------------------------------------------------------
// Package installation (Issue #13 — idempotency, Issue #12 — prerequisites)
// ---------------------------------------------------------------------------

/**
 * Validates a Debian package name.  Debian policy requires names to match
 * [a-z0-9][a-z0-9+\-.]+.  We accept a slightly broader set that also allows
 * uppercase letters (as some third-party packages use them) while rejecting
 * characters that have special meaning in shell commands.
 */
function validatePackageName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9+\-.]*$/.test(name)) {
    throw new Error(`Invalid package name: '${name}'`);
  }
}

/** Returns the installed version of a Debian package, or undefined if not installed. */
function getInstalledVersion(name: string): string | undefined {
  validatePackageName(name);
  try {
    const output = execSync(
      `dpkg-query -W -f='\${db:Status-Status} \${Version}' '${name}' 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    // Expected format: "installed 1.2.3-4" or "not-installed "
    const spaceIdx = output.indexOf(' ');
    if (spaceIdx === -1) return undefined;
    const status = output.slice(0, spaceIdx);
    const version = output.slice(spaceIdx + 1).trim();
    return status === 'installed' && version ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the installed version satisfies the minimum requirement
 * (using dpkg version comparison semantics).
 */
function isVersionSatisfied(installed: string, minVersion: string): boolean {
  try {
    execFileSync('dpkg', ['--compare-versions', installed, 'ge', minVersion], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/** Installs system packages listed in the manifest, skipping those already present. */
function installPackages(packages: NodeManifest['runtimePackages']): void {
  if (packages.length === 0) return;

  const toInstall: string[] = [];
  for (const pkg of packages) {
    validatePackageName(pkg.name);
    const installedVersion = getInstalledVersion(pkg.name);
    if (installedVersion === undefined) {
      console.log(`[bootstrap] Package ${pkg.name}: not installed`);
      toInstall.push(pkg.name);
    } else if (pkg.minVersion && !isVersionSatisfied(installedVersion, pkg.minVersion)) {
      console.log(
        `[bootstrap] Package ${pkg.name}: installed=${installedVersion}, ` +
          `need>=${pkg.minVersion} — will upgrade`
      );
      toInstall.push(pkg.name);
    } else {
      console.log(
        `[bootstrap] Package ${pkg.name}: ${installedVersion} already installed — skipping`
      );
    }
  }

  if (toInstall.length === 0) {
    console.log('[bootstrap] All runtime packages already installed');
    return;
  }

  console.log(`[bootstrap] Installing packages: ${toInstall.join(' ')}`);
  execFileSync('apt-get', ['install', '-y', ...toInstall], { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Secret resolution (Issue #12, #14)
// ---------------------------------------------------------------------------

/**
 * Fetches secret values from AWS Secrets Manager for each SecretRef in the
 * manifest and returns them as a map of env-var name → value.
 *
 * The env-var key is derived from the secret path by stripping the leading
 * slash, replacing all remaining slashes and hyphens with underscores, and
 * upper-casing the result.  Example: "/gateway/prod/api-key" → "GATEWAY_PROD_API_KEY".
 *
 * An error is raised if two different paths would produce the same env-var key,
 * preventing silent overwrites.
 *
 * Secret paths are logged to aid debugging; values are never logged.
 * The trust model relies on CloudWatch log filtering to suppress any paths
 * that match the /gateway/… prefix pattern.
 */
async function resolveSecrets(secretRefs: string[]): Promise<Record<string, string>> {
  if (secretRefs.length === 0) return {};
  const sm = new SecretsManagerClient({});
  const resolved: Record<string, string> = {};
  // Track which original ref produced each key so we can detect collisions
  const keyToRef: Record<string, string> = {};
  for (const ref of secretRefs) {
    console.log(`[bootstrap] Resolving secret: ${ref}`);
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: ref }));
    const value = resp.SecretString;
    if (value === undefined || value === null) {
      throw new Error(`Secret '${ref}' has no string value in Secrets Manager`);
    }
    // Derive a safe env-var key from the secret path
    const envKey = ref.replace(/^\//, '').replace(/[/-]/g, '_').toUpperCase();
    if (keyToRef[envKey] !== undefined && keyToRef[envKey] !== ref) {
      throw new Error(
        `Secret key collision: both '${keyToRef[envKey]}' and '${ref}' map to env var '${envKey}'`
      );
    }
    keyToRef[envKey] = ref;
    resolved[envKey] = value;
  }
  return resolved;
}

/**
 * Writes resolved secrets to a Docker Compose–compatible .env file at
 * <dir>/.env with mode 0600.  Existing contents are replaced.
 */
function writeEnvFile(dir: string, secrets: Record<string, string>): void {
  const lines = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const dest = path.join(dir, '.env');
  fs.writeFileSync(dest, content, { mode: 0o600 });
  console.log(`[bootstrap] Wrote .env file: ${dest} (${lines.length} variable(s))`);
}

// ---------------------------------------------------------------------------
// Compose bundle application (Issues #14, #15)
// ---------------------------------------------------------------------------

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

  // Resolve referenced secrets and render the .env file (Issue #14)
  if (bundle.secretRefs.length > 0) {
    const secrets = await resolveSecrets(bundle.secretRefs);
    writeEnvFile(dir, secrets);
  }

  // Pull pinned images before starting services so failures surface early (Issue #15)
  for (const imageRef of bundle.images) {
    console.log(`[bootstrap] Pulling image: ${imageRef}`);
    execFileSync('docker', ['pull', imageRef], { stdio: 'inherit' });
  }

  execFileSync('docker', ['compose', '-f', dest, 'up', '-d', '--remove-orphans'], {
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
  execFileSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['enable', '--now', unit.unitName], { stdio: 'inherit' });
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
          execFileSync('nc', [
            '-z',
            '-w',
            String(check.timeoutSeconds ?? 5),
            check.host,
            String(check.port),
          ]);
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
          execFileSync('systemctl', ['is-active', '--quiet', check.unitName]);
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

  // 0. Pre-flight checks — validates environment and warns on common misconfigurations.
  preFlightCheck();

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

  // 3a. Validate manifest internal cross-references
  validateManifest(manifest);

  console.log(
    `[bootstrap] Applying manifest: role=${manifest.role} ` +
      `profile="${manifest.profileName}" revision=${manifest.revision}`
  );

  // Load previous state and compute diff (Issue #16 — idempotent re-apply)
  const previousState = loadBootstrapState();
  const diff = computeManifestDiff(previousState, manifest);

  if (!diff.changed && previousState) {
    console.log(
      `[bootstrap] Manifest revision ${manifest.revision} matches last-applied state — ` +
        're-verifying desired state'
    );
  } else {
    for (const detail of diff.details) {
      console.log(`[bootstrap] Change detected: ${detail}`);
    }
  }

  // 4. Provision the host: install Docker CE and docker-compose-plugin (Issue #13)
  provisionHost();

  // 5. Install runtime packages (idempotent — skips already-satisfied packages)
  installPackages(manifest.runtimePackages);

  // 6. Apply compose bundles (fetches compose file, resolves secrets, pulls images)
  for (const bundle of manifest.composeBundles) {
    await applyComposeBundle(bundle);
  }

  // 7. Apply systemd units
  for (const unit of manifest.systemdUnits) {
    await applySystemdUnit(unit);
  }

  // 8. Run health checks
  const failures = await runHealthChecks(manifest.healthChecks);

  // 9. Report heartbeat if the control service is configured
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

  // 10. Persist bootstrap state for idempotent re-apply on future runs (Issue #16)
  saveBootstrapState(manifest);

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
