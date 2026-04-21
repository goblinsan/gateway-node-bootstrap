/**
 * db-restore.ts — Restore workflow for encrypted Postgres backups
 *
 * Workflow:
 *   1. Resolve the target backup: use the provided S3 prefix, or discover the
 *      latest from backups/postgres/latest.json.
 *   2. Download the meta.json to verify the dump checksum and locate artifacts.
 *   3. Download the KMS-encrypted DEK envelope and call kms:Decrypt.
 *   4. Download the encrypted dump ciphertext.
 *   5. Verify the plaintext SHA-256 against the value stored in meta.json.
 *   6. Write the decrypted dump to a secure temp file (mode 0600).
 *   7. Run pg_restore to reload the schema.
 *   8. Delete the temp file immediately after restore.
 *   9. Log timing so the operator has a baseline for the restore drill.
 *
 * Environment variables (required):
 *   BACKUP_KMS_KEY_ID       — KMS key ARN/alias (must match the one used at backup time)
 *   BACKUP_S3_BUCKET        — S3 bucket name
 *   PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
 *                           — Postgres connection; must point at the TARGET database.
 *
 * Optional:
 *   RESTORE_S3_PREFIX       — Full S3 prefix of the specific backup to restore
 *                             (e.g. s3://bucket/backups/postgres/2026-01-01T00-00-00-000Z/).
 *                             If omitted, the latest backup is used.
 *   RESTORE_CLEAN           — If "true", passes --clean to pg_restore (drops
 *                             objects before recreating them).  Default: false.
 *   BACKUP_DB_SCHEMA        — Schema name (default: gateway_sensitive)
 */

import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCHEMA = process.env.BACKUP_DB_SCHEMA ?? 'gateway_sensitive';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

