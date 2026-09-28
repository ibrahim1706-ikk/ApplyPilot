/**
 * ApplyPilot data layer — the ONE module in this app that touches the database.
 *
 * Storage is a SQLite file (`data/applypilot.db`, next to site.json — gitignored)
 * opened with Bun's built-in `bun:sqlite`, so the app needs no external service
 * and no credentials. Every read/write in the product goes through the functions
 * exported here; nothing else imports `bun:sqlite` or writes SQL. That keeps the
 * swap to a managed Postgres a single-file change later: reimplement these
 * functions against `DATABASE_URL` and delete the SQLite bits.
 *
 * Only import this from server-only code (a `createServerFn()` handler). Never
 * from a component.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

// ---------------------------------------------------------------- site root ---

/**
 * Find the site directory (the folder holding site.json) by walking up from the
 * working directory and from this module. The built server lives in dist/server,
 * so `import.meta.dir` alone would put the data file inside dist/ and a rebuild
 * would wipe every account — resolve to the real site dir instead.
 */
function findSiteRoot(): string {
  const starts = [process.cwd(), import.meta.dir];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "site.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const SITE_ROOT = findSiteRoot();

// ------------------------------------------------------------- data location ---

/**
 * Durable state — the SQLite database, the uploaded originals, the backups —
 * lives OUTSIDE the directory the site is published from, and this is the fix
 * for a real, observed data loss: a publish rebuilds the deployed copy of this
 * folder, so anything written inside it (`data/applypilot.db`, `data/uploads/…`)
 * is replaced by whatever the shipped bundle contains. Every account, résumé and
 * kit a person had created was lost on the next publish.
 *
 *   APPLYPILOT_DATA_DIR   explicit override — absolute paths only
 *   default               two levels above the site dir, in a `.data` folder:
 *                         `/home/team/shared/site` → `/home/team/.data/applypilot`
 *
 * `ensureDataDir()` creates it on first use and proves it is writable. If it is
 * not, this module throws rather than quietly opening an empty store: a silent
 * empty database is the exact failure being fixed here, so it must never be the
 * fallback.
 */
function defaultDataDir(): string {
  return normalize(join(SITE_ROOT, "..", "..", ".data", "applypilot"));
}

/** Where durable state lives (absolute), and how that path was chosen. */
export type DataLocation = {
  dir: string;
  database: string;
  uploads: string;
  source: "APPLYPILOT_DATA_DIR" | "default";
  /** True when the store sits inside the published folder — a publish resets it. */
  insideSiteRoot: boolean;
};

function resolveDataDir(): DataLocation {
  const override = process.env.APPLYPILOT_DATA_DIR?.trim();
  let dir: string;
  let source: DataLocation["source"];
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `[applypilot] APPLYPILOT_DATA_DIR must be an absolute path, got "${override}" — ` +
          "a relative path would depend on the process working directory."
      );
    }
    dir = normalize(override);
    source = "APPLYPILOT_DATA_DIR";
  } else {
    dir = defaultDataDir();
    source = "default";
  }
  // A more specific override still wins for the individual artefacts, so an
  // existing deployment that pinned one of these keeps working.
  const database = process.env.APPLYPILOT_DB_PATH ?? join(dir, "applypilot.db");
  const uploads = process.env.APPLYPILOT_UPLOADS_PATH ?? join(dir, "uploads");
  const insideSiteRoot = dir === SITE_ROOT || dir.startsWith(SITE_ROOT + "/");
  return { dir, database, uploads, source, insideSiteRoot };
}

const LOCATION = resolveDataDir();

/**
 * Creates the data directory (and its parents) and proves it is writable by
 * writing and removing a probe file — a directory can exist and still reject
 * writes, and finding that out on the first signup would be too late.
 *
 * Throws with an actionable message; callers at the edges of the app surface it
 * loudly (serve.ts logs it at boot, and every DB use throws it again).
 */
