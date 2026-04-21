/**
 * db-backup.ts — Encrypted Postgres backup job
 *
 * Workflow:
 *   1. Run pg_dump for the gateway_sensitive schema via execFileSync.
 *   2. Generate an AES-256 data key using KMS (GenerateDataKey).
 *   3. Encrypt the dump using AES-256-GCM with the plaintext data key.
 *   4. Upload the ciphertext, the KMS-encrypted DEK envelope, and a JSON
 *      manifest to S3 under backups/postgres/<ISO-timestamp>/.
 *   5. Overwrite backups/postgres/latest.json to point at the new backup.
 *   6. Emit a CloudWatch custom metric so the missing-backup alarm can fire.
 *   7. Clean up the plaintext temp file immediately after encryption.
 *
 * Environment variables (required):
 *   BACKUP_KMS_KEY_ID       — KMS key ARN or alias used to seal the DEK
 *   BACKUP_S3_BUCKET        — S3 bucket name for backup storage
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
 *                           — Standard Postgres connection variables consumed
 *                             by pg_dump; never logged by this module.
 *
 * Optional:
 *   BACKUP_DB_SCHEMA        — Postgres schema to dump (default: gateway_sensitive)
 *   BACKUP_CLOUDWATCH_REGION — AWS region for the CloudWatch client (default: AWS_REGION)
 */

import { KMSClient, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const METRIC_NAMESPACE = 'GatewayNodeBootstrap/DBBackup';
const METRIC_NAME_SUCCESS = 'BackupSuccess';
const SCHEMA = process.env.BACKUP_DB_SCHEMA ?? 'gateway_sensitive';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

/** Derives an ISO-8601 timestamp string safe for use as an S3 key segment. */
function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Encrypts a plaintext Buffer using AES-256-GCM and the provided key material.
 * Returns: nonce (12 B) || authTag (16 B) || ciphertext
 */
function encryptAesGcm(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: nonce (12) | authTag (16) | ciphertext
  return Buffer.concat([nonce, authTag, ciphertext]);
}

/**
 * Emits a single CloudWatch data point for the backup outcome.
 * Failures here are logged but never rethrow — a metric emission failure
 * must not mask the actual backup status.
 */
async function emitBackupMetric(success: boolean): Promise<void> {
  const cw = new CloudWatchClient({});
  try {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: METRIC_NAME_SUCCESS,
            Value: success ? 1 : 0,
            Unit: 'Count',
            Timestamp: new Date(),
            Dimensions: [{ Name: 'Schema', Value: SCHEMA }],
          },
        ],
      })
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[db-backup] Failed to emit CloudWatch metric: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Core backup steps
// ---------------------------------------------------------------------------

/** Runs pg_dump and writes the custom-format dump to a temp file. */
function dumpDatabase(tmpDir: string): string {
  const dumpFile = path.join(tmpDir, 'dump.pgdump');
  console.log(`[db-backup] Running pg_dump for schema ${SCHEMA}`);
  // Use the custom (directory) format so pg_restore can parallelise restores.
  execFileSync('pg_dump', [
    '--format=custom',
    `--schema=${SCHEMA}`,
    `--file=${dumpFile}`,
  ], {
    // Inherit PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD from process env
    stdio: 'inherit',
    env: process.env as NodeJS.ProcessEnv,
  });
  const stats = fs.statSync(dumpFile);
  console.log(`[db-backup] Dump complete: ${stats.size} bytes`);
  return dumpFile;
}

/** Requests a new AES-256 data key from KMS. */
async function generateDataKey(
  kmsKeyId: string
): Promise<{ plaintext: Buffer; ciphertext: Buffer }> {
  const kms = new KMSClient({});
  const resp = await kms.send(
    new GenerateDataKeyCommand({ KeyId: kmsKeyId, KeySpec: 'AES_256' })
  );
  if (!resp.Plaintext || !resp.CiphertextBlob) {
    throw new Error('KMS GenerateDataKey returned empty key material');
  }
  return {
    plaintext: Buffer.from(resp.Plaintext),
    ciphertext: Buffer.from(resp.CiphertextBlob),
  };
}

