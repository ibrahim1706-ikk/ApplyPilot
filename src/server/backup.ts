/**
 * Nightly backup of the database and the uploads directory — server-only.
 *
 * Why this exists: everything a person has given ApplyPilot lives in ONE SQLite
 * file and one uploads folder on this machine. A single unsynced file with no
 * copy is the biggest operational risk in the build, because a bad write, a
 * mistaken `rm` or a wiped disk takes every account with it and there is nothing
 * to fall back on.
 *
 * What it writes, into <site root>/data/backups (same disk as the data, so it
 * protects against mistakes and corruption, not against the disk dying — an
 * off-machine copy is still on the list):
 *
 *   applypilot-<YYYY-MM-DD>.sqlite       consistent snapshot (SQLite VACUUM INTO)
 *   uploads-<YYYY-MM-DD>.tar.gz          every stored original, as uploaded
 *   backup-<YYYY-MM-DD>.json             manifest: row counts, file counts, hashes
 *
 * Restore is documented in docs/BACKUP-AND-RESTORE.md and exercised by
 * `bun run restore-check`, which restores the newest backup into a scratch
 * directory and compares the row counts against the manifest.
 *
 * Two ways it runs:
 *   - scripts/backup.ts          → `bun run backup` (manual, or from cron)
 *   - startBackupScheduler()     → called from serve.ts, runs once a day after
 *                                  03:00 local once the site is up
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tableCounts, uploadsRoot, vacuumInto, nowIso, dataDir } from "../db";

/** How many dated backups to keep. Two weeks of history. */
export const KEEP_BACKUPS = 14;

/** Backups run once a day, at or after this local hour, if the site is awake. */
const BACKUP_HOUR = 3;

export type BackupManifest = {
  date: string;
  createdAt: string;
  trigger: "schedule" | "manual" | "cli";
  databaseFile: string;
  uploadsFile: string;
  databaseBytes: number;
  databaseSha256: string;
  rowCounts: Record<string, number>;
  uploadsFiles: number;
  uploadsBytes: number;
  /** Recorded in the manifest so a restore can insist on the same uploads root shape. */
  uploadsRoot: string;
};