/** Downloads an S3 object and returns its body as a Buffer. */
async function downloadS3Object(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) throw new Error(`Empty S3 response for s3://${bucket}/${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Decrypts AES-256-GCM ciphertext produced by db-backup.ts.
 * Expected layout: nonce (12 B) | authTag (16 B) | ciphertext
 */
function decryptAesGcm(encrypted: Buffer, key: Buffer): Buffer {
  const nonce = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const ciphertext = encrypted.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Parses an s3:// URI into bucket and key. */
function parseS3Uri(uri: string): { bucket: string; key: string } {
  const url = new URL(uri);
  if (url.protocol !== 's3:') throw new Error(`Not an S3 URI: ${uri}`);
  return { bucket: url.hostname, key: url.pathname.slice(1) };
}

// ---------------------------------------------------------------------------
// Backup discovery
// ---------------------------------------------------------------------------

interface BackupMeta {
  schema: string;
  timestamp: string;
  dumpSha256: string;
  dumpSizeBytes: number;
  dumpKey: string;
  dekKey: string;
  encryptionScheme: string;
}

/**
 * Resolves the S3 prefix to restore from.
 * Uses RESTORE_S3_PREFIX if set; otherwise downloads backups/postgres/latest.json.
 */
async function resolveBackupPrefix(
  s3: S3Client,
  bucket: string
): Promise<string> {
  const explicit = process.env.RESTORE_S3_PREFIX;
  if (explicit) {
    console.log(`[db-restore] Using explicit backup prefix: ${explicit}`);
    return explicit.replace(/\/$/, '') + '/';
  }

  console.log('[db-restore] Discovering latest backup via backups/postgres/latest.json');
  const latestBuf = await downloadS3Object(s3, bucket, 'backups/postgres/latest.json');
  const latest = JSON.parse(latestBuf.toString('utf-8')) as { prefix: string };
  if (!latest.prefix) throw new Error('latest.json does not contain a "prefix" field');
  const { key } = parseS3Uri(latest.prefix);
  console.log(`[db-restore] Latest backup prefix: ${latest.prefix}`);
  return key.replace(/\/$/, '') + '/';
}

// ---------------------------------------------------------------------------
// Exported entry point
// ---------------------------------------------------------------------------

export interface RestoreResult {
  /** S3 prefix of the backup that was restored */
  backupPrefix: string;
  /** Wall-clock duration of the full restore operation in milliseconds */
  durationMs: number;
  /** SHA-256 of the decrypted dump (verified against backup meta) */
  dumpSha256: string;
  /** Number of bytes in the decrypted dump */
  dumpSizeBytes: number;
}

/**
 * runRestore — downloads, decrypts, and restores the latest (or specified)
 * encrypted backup into the target Postgres instance.
 *
 * @returns Timing and integrity metadata for the restore drill log.
 * @throws  On any integrity, decryption, or restore failure.
 */
export async function runRestore(): Promise<RestoreResult> {
  const kmsKeyId = requiredEnv('BACKUP_KMS_KEY_ID');
  const bucket = requiredEnv('BACKUP_S3_BUCKET');
  const clean = process.env.RESTORE_CLEAN === 'true';

  const startMs = Date.now();
  const s3 = new S3Client({});
  const kms = new KMSClient({});
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-restore-'));

  try {
    // Step 1 — resolve the backup prefix
    const prefix = await resolveBackupPrefix(s3, bucket);

    // Step 2 — download and parse meta.json
    console.log('[db-restore] Downloading backup manifest');
    const metaBuf = await downloadS3Object(s3, bucket, `${prefix}meta.json`);
    const meta = JSON.parse(metaBuf.toString('utf-8')) as BackupMeta;
    console.log(`[db-restore] Backup timestamp: ${meta.timestamp}, schema: ${meta.schema}`);
    console.log(`[db-restore] Expected dump size: ${meta.dumpSizeBytes} bytes`);

    // Step 3 — download and decrypt the DEK
    const { key: dekS3Key } = parseS3Uri(meta.dekKey);
    console.log('[db-restore] Downloading encrypted DEK');
    const encryptedDek = await downloadS3Object(s3, bucket, dekS3Key);

    console.log('[db-restore] Decrypting DEK via KMS');
    const decryptResp = await kms.send(
      new DecryptCommand({
        CiphertextBlob: encryptedDek,
        KeyId: kmsKeyId,
      })
    );
    if (!decryptResp.Plaintext) {
      throw new Error('KMS Decrypt returned empty plaintext');
    }
    const dek = Buffer.from(decryptResp.Plaintext);

    // Step 4 — download the encrypted dump
    const { key: dumpS3Key } = parseS3Uri(meta.dumpKey);
    console.log('[db-restore] Downloading encrypted dump');
    const encryptedDump = await downloadS3Object(s3, bucket, dumpS3Key);

    // Step 5 — decrypt
    console.log('[db-restore] Decrypting dump (AES-256-GCM)');
    const plaintext = decryptAesGcm(encryptedDump, dek);
    dek.fill(0); // Zero-fill the plaintext DEK immediately after use

    // Step 6 — verify integrity
    const actualSha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
    if (actualSha256 !== meta.dumpSha256) {
      throw new Error(
        `Dump integrity check failed. Expected SHA-256: ${meta.dumpSha256}, got: ${actualSha256}`
      );
    }
    console.log(`[db-restore] Integrity verified: SHA-256 ${actualSha256}`);

    // Step 7 — write to a secure temp file (mode 0600)
    const dumpFile = path.join(tmpDir, 'restore.pgdump');
    fs.writeFileSync(dumpFile, plaintext, { mode: 0o600 });

    // Step 8 — pg_restore
    console.log(`[db-restore] Running pg_restore --schema=${SCHEMA}`);
    const args: string[] = [
      '--format=custom',
      `--schema=${SCHEMA}`,
      '--no-owner',
      '--no-privileges',
    ];
    if (clean) args.push('--clean');
    args.push(dumpFile);

    execFileSync('pg_restore', args, {
      stdio: 'inherit',
      env: process.env as NodeJS.ProcessEnv,
    });

    // Step 9 — clean up plaintext dump
    fs.unlinkSync(dumpFile);

    const durationMs = Date.now() - startMs;
    console.log(`[db-restore] Restore complete in ${durationMs} ms`);

    return {
      backupPrefix: `s3://${bucket}/${prefix}`,
      durationMs,
      dumpSha256: actualSha256,
      dumpSizeBytes: plaintext.length,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runRestore()
    .then((result) => {
      console.log('[db-restore] Result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[db-restore] Fatal: ${msg}`);
      process.exit(1);
    });
}