/** Uploads the encrypted backup artifacts to S3 and returns the S3 prefix. */
async function uploadToS3(
  bucket: string,
  prefix: string,
  encryptedDump: Buffer,
  encryptedDek: Buffer,
  dumpSha256: string,
  dumpSizeBytes: number
): Promise<string> {
  const s3 = new S3Client({});

  const metaKey = `${prefix}meta.json`;
  const dumpKey = `${prefix}dump.enc`;
  const dekKey = `${prefix}dek.enc`;

  const meta = {
    schema: SCHEMA,
    timestamp: new Date().toISOString(),
    dumpSha256,
    dumpSizeBytes,
    dumpKey: `s3://${bucket}/${dumpKey}`,
    dekKey: `s3://${bucket}/${dekKey}`,
    encryptionScheme: 'AES-256-GCM+KMS-envelope',
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: metaKey,
      Body: JSON.stringify(meta, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: dumpKey,
      Body: encryptedDump,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'aws:kms',
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: dekKey,
      Body: encryptedDek,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'aws:kms',
    })
  );

  // Overwrite latest.json so restore scripts can find the most recent backup
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: 'backups/postgres/latest.json',
      Body: JSON.stringify({ prefix: `s3://${bucket}/${prefix}`, ...meta }, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
    })
  );

  return `s3://${bucket}/${prefix}`;
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

/**
 * runBackup — performs one complete backup cycle.
 *
 * @returns The S3 URI prefix of the stored backup on success.
 * @throws  On any unrecoverable failure (after emitting a failure metric).
 */
export async function runBackup(): Promise<string> {
  const kmsKeyId = requiredEnv('BACKUP_KMS_KEY_ID');
  const bucket = requiredEnv('BACKUP_S3_BUCKET');

  const ts = backupTimestamp();
  const prefix = `backups/postgres/${ts}/`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-backup-'));

  try {
    // Step 1 — dump
    const dumpFile = dumpDatabase(tmpDir);
    const plaintext = fs.readFileSync(dumpFile);
    const dumpSha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
    const dumpSizeBytes = plaintext.length;

    // Step 2 — generate data key
    console.log('[db-backup] Generating KMS data key');
    const { plaintext: dek, ciphertext: encryptedDek } = await generateDataKey(kmsKeyId);

    // Step 3 — encrypt
    console.log('[db-backup] Encrypting dump (AES-256-GCM)');
    const encryptedDump = encryptAesGcm(plaintext, dek);

    // Zero-fill the plaintext DEK immediately after use
    dek.fill(0);

    // Step 4 — delete plaintext dump from disk before upload
    fs.unlinkSync(dumpFile);

    // Step 5 — upload
    console.log('[db-backup] Uploading backup artifacts to S3');
    const s3Uri = await uploadToS3(
      bucket, prefix, encryptedDump, encryptedDek, dumpSha256, dumpSizeBytes
    );

    console.log(`[db-backup] Backup complete: ${s3Uri}`);
    await emitBackupMetric(true);
    return s3Uri;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[db-backup] Backup failed: ${msg}`);
    await emitBackupMetric(false);
    throw err;
  } finally {
    // Clean up temp directory regardless of outcome
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Lists the S3 backup prefixes ordered by timestamp (newest first).
 * Useful for audit and for choosing a specific restore point.
 */
export async function listBackups(bucket: string): Promise<string[]> {
  const s3 = new S3Client({});
  const resp = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'backups/postgres/',
      Delimiter: '/',
    })
  );
  const prefixes = (resp.CommonPrefixes ?? [])
    .map((p) => p.Prefix ?? '')
    .filter(Boolean)
    .sort()
    .reverse();
  return prefixes;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runBackup()
    .then((uri) => {
      console.log(`[db-backup] Stored at: ${uri}`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[db-backup] Fatal: ${msg}`);
      process.exit(1);
    });
}