export function ensureDataDir(dir: string = LOCATION.dir): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error(
      `[applypilot] cannot create the data directory ${dir} (${errorText(error)}). ` +
        "Point APPLYPILOT_DATA_DIR at a writable directory outside the published site folder."
    );
  }
  const probe = join(dir, `.write-probe-${String(process.pid)}`);
  try {
    writeFileSync(probe, "ok");
  } catch (error) {
    throw new Error(
      `[applypilot] the data directory ${dir} is not writable (${errorText(error)}). ` +
        "Refusing to start on a store that cannot be saved to — point APPLYPILOT_DATA_DIR " +
        "at a writable directory outside the published site folder."
    );
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // A probe file we cannot remove is not worth failing over.
    }
  }
  return dir;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The resolved storage layout — used for the boot log and diagnostics. */
export function dataLocation(): DataLocation {
  return LOCATION;
}

/** The directory holding the database, the uploads and the backups. */
export function dataDir(): string {
  return LOCATION.dir;
}

/** Creates the directory on first use and fails loudly if it is unusable. */
function assertDataDirUsable(dir: string): void {
  ensureDataDir(dir);
  let stats;
  try {
    stats = statSync(dir);
  } catch (error) {
    throw new Error(`[applypilot] the data directory ${dir} is unusable (${errorText(error)})`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`[applypilot] ${dir} exists but is not a directory`);
  }
}

const DB_PATH = LOCATION.database;

/**
 * Uploaded originals live on disk in the data directory, NOT inside the
 * database and NOT in dist/ or the published folder: a rebuild replaces those,
 * and the real résumé file has to survive a republish because the browser agent
 * will attach it to a real application form later.
 */
const UPLOADS_DIR = LOCATION.uploads;


/** Absolute path of the folder holding every stored original. */
export function uploadsRoot(): string {
  return UPLOADS_DIR;
}

// -------------------------------------------------------------------- schema ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS profiles (
  user_id                 TEXT PRIMARY KEY,
  full_name               TEXT NOT NULL DEFAULT '',
  email                   TEXT NOT NULL DEFAULT '',
  phone                   TEXT NOT NULL DEFAULT '',
  location                TEXT NOT NULL DEFAULT '',
  portfolio_url           TEXT NOT NULL DEFAULT '',
  github_url              TEXT NOT NULL DEFAULT '',
  linkedin_url            TEXT NOT NULL DEFAULT '',
  resume_text             TEXT NOT NULL DEFAULT '',
  education_json          TEXT NOT NULL DEFAULT '[]',
  experience_json         TEXT NOT NULL DEFAULT '[]',
  work_authorisation      TEXT NOT NULL DEFAULT '',
  work_authorisation_note TEXT NOT NULL DEFAULT '',
  salary_expectation      TEXT NOT NULL DEFAULT '',
  notice_period           TEXT NOT NULL DEFAULT '',
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  company      TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  posting_text TEXT NOT NULL DEFAULT '',
  kit_json     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS materials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT 'Other',
  is_resume      INTEGER NOT NULL DEFAULT 0,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  stored_path    TEXT NOT NULL,
  extract_status TEXT NOT NULL DEFAULT 'ok',
  extract_note   TEXT NOT NULL DEFAULT '',
  extracted_text TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_user_idx ON materials(user_id, created_at);

-- Password-reset tokens. The raw token only ever exists in the reset link we
-- hand to the user; what lands here is its SHA-256, exactly like session tokens,
-- so a copy of this file cannot be turned into a usable reset link. Single use
-- (used_at) and time-boxed (expires_at).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);

