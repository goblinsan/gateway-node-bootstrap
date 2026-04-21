-- Migration 001: Sensitive-state schema and role model
--
-- Purpose: Define a dedicated schema, least-privilege roles, and tables for
-- sensitive runtime state that does not fit naturally into DynamoDB or Secrets
-- Manager (e.g. per-node credential history, structured audit logs).
--
-- Encryption: Sensitive columns (credential_ciphertext, metadata) are stored
-- as BYTEA containing AES-256-GCM ciphertext produced by the application layer
-- using a KMS-derived data key.  The database never holds plaintext secrets.
--
-- Role model:
--   gateway_reader  — SELECT only (used by read-path application code)
--   gateway_writer  — INSERT / UPDATE on mutable tables; no DELETE
--   gateway_backup  — SELECT only on all tables (used by the backup job)
--   gateway_admin   — Full DDL access (used only by migration scripts; revoke
--                     from application service accounts after migrations run)
--
-- Usage:
--   psql -U postgres -d <database> -f 001_sensitive_state_schema.sql

-- ---------------------------------------------------------------------------
-- Role definitions
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_reader') THEN
    CREATE ROLE gateway_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_writer') THEN
    CREATE ROLE gateway_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_backup') THEN
    CREATE ROLE gateway_backup NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_admin') THEN
    CREATE ROLE gateway_admin NOLOGIN;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gateway_sensitive;

-- Grant schema-level usage to application roles
GRANT USAGE ON SCHEMA gateway_sensitive TO gateway_reader, gateway_writer, gateway_backup, gateway_admin;
GRANT ALL   ON SCHEMA gateway_sensitive TO gateway_admin;

-- ---------------------------------------------------------------------------
-- Table: node_credentials
--
-- Stores per-node encrypted credentials (e.g. VPN pre-shared keys, TLS
-- certificates, rotate-on-demand tokens).  The credential_ciphertext column
-- holds the AES-256-GCM ciphertext; key_ref holds the KMS key ARN / alias
-- used to generate the data key so the restore path can re-derive it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gateway_sensitive.node_credentials (
  id                  BIGSERIAL    PRIMARY KEY,
  node_id             TEXT         NOT NULL,
  credential_name     TEXT         NOT NULL,
  -- AES-256-GCM: nonce (12 B) || ciphertext || auth-tag (16 B)
  credential_ciphertext BYTEA      NOT NULL,
  -- KMS key ARN or alias used when sealing this credential
  key_ref             TEXT         NOT NULL,
  -- Encrypted-DEK envelope: the KMS-encrypted data key
  encrypted_dek       BYTEA        NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  rotated_at          TIMESTAMPTZ,
  CONSTRAINT uq_node_credential UNIQUE (node_id, credential_name)
);

-- ---------------------------------------------------------------------------
-- Table: audit_log
--
-- Append-only table recording key lifecycle events (enrollment, activation,
-- revocation, backup, restore, credential rotation).  No application role
-- may UPDATE or DELETE rows; gateway_writer may only INSERT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gateway_sensitive.audit_log (
  id          BIGSERIAL    PRIMARY KEY,
  occurred_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor       TEXT         NOT NULL,   -- who triggered the event (e.g. instance-id, "backup-job")
  event_type  TEXT         NOT NULL,   -- e.g. "enrollment.activate", "backup.success"
  node_id     TEXT,                    -- nullable; not all events are node-scoped
  detail      JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Table: backup_manifest
--
-- Tracks every backup run: S3 path, checksum of the plaintext dump, outcome,
-- and timing.  Used by the restore drill to locate the latest good backup.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gateway_sensitive.backup_manifest (
  id              BIGSERIAL    PRIMARY KEY,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT         NOT NULL DEFAULT 'in_progress',
    CONSTRAINT ck_backup_status CHECK (status IN ('in_progress', 'success', 'failed')),
  s3_uri          TEXT,
  plaintext_sha256 TEXT,
  size_bytes      BIGINT,
  error_message   TEXT
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_node_credentials_node_id
  ON gateway_sensitive.node_credentials (node_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_node_id
  ON gateway_sensitive.audit_log (node_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at
  ON gateway_sensitive.audit_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_manifest_started_at
  ON gateway_sensitive.backup_manifest (started_at DESC);

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------

-- gateway_reader: SELECT on all tables
GRANT SELECT ON ALL TABLES IN SCHEMA gateway_sensitive TO gateway_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway_sensitive
  GRANT SELECT ON TABLES TO gateway_reader;

-- gateway_writer: INSERT / UPDATE on mutable tables; append-only on audit_log
GRANT SELECT, INSERT, UPDATE ON gateway_sensitive.node_credentials TO gateway_writer;
GRANT SELECT, INSERT         ON gateway_sensitive.audit_log         TO gateway_writer;
GRANT SELECT, INSERT, UPDATE ON gateway_sensitive.backup_manifest   TO gateway_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway_sensitive    TO gateway_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway_sensitive
  GRANT USAGE, SELECT ON SEQUENCES TO gateway_writer;

-- gateway_backup: SELECT only (for pg_dump --schema=gateway_sensitive)
GRANT SELECT ON ALL TABLES IN SCHEMA gateway_sensitive TO gateway_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway_sensitive
  GRANT SELECT ON TABLES TO gateway_backup;

-- gateway_admin: full access
GRANT ALL ON ALL TABLES    IN SCHEMA gateway_sensitive TO gateway_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA gateway_sensitive TO gateway_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway_sensitive
  GRANT ALL ON TABLES    TO gateway_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway_sensitive
  GRANT ALL ON SEQUENCES TO gateway_admin;
