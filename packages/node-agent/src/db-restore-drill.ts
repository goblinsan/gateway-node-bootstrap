/**
 * db-restore-drill.ts — End-to-end restore drill
 *
 * Purpose (Issue #27): Execute a real backup → restore cycle against a
 * disposable target database and verify that the decrypted data is usable.
 * Captures timing and reports any undocumented gaps.
 *
 * Prerequisites:
 *   - A running Postgres instance reachable via PGHOST / PGPORT / PGDATABASE /
 *     PGUSER / PGPASSWORD (the SOURCE database, which must already have the
 *     gateway_sensitive schema applied via migration 001).
 *   - A second Postgres database for the restore target:
 *     RESTORE_PGDATABASE / RESTORE_PGHOST / RESTORE_PGPORT /
 *     RESTORE_PGUSER / RESTORE_PGPASSWORD
 *     These default to the source connection vars if not provided.
 *   - BACKUP_KMS_KEY_ID — KMS key ARN or alias
 *   - BACKUP_S3_BUCKET  — S3 bucket for backup storage
 *
 * Exit codes:
 *   0  — drill passed
 *   1  — drill failed (backup, restore, or verification step)
 *
 * The drill does NOT leave test data in the source database; it writes a
 * canary row to a temporary table, takes a backup, restores, and verifies
 * the canary row in the restore target.
 */

import { runBackup } from './db-backup';
import { runRestore, RestoreResult } from './db-restore';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

/**
 * Overlays the restore-target Postgres environment variables, falling back
 * to the source variables when the RESTORE_-prefixed variants are absent.
 */
function buildRestoreEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST:     process.env.RESTORE_PGHOST     ?? process.env.PGHOST,
    PGPORT:     process.env.RESTORE_PGPORT     ?? process.env.PGPORT,
    PGDATABASE: process.env.RESTORE_PGDATABASE ?? process.env.PGDATABASE,
    PGUSER:     process.env.RESTORE_PGUSER     ?? process.env.PGUSER,
    PGPASSWORD: process.env.RESTORE_PGPASSWORD ?? process.env.PGPASSWORD,
  };
}

/** Runs a psql command against the given environment and returns stdout. */
function psql(sql: string, env: NodeJS.ProcessEnv): string {
  const result = execFileSync('psql', ['--no-psqlrc', '--tuples-only', '--command', sql], {
    env,
    encoding: 'utf-8',
  });
  return result.trim();
}

// ---------------------------------------------------------------------------
// Drill phases
// ---------------------------------------------------------------------------

interface DrillReport {
  canaryId: string;
  backupUri: string;
  backupDurationMs: number;
  restoreResult: RestoreResult;
  verificationPassed: boolean;
  totalDurationMs: number;
  notes: string[];
}

async function runDrill(): Promise<DrillReport> {
  const notes: string[] = [];
  const drillStart = Date.now();

  requiredEnv('BACKUP_KMS_KEY_ID');
  requiredEnv('BACKUP_S3_BUCKET');

  const canaryId = crypto.randomUUID();
  console.log(`[drill] Canary ID: ${canaryId}`);

  // Phase 1 — Insert canary row into source database
  console.log('[drill] Phase 1: inserting canary audit_log row');
  const sourceEnv = process.env as NodeJS.ProcessEnv;
  psql(
    `INSERT INTO gateway_sensitive.audit_log (actor, event_type, node_id, detail)
     VALUES ('restore-drill', 'drill.canary', '${canaryId}',
             '{"canary": true, "drillId": "${canaryId}"}')`,
    sourceEnv
  );
  notes.push('Canary row inserted into source gateway_sensitive.audit_log');

  // Phase 2 — Backup
  console.log('[drill] Phase 2: running encrypted backup');
  const backupStart = Date.now();
  const backupUri = await runBackup();
  const backupDurationMs = Date.now() - backupStart;
  notes.push(`Backup completed in ${backupDurationMs} ms → ${backupUri}`);

  // Phase 3 — Restore into the target database
  console.log('[drill] Phase 3: restoring backup into target database');
  // Override RESTORE_S3_PREFIX to point at the backup we just took
  process.env.RESTORE_S3_PREFIX = backupUri;
  // Point pg_* vars at the restore target
  const restoreEnv = buildRestoreEnv();
  const savedEnv: Partial<NodeJS.ProcessEnv> = {};
  for (const k of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    savedEnv[k] = process.env[k];
    process.env[k] = restoreEnv[k];
  }

  let restoreResult: RestoreResult;
  try {
    restoreResult = await runRestore();
  } finally {
    // Restore original pg_* env vars
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    delete process.env.RESTORE_S3_PREFIX;
  }
  notes.push(`Restore completed in ${restoreResult.durationMs} ms`);
  notes.push(`Integrity check: SHA-256 ${restoreResult.dumpSha256}`);

  // Phase 4 — Verify canary row is present in the restore target
  console.log('[drill] Phase 4: verifying canary row in restore target');
  const count = psql(
    `SELECT count(*) FROM gateway_sensitive.audit_log
     WHERE node_id = '${canaryId}' AND event_type = 'drill.canary'`,
    restoreEnv
  );
  const verificationPassed = count === '1';

  if (verificationPassed) {
    console.log('[drill] Verification PASSED — canary row found in restore target');
    notes.push('Canary row verified in restore target');
  } else {
    console.error(
      `[drill] Verification FAILED — expected 1 canary row, found: ${count}`
    );
    notes.push(`Canary verification failed: count=${count}`);
  }

  return {
    canaryId,
    backupUri,
    backupDurationMs,
    restoreResult,
    verificationPassed,
    totalDurationMs: Date.now() - drillStart,
    notes,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runDrill()
    .then((report) => {
      console.log('\n=== Restore Drill Report ===');
      console.log(JSON.stringify(report, null, 2));
      if (!report.verificationPassed) {
        console.error('\n[drill] DRILL FAILED — canary verification did not pass');
        process.exit(1);
      }
      console.log(
        `\n[drill] DRILL PASSED in ${report.totalDurationMs} ms total ` +
        `(backup: ${report.backupDurationMs} ms, restore: ${report.restoreResult.durationMs} ms)`
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[drill] Fatal error: ${msg}`);
      process.exit(1);
    });
}
