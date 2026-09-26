/**
 * Account check: `bun run account-check <email|user-id>` from the site directory.
 *
 * Answers one question with evidence: does any row anywhere still belong to this
 * person, and is any of their uploaded file still on disk? Used to verify that
 * "Delete my account" really removed everything, and to find leftovers from test
 * accounts created before the delete flow existed.
 *
 * Exit code 0 = nothing left anywhere. Non-zero = something is still there, and
 * it is printed.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as db from "../src/db";

const needle = process.argv[2];
if (!needle) {
  console.error("usage: bun run account-check <email|user-id>");
  process.exit(2);
}

const looksLikeEmail = needle.includes("@");
const user = looksLikeEmail
  ? (db.findUserByEmail(needle.trim()) as { id: string; email: string } | null)
  : ({ id: needle, email: "" } as { id: string; email: string });

const userId = user?.id ?? needle;
const counts = db.countRowsForUser(userId);
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

const uploadsDir = join(db.uploadsRoot(), userId);
let uploadFiles = 0;
let uploadBytes = 0;
if (existsSync(uploadsDir)) {
  for (const entry of readdirSync(uploadsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    uploadFiles += 1;
    uploadBytes += statSync(join(entry.parentPath ?? uploadsDir, entry.name)).size;
  }
}

console.log(`account: ${needle}${user?.email ? `  (user id ${userId})` : `  (treated as user id)`}`);
console.log("");
console.log("  table                rows");
console.log("  -------------------  ----");
for (const [table, count] of Object.entries(counts)) {
  console.log(`  ${table.padEnd(19)}  ${String(count).padStart(4)}  ${count === 0 ? "ok" : "PRESENT"}`);
}
console.log("");
console.log(
  `  uploads directory:   ${existsSync(uploadsDir) ? `${uploadsDir} — ${String(uploadFiles)} file(s), ${String(uploadBytes)} bytes` : "not present (ok)"}`
);
console.log("");

const leftovers = total + uploadFiles;
if (leftovers > 0) {
  console.log(`NOT CLEAN — ${String(total)} database row(s) and ${String(uploadFiles)} upload file(s) still present.`);
  process.exit(1);
}
console.log("CLEAN — no database rows and no uploaded files for this account.");