-- Rate-limit counters. One row per counted attempt; the limiter counts rows for
-- a (scope, bucket) pair inside a moving window. Deliberately dumb and honest:
-- no in-memory state to lose on restart, and the rows are pruned as they age out.
CREATE TABLE IF NOT EXISTS rate_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  bucket     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_idx ON rate_events(scope, bucket, created_at);
-- The extracted qualifications facts: what we read out of the user's own
-- résumé text and vault fields, with the quote each fact came from. One row per
-- account — the fact set is small (tens of rows of JSON) and it is always
-- replaced as a whole, so a single row is both simpler and safer than a table
-- of facts that could drift out of step with the input it was read from.
--
-- The input_hash column fingerprints the material the facts were read from. When the
-- user edits their résumé text or their vault fields the fingerprint changes,
-- and the next read re-runs the extractor instead of showing stale facts.
-- Plain TEXT/DELETE-then-INSERT only, so this table carries over to Postgres
-- unchanged when the store is swapped for a managed database.
CREATE TABLE IF NOT EXISTS qualifications (
  user_id      TEXT PRIMARY KEY,
  facts_json   TEXT NOT NULL DEFAULT '[]',
  report_json  TEXT NOT NULL DEFAULT '{}',
  input_hash   TEXT NOT NULL DEFAULT '',
  computed_at  TEXT NOT NULL
);

-- What the user decided about those facts: kept, corrected, excluded, or added
-- themselves — plus when they confirmed a set and a fingerprint of the set they
-- confirmed. Kept in its own row (not inside facts_json) for one reason: facts are
-- recomputed whenever the résumé or the vault changes, and a recompute must never
-- take the user's decisions with it. JSON columns stay opaque here — the shape
-- lives in src/types.ts.
CREATE TABLE IF NOT EXISTS qualification_decisions (
  user_id            TEXT PRIMARY KEY,
  decisions_json     TEXT NOT NULL DEFAULT '[]',
  confirmations_json TEXT NOT NULL DEFAULT '{}',
  updated_at         TEXT NOT NULL
);
`;

// ---------------------------------------------------------------- connection ---

let handle: Database | null = null;

function db(): Database {
  if (handle) return handle;
  // Create (and prove writable) the directories this store needs before opening
  // the file, so a bad location throws a message that says what to fix instead
  // of a bare SQLite CANTOPEN.
  assertDataDirUsable(dirname(DB_PATH));
  assertDataDirUsable(UPLOADS_DIR);
  if (LOCATION.insideSiteRoot) {
    console.warn(
      `[applypilot] WARNING: durable state is inside the published site folder (${LOCATION.dir}). ` +
        "Publishing replaces that folder, which resets every account and upload. " +
        "Set APPLYPILOT_DATA_DIR to a path outside it."
    );
  }
  const next = new Database(DB_PATH, { create: true });
  next.exec("PRAGMA journal_mode = WAL;");
  next.exec("PRAGMA foreign_keys = ON;");
  next.exec(SCHEMA);
  handle = next;
  return handle;
}

/**
 * Creates the store and reports where it is, for the boot log. Called from
 * serve.ts so a data location that is missing or read-only is visible at startup
 * rather than at someone's first signup. Throws when the store is unusable; the
 * caller decides how loud to be about it.
 */
export function storageReport(): {
  location: DataLocation;
  users: number;
  tables: Record<string, number>;
} {
  assertDataDirUsable(LOCATION.dir);
  const users = databaseInfo().users;
  return { location: LOCATION, users, tables: tableCounts() };
}

/** Small helper so callers never hold a raw statement. */
function all<T>(sql: string, params: unknown[] = []): T[] {
  return db()
    .query(sql)
    .all(...(params as never[])) as T[];
}
function one<T>(sql: string, params: unknown[] = []): T | null {
  const row = db()
    .query(sql)
    .get(...(params as never[]));
  return (row as T | undefined) ?? null;
}
function run(sql: string, params: unknown[] = []): void {
  db()
    .query(sql)
    .run(...(params as never[]));
}

export function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

// --------------------------------------------------------------------- users ---

export type User = { id: string; email: string; created_at: string };

export function createUser(email: string, passwordHash: string): User {
  const id = newId();
  const createdAt = nowIso();
  run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [
    id,
    email,
    passwordHash,
    createdAt,
  ]);
  return { id, email, created_at: createdAt };
}

export function findUserByEmail(email: string): (User & { password_hash: string }) | null {
  return one<User & { password_hash: string }>(
    "SELECT id, email, password_hash, created_at FROM users WHERE lower(email) = lower(?)",
    [email]
  );
}

export function emailTaken(email: string): boolean {
  return one<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower(?)", [email]) !== null;
}

// ------------------------------------------------------------------ sessions ---

export function createSession(tokenHash: string, userId: string, expiresAt: string): void {
  run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
    tokenHash,
    userId,
    nowIso(),
    expiresAt,
  ]);
}

/** Returns the signed-in user for a session token hash, or null if unknown/expired. */
export function findSessionUser(tokenHash: string): User | null {
  const row = one<User & { expires_at: string }>(
    `SELECT u.id AS id, u.email AS email, u.created_at AS created_at, s.expires_at AS expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [tokenHash]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(tokenHash);
    return null;
  }
  return { id: row.id, email: row.email, created_at: row.created_at };
}

