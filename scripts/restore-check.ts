/**
 * Restore check: `bun run restore-check` from the site directory.
 *
 * Restores the newest backup (or `--date YYYY-MM-DD`) into a scratch directory
 * and proves the restore is complete by comparing the restored row counts and
 * uploads file count against the manifest written at backup time. Nothing here
 * touches the live database or the live uploads directory — it is a rehearsal,
 * not a restore in place.
 *
 *   bun run restore-check
 *   bun run restore-check --date 2026-09-26
 *   bun run restore-check --to /tmp/wherever
 *
 * Exit code 0 = every count matched. Non-zero = something did not, and the
 * mismatch is printed. See docs/BACKUP-AND-RESTORE.md for restoring for real.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractBackupTo, listBackups, readManifest, type BackupManifest } from "../src/server/backup";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const TABLES = ["users", "sessions", "profiles", "applications", "materials", "password_resets"];

function countUploads(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? dir, entry.name);
    files += 1;
    bytes += statSync(full).size;
  }
  return { files, bytes };
}

const wanted = arg("date");
const manifest: BackupManifest | null = wanted ? readManifest(wanted) : (listBackups()[0] ?? null);
if (!manifest) {
  console.error(
    wanted
      ? `No backup manifest for ${wanted}. Looked in the backup directory for backup-${wanted}.json.`
      : "No backups found. Run `bun run backup` first."
  );
  process.exit(2);
}
if (!existsSync(manifest.databaseFile) || !existsSync(manifest.uploadsFile)) {
  console.error(`Backup ${manifest.date} is incomplete: a file named in the manifest is missing.`);
  process.exit(2);
}

const target = arg("to") ?? join("/tmp", `applypilot-restore-${manifest.date}-${String(Date.now())}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// 1. the database — the snapshot is already a consistent single file
const restoredDb = join(target, "applypilot.db");
copyFileSync(manifest.databaseFile, restoredDb);

// 2. the uploads directory, exactly as the tar holds it
const restoredUploads = join(target, "uploads");
const extracted = extractBackupTo(manifest, restoredUploads);

console.log(`restoring backup ${manifest.date} (taken ${manifest.createdAt}) into ${target}`);
console.log(`  database: ${restoredDb}`);
console.log(`  uploads:  ${restoredUploads} (${String(extracted.files.length)} files extracted)`);
console.log("");
console.log("  table                backup   restored");
console.log("  -------------------  -------  --------");

const restored = new Database(restoredDb, { readonly: true });
let failed = 0;
for (const table of TABLES) {
  const row = restored.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  const restoredCount = row?.n ?? 0;
  const expected = manifest.rowCounts[table] ?? 0;
  const match = restoredCount === expected;
  if (!match) failed += 1;
  console.log(
    `  ${table.padEnd(19)}  ${String(expected).padStart(7)}  ${String(restoredCount).padStart(8)}  ${match ? "ok" : "MISMATCH"}`
  );
}
restored.close();

const uploads = countUploads(restoredUploads);
const uploadsMatch = uploads.files === manifest.uploadsFiles && uploads.bytes === manifest.uploadsBytes;
if (!uploadsMatch) failed += 1;
console.log(
  `  uploads (${String(uploads.files)} files, ${String(uploads.bytes)} bytes) vs manifest ` +
    `(${String(manifest.uploadsFiles)} files, ${String(manifest.uploadsBytes)} bytes) — ${uploadsMatch ? "ok" : "MISMATCH"}`
);
console.log("");

if (failed > 0) {
  console.error(`RESTORE CHECK FAILED — ${String(failed)} mismatch(es). The backup is not safe to rely on.`);
  process.exit(1);
}
console.log(`RESTORE CHECK PASSED — every count matches the manifest. Scratch copy at ${target}.`);
