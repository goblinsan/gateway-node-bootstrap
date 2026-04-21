/**
 * NodeManifest — desired-state manifest for a single gateway node.
 *
 * This schema is the source of truth used by the control service to declare
 * what a node should look like after bootstrap or recovery.  It is intentionally
 * narrow: it covers only what is needed to bring a fresh node to a known-good
 * state.  Anything beyond that scope belongs in separate operational documents.
 *
 * The schema is versioned via the `manifestVersion` field so that the control
 * service and node agent can detect and reject incompatible manifests.
 */

/** Semantic version string, e.g. "1.0.0". */
export type SemVer = string;

/** AWS SSM Parameter Store path or ARN, e.g. "/gateway/prod/api-key". */
export type SecretRef = string;

/** OCI image reference.  Prefer digest-pinned form, e.g.
 *  "registry.example.com/image@sha256:<digest>"            */
export type ImageRef = string;

// ---------------------------------------------------------------------------
// Runtime prerequisites
// ---------------------------------------------------------------------------

/** A system package that must be installed before services start. */
export interface RuntimePackage {
  /** Package name as understood by the node's package manager (e.g. apt). */
  name: string;
  /** Minimum acceptable version string (semver or distro convention). */
  minVersion?: string;
}

// ---------------------------------------------------------------------------
// Service units
// ---------------------------------------------------------------------------

/** A Docker Compose project to be installed and kept running on the node. */
export interface ComposeBundle {
  /** Logical name for this bundle, used in health-check references. */
  name: string;
  /**
   * S3 URI or HTTPS URL from which the compose file should be fetched.
   * The node agent must have the appropriate IAM permissions to read this path.
   * Example: "s3://gateway-config/manifests/edge/docker-compose.yml"
   */
  sourceUri: string;
  /**
   * SHA-256 hex digest of the compose file contents.
   * The agent verifies this before applying the file to detect tampering.
   */
  sha256: string;
  /** Container images referenced by this compose bundle. */
  images: ImageRef[];
  /** Names of secrets the compose bundle requires (values resolved at runtime). */
  secretRefs: SecretRef[];
}

/** A systemd service unit to be placed and enabled on the node. */
export interface SystemdUnit {
  /** Systemd unit name, e.g. "gateway-agent.service". */
  unitName: string;
  /** S3 URI or HTTPS URL from which the unit file should be fetched. */
  sourceUri: string;
  /** SHA-256 hex digest of the unit file contents. */
  sha256: string;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

/** HTTP/HTTPS health check endpoint. */
export interface HttpHealthCheck {
  type: 'http';
  /** Full URL, e.g. "http://localhost:8080/health". */
  url: string;
  /** Expected HTTP status code (default 200). */
  expectedStatus?: number;
  /** Maximum seconds to wait for a response (default 5). */
  timeoutSeconds?: number;
}

/** TCP port reachability check. */
export interface TcpHealthCheck {
  type: 'tcp';
  host: string;
  port: number;
  timeoutSeconds?: number;
}

/** Name of a Docker Compose service that must be in the "running" state. */
export interface ComposeServiceCheck {
  type: 'compose-service';
  /** Bundle name (must match a `ComposeBundle.name` in this manifest). */
  bundle: string;
  /** Service name inside the compose file. */
  service: string;
}

/** Name of a systemd unit that must be active. */
export interface SystemdUnitCheck {
  type: 'systemd-unit';
  unitName: string;
}

export type HealthCheck =
  | HttpHealthCheck
  | TcpHealthCheck
  | ComposeServiceCheck
  | SystemdUnitCheck;

// ---------------------------------------------------------------------------
// Top-level manifest
// ---------------------------------------------------------------------------

/**
 * The complete desired-state manifest for a single gateway node.
 *
 * Field ordering reflects the lifecycle of a bootstrap run:
 *   role → packages → services → expected health state.
 */
export interface NodeManifest {
  /**
   * Schema version. The node agent rejects manifests whose `manifestVersion`
   * is not in the set it supports, preventing silent mis-application.
   */
  manifestVersion: '1';

  /**
   * Logical role of this node profile, e.g. "edge-gateway", "internal-relay".
   * The control service uses this to look up the correct manifest in the store.
   */
  role: string;

  /**
   * Human-readable profile name, used in log messages and dashboards.
   * Example: "US-East edge gateway — production"
   */
  profileName: string;

  /**
   * Opaque revision token.  The control service increments this on every
   * manifest change; the agent records the last-applied revision so that
   * future drift-detection runs can skip unchanged nodes.
   */
  revision: string;

  /** System packages that must be present before any service is started. */
  runtimePackages: RuntimePackage[];

  /** Docker Compose projects to be installed and maintained. */
  composeBundles: ComposeBundle[];

  /** Systemd units to be installed and enabled. */
  systemdUnits: SystemdUnit[];

  /**
   * Health checks the agent runs after bootstrap to verify the node reached
   * the expected state.  All checks must pass for the bootstrap to be
   * reported as successful.
   */
  healthChecks: HealthCheck[];
}