export function deleteSession(tokenHash: string): void {
  run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

export function deleteExpiredSessions(): void {
  run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
}

// ------------------------------------------------------------------ profiles ---

export type ExperienceEntry = {
  title: string;
  company: string;
  start: string;
  end: string;
  description: string;
};
export type EducationEntry = {
  school: string;
  qualification: string;
  dates: string;
  details: string;
};

export type Profile = {
  full_name: string;
  email: string;
  phone: string;
  location: string;
  portfolio_url: string;
  github_url: string;
  linkedin_url: string;
  resume_text: string;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  work_authorisation: string;
  work_authorisation_note: string;
  salary_expectation: string;
  notice_period: string;
  updated_at: string;
};

export const EMPTY_PROFILE: Profile = {
  full_name: "",
  email: "",
  phone: "",
  location: "",
  portfolio_url: "",
  github_url: "",
  linkedin_url: "",
  resume_text: "",
  education: [],
  experience: [],
  work_authorisation: "",
  work_authorisation_note: "",
  salary_expectation: "",
  notice_period: "",
  updated_at: "",
};

type ProfileRow = Omit<Profile, "education" | "experience"> & {
  education_json: string;
  experience_json: string;
};

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function getProfile(userId: string): Profile {
  const row = one<ProfileRow>("SELECT * FROM profiles WHERE user_id = ?", [userId]);
  if (!row) return { ...EMPTY_PROFILE };
  const { education_json, experience_json, ...rest } = row;
  return {
    ...rest,
    education: parseJsonArray<EducationEntry>(education_json),
    experience: parseJsonArray<ExperienceEntry>(experience_json),
  };
}

export function saveProfile(userId: string, profile: Profile): void {
  const updatedAt = nowIso();
  run(
    `INSERT INTO profiles (
        user_id, full_name, email, phone, location, portfolio_url, github_url, linkedin_url,
        resume_text, education_json, experience_json, work_authorisation, work_authorisation_note,
        salary_expectation, notice_period, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
        full_name = excluded.full_name,
        email = excluded.email,
        phone = excluded.phone,
        location = excluded.location,
        portfolio_url = excluded.portfolio_url,
        github_url = excluded.github_url,
        linkedin_url = excluded.linkedin_url,
        resume_text = excluded.resume_text,
        education_json = excluded.education_json,
        experience_json = excluded.experience_json,
        work_authorisation = excluded.work_authorisation,
        work_authorisation_note = excluded.work_authorisation_note,
        salary_expectation = excluded.salary_expectation,
        notice_period = excluded.notice_period,
        updated_at = excluded.updated_at`,
    [
      userId,
      profile.full_name,
      profile.email,
      profile.phone,
      profile.location,
      profile.portfolio_url,
      profile.github_url,
      profile.linkedin_url,
      profile.resume_text,
      JSON.stringify(profile.education),
      JSON.stringify(profile.experience),
      profile.work_authorisation,
      profile.work_authorisation_note,
      profile.salary_expectation,
      profile.notice_period,
      updatedAt,
    ]
  );
}

// -------------------------------------------------------------- applications ---

export type Application = {
  id: string;
  user_id: string;
  title: string;
  company: string;
  url: string;
  posting_text: string;
  kit_json: string | null;
  created_at: string;
  updated_at: string;
};

export function createApplication(input: {
  userId: string;
  title: string;
  company: string;
  url: string;
  postingText: string;
}): Application {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO applications (id, user_id, title, company, url, posting_text, kit_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [id, input.userId, input.title, input.company, input.url, input.postingText, now, now]
  );
  const created = getApplication(input.userId, id);
  if (!created) throw new Error("Application insert failed");
  return created;
}

export function getApplication(userId: string, id: string): Application | null {
  return one<Application>("SELECT * FROM applications WHERE id = ? AND user_id = ?", [id, userId]);
}

export function listApplications(userId: string): Application[] {
  return all<Application>(
    "SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC",
    [userId]
  );
}

export function saveKit(userId: string, id: string, kitJson: string): void {
  run("UPDATE applications SET kit_json = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
    kitJson,
    nowIso(),
    id,
    userId,
  ]);
}