export function backupRoot(): string {
  // Inside the data directory, which lives OUTSIDE the published site folder —
  // backups kept in the deploy would be replaced by the next publish, which is
  // the whole class of bug this build just fixed for the database itself.
  return process.env.APPLYPILOT_BACKUP_PATH ?? join(dataDir(), "backups");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function manifestPath(date: string): string {
  return join(backupRoot(), `backup-${date}.json`);
}

export function databaseBackupPath(date: string): string {
  return join(backupRoot(), `applypilot-${date}.sqlite`);
}

export function uploadsBackupPath(date: string): string {
  return join(backupRoot(), `uploads-${date}.tar.gz`);
}

export function readManifest(dateOrPath: string): BackupManifest | null {
  const path = dateOrPath.endsWith(".json") ? dateOrPath : manifestPath(dateOrPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

export function listBackups(): BackupManifest[] {
  const root = backupRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith("backup-") && name.endsWith(".json"))
    .map((name) => readManifest(join(root, name)))
    .filter((manifest): manifest is BackupManifest => manifest !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every stored original, counted and totalled. */
function uploadsSummary(): { files: number; bytes: number } {
  const root = uploadsRoot();
  if (!existsSync(root)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(root);
  return { files, bytes };
}

function tarUploads(destination: string): void {
  const root = uploadsRoot();
  // An empty or missing uploads folder still produces an archive, so a restore
  // never has to special-case "there was nothing to back up".
  if (existsSync(root)) {
    const result = spawnSync("tar", ["-czf", destination, "-C", root, "."], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`tar failed (${String(result.status)}): ${result.stderr || "no output"}`);
    }
    return;
  }
  const staged = spawnSync("tar", ["-czf", destination, "-T", "/dev/null"], { encoding: "utf8" });
  if (staged.status !== 0) {
    throw new Error(`tar failed (${String(staged.status)}): ${staged.stderr || "no output"}`);
  }
}

/** Drops the oldest dated backups beyond KEEP_BACKUPS. */
function pruneOldBackups(): string[] {
  const removed: string[] = [];
  const old = listBackups().slice(KEEP_BACKUPS);
  for (const manifest of old) {
    for (const path of [
      manifest.databaseFile,
      manifest.uploadsFile,
      manifestPath(manifest.date),
    ]) {
      try {
        if (existsSync(path)) unlinkSync(path);
        removed.push(path);
      } catch {
        // A file we cannot remove must not fail the backup that just succeeded.
      }
    }
  }
  return removed;
}

/**
 * Takes one backup dated today. Overwrites any earlier backup from the same day
 * (so a manual run and the scheduled run do not pile up).
 */
export function runBackup(
  options: { trigger?: BackupManifest["trigger"] } = {}
): BackupManifest {
  const root = backupRoot();
  mkdirSync(root, { recursive: true });

  const date = today();
  const dbDestination = databaseBackupPath(date);
  const uploadsDestination = uploadsBackupPath(date);

  // VACUUM INTO refuses an existing file; a same-day re-run replaces its own.
  for (const path of [dbDestination, uploadsDestination, manifestPath(date)]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }

  vacuumInto(dbDestination);
  tarUploads(uploadsDestination);
  const uploads = uploadsSummary();

  const manifest: BackupManifest = {
    date,
    createdAt: nowIso(),
    trigger: options.trigger ?? "manual",
    databaseFile: dbDestination,
    uploadsFile: uploadsDestination,
    databaseBytes: statSync(dbDestination).size,
    databaseSha256: sha256File(dbDestination),
    rowCounts: tableCounts(),
    uploadsFiles: uploads.files,
    uploadsBytes: uploads.bytes,
    uploadsRoot: uploadsRoot(),
  };
  writeFileSync(manifestPath(date), JSON.stringify(manifest, null, 2));

  const removed = pruneOldBackups();
  if (removed.length > 0) {
    console.log(`[applypilot] backup retention removed ${String(removed.length)} old file(s)`);
  }
  return manifest;
}

/** True when today already has a finished backup with both files present. */
export function backupForTodayIsDone(): boolean {
  const manifest = readManifest(today());
  if (!manifest) return false;
  return existsSync(manifest.databaseFile) && existsSync(manifest.uploadsFile);
}

export type ScheduleOutcome =
  | { ran: true; manifest: BackupManifest }
  | { ran: false; reason: string; error?: string };

/** Runs the day's backup if it is due (after BACKUP_HOUR and not already done). */
export function runScheduledBackupIfDue(now: Date = new Date()): ScheduleOutcome {
  if (now.getHours() < BACKUP_HOUR) {
    return { ran: false, reason: `before ${String(BACKUP_HOUR)}:00 local` };
  }
  if (backupForTodayIsDone()) return { ran: false, reason: "already backed up today" };
  try {
    return { ran: true, manifest: runBackup({ trigger: "schedule" }) };
  } catch (error) {
    return {
      ran: false,
      reason: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Starts the in-process nightly check. Called from serve.ts: the site server is
 * the one long-running process this app owns, so it is where a scheduled job
 * belongs — no cron daemon needed, and a missed day is picked up the next time
 * the process is awake after 03:00.
 */
export function startBackupScheduler(intervalMinutes = 20, log: (message: string) => void = console.log): () => void {
  const tick = (): void => {
    const outcome = runScheduledBackupIfDue();
    if (outcome.ran) {
      log(
        `[applypilot] nightly backup written: ${outcome.manifest.databaseFile} ` +
          `(${String(outcome.manifest.databaseBytes)} bytes, uploads ${String(outcome.manifest.uploadsFiles)} files)`
      );
    } else if (outcome.error) {
      log(`[applypilot] nightly backup FAILED: ${outcome.error}`);
    }
  };
  // Run shortly after boot (the process may have been off at 03:00), then on a timer.
  const boot = setTimeout(tick, 30_000);
  const timer = setInterval(tick, Math.max(1, intervalMinutes) * 60_000);
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}

/** Scratch-restore helpers, used by scripts/restore-check.ts. */
export function extractBackupTo(manifest: BackupManifest, targetDir: string): {
  databaseFile: string;
  uploadsDir: string;
  files: string[];
} {
  mkdirSync(targetDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", manifest.uploadsFile, "-C", targetDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar -x failed (${String(result.status)}): ${result.stderr || "no output"}`);
  }
  const files = readdirSync(targetDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? targetDir, entry.name));
  return { databaseFile: manifest.databaseFile, uploadsDir: targetDir, files };
}
