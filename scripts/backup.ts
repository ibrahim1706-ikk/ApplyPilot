/**
 * Manual backup: `bun run backup` from the site directory.
 *
 * The same code path the nightly scheduler uses (see src/server/backup.ts), so a
 * daily run and an on-demand run produce identical artefacts. Prints the manifest
 * it wrote — row counts included — so the run is verifiable from its own output.
 */
import { runBackup } from "../src/server/backup";

const manifest = runBackup({ trigger: "cli" });
console.log(`backup written for ${manifest.date}`);
console.log(`  database: ${manifest.databaseFile} (${String(manifest.databaseBytes)} bytes)`);
console.log(`  uploads:  ${manifest.uploadsFile} (${String(manifest.uploadsFiles)} files, ${String(manifest.uploadsBytes)} bytes)`);
console.log("  row counts:");
for (const [table, count] of Object.entries(manifest.rowCounts)) {
  console.log(`    ${table}: ${String(count)}`);
}
console.log(`  sha256:   ${manifest.databaseSha256}`);