export function updateApplicationDetails(
  userId: string,
  id: string,
  details: { title: string; company: string }
): void {
  run("UPDATE applications SET title = ?, company = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
    details.title,
    details.company,
    nowIso(),
    id,
    userId,
  ]);
}

export function deleteApplication(userId: string, id: string): void {
  run("DELETE FROM applications WHERE id = ? AND user_id = ?", [id, userId]);
}

/** Test/diagnostic only: proves the file-backed database is reachable. */
export function databaseInfo(): { path: string; users: number } {
  const row = one<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return { path: DB_PATH, users: row?.n ?? 0 };
}

// ------------------------------------------------------------------ materials ---

export type Material = {
  id: string;
  user_id: string;
  label: string;
  /** 1 when this upload also fills the profile's résumé text. */
  is_resume: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Path of the stored original, relative to `uploadsRoot()`. */
  stored_path: string;
  extract_status: string;
  extract_note: string;
  extracted_text: string;
  created_at: string;
};

export function countMaterials(userId: string): number {
  const row = one<{ n: number }>("SELECT COUNT(*) AS n FROM materials WHERE user_id = ?", [userId]);
  return row?.n ?? 0;
}

export function createMaterial(input: {
  userId: string;
  label: string;
  isResume: boolean;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  extractStatus: string;
  extractNote: string;
  extractedText: string;
}): Material {
  const id = newId();
  const createdAt = nowIso();
  run(
    `INSERT INTO materials (
        id, user_id, label, is_resume, filename, mime_type, size_bytes, stored_path,
        extract_status, extract_note, extracted_text, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.label,
      input.isResume ? 1 : 0,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.storedPath,
      input.extractStatus,
      input.extractNote,
      input.extractedText,
      createdAt,
    ]
  );
  const created = getMaterial(input.userId, id);
  if (!created) throw new Error("Material insert failed");
  return created;
}

export function getMaterial(userId: string, id: string): Material | null {
  return one<Material>("SELECT * FROM materials WHERE id = ? AND user_id = ?", [id, userId]);
}

export function listMaterials(userId: string): Material[] {
  return all<Material>(
    "SELECT * FROM materials WHERE user_id = ? ORDER BY created_at ASC",
    [userId]
  );
}

export function deleteMaterial(userId: string, id: string): void {
  run("DELETE FROM materials WHERE id = ? AND user_id = ?", [id, userId]);
}

// ------------------------------------------------------- password + resets ---

export function updatePassword(userId: string, passwordHash: string): void {
  run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);
}

export function createPasswordReset(tokenHash: string, userId: string, expiresAt: string): void {
  run(
    "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
    [tokenHash, userId, nowIso(), expiresAt]
  );
}

/** Unused, unexpired reset token → the user it belongs to. Null for anything else. */
export function findResetUser(tokenHash: string): { user_id: string; expires_at: string } | null {
  const row = one<{ user_id: string; expires_at: string; used_at: string | null }>(
    "SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?",
    [tokenHash]
  );
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { user_id: row.user_id, expires_at: row.expires_at };
}

/**
 * Spends a reset token, atomically, and hands back whose it was. The UPDATE is
 * guarded on `used_at IS NULL`, so two requests arriving with the same link at
 * the same moment cannot both win: exactly one sees `changes === 1`. Null means
 * the link is unknown, expired, or already used — the caller must not say which.
 */
export function claimReset(tokenHash: string): { user_id: string } | null {
  const row = findResetUser(tokenHash);
  if (!row) return null;
  const result = db()
    .query("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .run(nowIso(), tokenHash);
  if (result.changes !== 1) return null;
  return { user_id: row.user_id };
}

/** Called after a successful reset and before reissuing a token (one live link at a time). */
export function deleteResetsForUser(userId: string): number {
  const before = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?",
    [userId]
  );
  run("DELETE FROM password_resets WHERE user_id = ?", [userId]);
  return before?.n ?? 0;
}

export function deleteExpiredResets(): void {
  run("DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL", [nowIso()]);
}

/** Signs the account out everywhere — used after a password reset. */
export function deleteSessionsForUser(userId: string): number {
  const before = one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [userId]);
  run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  return before?.n ?? 0;
}

// ------------------------------------------------------------- rate limits ---

export function recordRateEvent(scope: string, bucket: string): void {
  run("INSERT INTO rate_events (scope, bucket, created_at) VALUES (?, ?, ?)", [
    scope,
    bucket,
    nowIso(),
  ]);
}

export function countRateEvents(scope: string, bucket: string, sinceIso: string): number {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM rate_events WHERE scope = ? AND bucket = ? AND created_at >= ?",
    [scope, bucket, sinceIso]
  );
  return row?.n ?? 0;
}

/** Oldest event inside the window, so a blocked caller can be told when to retry. */
export function oldestRateEvent(scope: string, bucket: string, sinceIso: string): string | null {
  const row = one<{ created_at: string }>(
    "SELECT created_at FROM rate_events WHERE scope = ? AND bucket = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1",
    [scope, bucket, sinceIso]
  );
  return row?.created_at ?? null;
}

export function pruneRateEvents(beforeIso: string): void {
  run("DELETE FROM rate_events WHERE created_at < ?", [beforeIso]);
}

// ------------------------------------------------- qualifications facts ---
/**
 * One stored extraction for an account. The JSON columns are opaque here: the
 * storage module keeps whatever the qualifications module wrote and hands it
 * back, so the fact shape stays defined in one place (`src/types.ts`).
 */
export type StoredQualifications = {
  user_id: string;
  facts_json: string;
  report_json: string;
  input_hash: string;
  computed_at: string;
};
export function getQualifications(userId: string): StoredQualifications | null {
  return one<StoredQualifications>(
    "SELECT user_id, facts_json, report_json, input_hash, computed_at FROM qualifications WHERE user_id = ?",
    [userId]
  );
}
/**
 * Replaces the stored extraction. DELETE-then-INSERT rather than an upsert
 * because `INSERT OR REPLACE`/`ON CONFLICT` are engine-specific and this module
 * has to move to a managed Postgres unchanged. A crash between the two
 * statements leaves no row, which the reader treats as "recompute me" — the safe
 * failure, not a stale one.
 */
export function saveQualifications(
  userId: string,
  input: { factsJson: string; reportJson: string; inputHash: string; computedAt: string }
): void {
  run("DELETE FROM qualifications WHERE user_id = ?", [userId]);
  run(
    "INSERT INTO qualifications (user_id, facts_json, report_json, input_hash, computed_at) VALUES (?, ?, ?, ?, ?)",
    [userId, input.factsJson, input.reportJson, input.inputHash, input.computedAt]
  );
}
export function deleteQualifications(userId: string): void {
  run("DELETE FROM qualifications WHERE user_id = ?", [userId]);
}

/**
 * The user's own decisions about the facts (kept / corrected / excluded / added)
 * and their confirmations. One row per account, opaque JSON — the same
 * DELETE-then-INSERT write as everywhere else, so this moves to a managed
 * Postgres unchanged.
 */
export type StoredQualificationsDecisions = {
  user_id: string;
  decisions_json: string;
  confirmations_json: string;
  updated_at: string;
};
export function getQualificationDecisions(userId: string): StoredQualificationsDecisions | null {
  return one<StoredQualificationsDecisions>(
    "SELECT user_id, decisions_json, confirmations_json, updated_at FROM qualification_decisions WHERE user_id = ?",
    [userId]
  );
}
export function saveQualificationDecisions(
  userId: string,
  input: { decisionsJson: string; confirmationsJson: string; updatedAt: string }
): void {
  run("DELETE FROM qualification_decisions WHERE user_id = ?", [userId]);
  run(
    "INSERT INTO qualification_decisions (user_id, decisions_json, confirmations_json, updated_at) VALUES (?, ?, ?, ?)",
    [userId, input.decisionsJson, input.confirmationsJson, input.updatedAt]
  );
}
export function deleteQualificationDecisions(userId: string): void {
  run("DELETE FROM qualification_decisions WHERE user_id = ?", [userId]);
}
// --------------------------------------------------------- deleting an account ---
//
// One function, one transaction, every table that holds anything about the
// person. Returns what it removed plus the on-disk material files, which the
// caller deletes from the uploads directory (the data layer never touches files).

export type DeletedAccount = {
  email: string;
  users: number;
  profiles: number;
  applications: number;
  materials: number;
  sessions: number;
  resets: number;
  rateEvents: number;
  /** The stored qualifications fact set for this account, if it had one. */
  qualifications: number;
  /** The user's own fact decisions and confirmations, if they had any. */
  qualificationDecisions: number;
  /** Stored paths of the user's uploaded originals, relative to `uploadsRoot()`/userId. */
  materialPaths: string[];
};

export function deleteAccount(userId: string): DeletedAccount | null {
  const user = one<User>("SELECT id, email, created_at FROM users WHERE id = ?", [userId]);
  if (!user) return null;

  const materials = all<{ stored_path: string }>(
    "SELECT stored_path FROM materials WHERE user_id = ?",
    [userId]
  );
  const counts = (sql: string): number => one<{ n: number }>(sql, [userId])?.n ?? 0;
  const deleted: DeletedAccount = {
    email: user.email,
    users: counts("SELECT COUNT(*) AS n FROM users WHERE id = ?"),
    profiles: counts("SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?"),
    applications: counts("SELECT COUNT(*) AS n FROM applications WHERE user_id = ?"),
    materials: counts("SELECT COUNT(*) AS n FROM materials WHERE user_id = ?"),
    sessions: counts("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?"),
    resets: counts("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?"),
    qualifications: counts("SELECT COUNT(*) AS n FROM qualifications WHERE user_id = ?"),
    qualificationDecisions: counts("SELECT COUNT(*) AS n FROM qualification_decisions WHERE user_id = ?"),
    rateEvents: 0,
    materialPaths: materials.map((m) => m.stored_path),
  };

  db().transaction(() => {
    run("DELETE FROM materials WHERE user_id = ?", [userId]);
    run("DELETE FROM applications WHERE user_id = ?", [userId]);
    run("DELETE FROM profiles WHERE user_id = ?", [userId]);
    run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    run("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    run("DELETE FROM qualifications WHERE user_id = ?", [userId]);
    run("DELETE FROM qualification_decisions WHERE user_id = ?", [userId]);
    run("DELETE FROM users WHERE id = ?", [userId]);
  })();

  return deleted;
}

/** Row counts per table for one user — used to prove a deletion left nothing behind. */
export function countRowsForUser(userId: string): Record<string, number> {
  const count = (sql: string, params: unknown[]): number =>
    one<{ n: number }>(sql, params)?.n ?? 0;
  return {
    users: count("SELECT COUNT(*) AS n FROM users WHERE id = ?", [userId]),
    profiles: count("SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?", [userId]),
    applications: count("SELECT COUNT(*) AS n FROM applications WHERE user_id = ?", [userId]),
    materials: count("SELECT COUNT(*) AS n FROM materials WHERE user_id = ?", [userId]),
    sessions: count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [userId]),
    password_resets: count("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?", [userId]),
    qualifications: count("SELECT COUNT(*) AS n FROM qualifications WHERE user_id = ?", [userId]),
    qualification_decisions: count(
      "SELECT COUNT(*) AS n FROM qualification_decisions WHERE user_id = ?",
      [userId]
    ),
  };
}

// ------------------------------------------------------------- data export ---

export type AccountExport = {
  account: { email: string; createdAt: string };
  profile: Profile;
  materials: Array<{
    label: string;
    isResume: boolean;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    extractionStatus: string;
    extractionNote: string;
    extractedText: string;
    uploadedAt: string;
  }>;
  applications: Array<{
    title: string;
    company: string;
    url: string;
    postingText: string;
    kit: unknown;
    createdAt: string;
    updatedAt: string;
  }>;
  /** The qualifications facts read from this account's own material. */
  qualifications: {
    facts: unknown;
    report: unknown;
    computedAt: string;
    /** The user's own decisions about those facts (kept / corrected / excluded / added). */
    decisions: unknown;
    /** When they confirmed a set, and a fingerprint of the set they confirmed. */
    confirmations: unknown;
    decisionsUpdatedAt: string | null;
  } | null;
};

/**
 * Everything this account holds, as plain data. Scoped by `userId` on every
 * query — there is no path here that can reach another account's rows.
 */
export function exportAccount(userId: string): AccountExport | null {
  const user = one<User>("SELECT id, email, created_at FROM users WHERE id = ?", [userId]);
  if (!user) return null;
  return {
    account: { email: user.email, createdAt: user.created_at },
    profile: getProfile(userId),
    materials: listMaterials(userId).map((material) => ({
      label: material.label,
      isResume: material.is_resume === 1,
      filename: material.filename,
      mimeType: material.mime_type,
      sizeBytes: material.size_bytes,
      extractionStatus: material.extract_status,
      extractionNote: material.extract_note,
      extractedText: material.extracted_text,
      uploadedAt: material.created_at,
    })),
    applications: listApplications(userId).map((application) => ({
      title: application.title,
      company: application.company,
      url: application.url,
      postingText: application.posting_text,
      kit: parseUnknownJson(application.kit_json),
      createdAt: application.created_at,
      updatedAt: application.updated_at,
    })),
    qualifications: readQualificationsForExport(userId),
  };
}
/** The stored fact set, as plain data, for the account export. */
function readQualificationsForExport(userId: string): AccountExport["qualifications"] {
  const stored = getQualifications(userId);
  const decisions = getQualificationDecisions(userId);
  if (!stored && !decisions) return null;
  return {
    facts: parseUnknownJson(stored?.facts_json ?? null),
    report: parseUnknownJson(stored?.report_json ?? null),
    computedAt: stored?.computed_at ?? "",
    // The user's own words — kept, corrected, excluded, added — belong in their
    // export just as much as the facts we read for them.
    decisions: parseUnknownJson(decisions?.decisions_json ?? null),
    confirmations: parseUnknownJson(decisions?.confirmations_json ?? null),
    decisionsUpdatedAt: decisions?.updated_at ?? null,
  };
}

function parseUnknownJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- backups ---

/** Total rows in the tables a restore has to reproduce. */
export function tableCounts(): Record<string, number> {
  const names = [
    "users",
    "sessions",
    "profiles",
    "applications",
    "materials",
    "password_resets",
    "qualifications",
    "qualification_decisions",
  ];
  const out: Record<string, number> = {};
  for (const name of names) {
    // `name` comes from this fixed list, never from input.
    out[name] = one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0;
  }
  return out;
}

/** Flushes WAL pages into the main database file before it is copied. */
export function checkpoint(): void {
  db().exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/**
 * Writes a consistent, self-contained snapshot of the database to `path`
 * (SQLite's own VACUUM INTO — the destination must not already exist). Safer
 * than copying the file while the app is running: the snapshot is taken inside
 * a transaction, so a concurrent write cannot leave a torn backup.
 */
export function vacuumInto(path: string): void {
  db().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}

/** Where the database file itself lives (used by the backup/verify tooling). */
export function databasePath(): string {
  return DB_PATH;
}
