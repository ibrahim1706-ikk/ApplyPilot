/**
 * ApplyPilot data layer — the ONE module in this app that touches the database.
 *
 * There are two stores, and `DATABASE_URL` picks between them:
 *
 *   DATABASE_URL set    → Postgres (Bun's built-in `Bun.sql`), reached from a
 *                         worker thread so the functions below stay synchronous
 *   DATABASE_URL unset  → a SQLite file (`data/applypilot.db`), opened with Bun's
 *                         built-in `bun:sqlite`
 *
 * This is the fix for a real, observed data loss: the deployed folder is rebuilt
 * on every publish, so a store that lives in it (or next to the shipped bundle)
 * is wiped when we ship. A managed Postgres holds the data off that machine.
 *
 * The switch is deliberately absolute. When `DATABASE_URL` is set the app talks
 * to it or it fails — it never falls back to the local file, because a silent
 * fallback would look like it was saving a real user's data while actually
 * writing to a store the next publish deletes. That failure mode is worse than
 * an error, so it is designed out rather than handled.
 *
 * Every read/write in the product goes through the functions exported here;
 * nothing else writes SQL, and no other module knows which store is in use. The
 * exported signatures are identical either way — callers do not change.
 *
 * Only import this from server-only code (a `createServerFn()` handler). Never
 * from a component.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { tmpdir } from "node:os";
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
/** Which store the app is talking to. Chosen once, from `DATABASE_URL`, at load. */
export type StoreBackend = "sqlite" | "postgres";

/** Where durable state lives (absolute), and how that path was chosen. */
export type DataLocation = {
  dir: string;
  /**
   * What the store points at, safe to log: the absolute path of the SQLite file
   * on the file backend, or the connection target with every credential removed
   * on the managed one. Never a password.
   */
  database: string;
  uploads: string;
  source: "APPLYPILOT_DATA_DIR" | "default";
  /** True when the store sits inside the published folder — a publish resets it. */
  insideSiteRoot: boolean;
  /** Which engine is in use — `sqlite` unless `DATABASE_URL` says otherwise. */
  backend: StoreBackend;
  /** True when the backend came from `DATABASE_URL` rather than a local file. */
  managed: boolean;
};

/**
 * Reads `DATABASE_URL`. Absent or blank → the local SQLite file, exactly as
 * before. Present → the managed Postgres, and then the only two outcomes are
 * "connected" and "a loud error"; there is no third path back to the file.
 *
 * A URL that cannot be parsed is reported here rather than at the first query, so
 * a mistyped secret shows up in the boot log instead of at somebody's signup.
 */
function readDatabaseUrl(): { url: string | null; problem: string | null } {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return { url: null, problem: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: null,
      problem:
        "DATABASE_URL is set but is not a valid connection URL (it could not be parsed). " +
        'A managed Postgres URL looks like "postgresql://user:password@host:5432/dbname".',
    };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return {
      url: null,
      problem:
        `DATABASE_URL is set but its scheme is "${parsed.protocol}" — this store speaks ` +
        'Postgres only ("postgres://" or "postgresql://").',
    };
  }
  if (!parsed.hostname || !parsed.pathname.replace(/^\/+/, "")) {
    return { url: null, problem: "DATABASE_URL is set but names no host and/or no database." };
  }
  return { url: raw, problem: null };
}

/** The same URL with the user name and password removed — the only form we log. */
function redactDatabaseUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const database = parsed.pathname.replace(/^\/+/, "");
    const port = parsed.port ? `:${parsed.port}` : "";
    const query = [...parsed.searchParams.keys()].length > 0 ? ` (params: ${[...parsed.searchParams.keys()].join(", ")})` : "";
    return `postgres at ${parsed.hostname}${port}/${database}${query}`;
  } catch {
    return "postgres at an unreadable URL";
  }
}

const DATABASE_URL = readDatabaseUrl();

// A set-but-unusable DATABASE_URL must stop the process, not fall back: an
// unparseable URL or a non-Postgres scheme is still an instruction to use a
// managed database, and quietly opening a local file instead would look like the
// user's data was being saved while writing it to a store the next publish
// deletes. Checked at load, so it is the first thing in the boot log.
if (DATABASE_URL.problem) {
  throw new Error(
    `[applypilot] ${DATABASE_URL.problem} Refusing to start on the local file backend: ` +
      "DATABASE_URL is set, so either it must reach a Postgres database or it must be removed."
  );
}

function defaultDataDir(): string {
  return normalize(join(SITE_ROOT, "..", "..", ".data", "applypilot"));
}

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
  const managed = DATABASE_URL.url !== null;
  return {
    dir,
    // On the managed backend this field is the redacted connection target, not a
    // file path — the boot log prints it, and a path there would be a lie.
    database: managed ? redactDatabaseUrl(DATABASE_URL.url as string) : database,
    uploads,
    source,
    insideSiteRoot,
    backend: managed ? "postgres" : "sqlite",
    managed,
  };
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

-- Funnel instrumentation: which of the five steps an account has reached, so we
-- can see where people stop instead of guessing. Deliberately the smallest table
-- in the store — a local user id, the step name, and when it happened:
--
--   (id, user_id, name, created_at)   and nothing else.
--
-- No step ever carries user content: no résumé or posting text, no answer, no
-- company or employer name, no email/name/phone, no IP address, no user agent.
-- First-party only: these rows go in this database and nowhere else — no
-- third-party analytics script, no external endpoint, no extra cookie.
--
-- One row per (account, step): the step is recorded the first time the user
-- really does the thing and never again, so the table reads directly as a funnel
-- (count rows per step = people who got that far). UNIQUE(user_id, name) is what
-- makes that true even if two requests race.
CREATE TABLE IF NOT EXISTS funnel_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS funnel_events_name_idx ON funnel_events(name, created_at);

-- The one application the user has chosen to take forward. This is the closest
-- thing to "apply" that exists: it marks the kit the user is carrying to the real
-- application form themselves. It is NOT a submit path — nothing is ever sent to
-- an employer from here — and the two-a-day cap is not enforced yet, because
-- nothing is submitted yet.
CREATE TABLE IF NOT EXISTS application_choices (
  user_id        TEXT NOT NULL,
  application_id TEXT NOT NULL,
  chosen_at      TEXT NOT NULL,
  PRIMARY KEY (user_id, application_id)
);
`;

/**
 * The same eleven tables on Postgres, column for column with the SQLite schema
 * above: text stays text (including the ISO timestamps, which are compared as
 * strings on both engines), integer stays integer — including the 0/1 flags,
 * which are deliberately NOT `boolean` so the values the app reads back are the
 * same numbers `bun:sqlite` hands it. Uniqueness, primary keys and defaults are
 * carried over one-for-one. The only shape that had to change is the SQLite
 * `INTEGER PRIMARY KEY AUTOINCREMENT` on `rate_events`, which Postgres spells
 * `integer GENERATED BY DEFAULT AS IDENTITY` — nothing reads that id.
 *
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` are idempotent on
 * Postgres too, so an empty managed database is usable with no manual step: the
 * schema is applied once, when the connection is first opened.
 *
 * NO CONNECTION STRING APPEARS HERE. Postgres-flavoured SQL lives only in this
 * module; every other module goes through the exported functions.
 */
const POSTGRES_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id            text PRIMARY KEY,
     email         text NOT NULL UNIQUE,
     password_hash text NOT NULL,
     created_at    text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash text PRIMARY KEY,
     user_id    text NOT NULL,
     created_at text NOT NULL,
     expires_at text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS profiles (
     user_id                 text PRIMARY KEY,
     full_name               text NOT NULL DEFAULT '',
     email                   text NOT NULL DEFAULT '',
     phone                   text NOT NULL DEFAULT '',
     location                text NOT NULL DEFAULT '',
     portfolio_url           text NOT NULL DEFAULT '',
     github_url              text NOT NULL DEFAULT '',
     linkedin_url            text NOT NULL DEFAULT '',
     resume_text             text NOT NULL DEFAULT '',
     education_json          text NOT NULL DEFAULT '[]',
     experience_json         text NOT NULL DEFAULT '[]',
     work_authorisation      text NOT NULL DEFAULT '',
     work_authorisation_note text NOT NULL DEFAULT '',
     salary_expectation      text NOT NULL DEFAULT '',
     notice_period           text NOT NULL DEFAULT '',
     updated_at              text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS applications (
     id           text PRIMARY KEY,
     user_id      text NOT NULL,
     title        text NOT NULL DEFAULT '',
     company      text NOT NULL DEFAULT '',
     url          text NOT NULL DEFAULT '',
     posting_text text NOT NULL DEFAULT '',
     kit_json     text,
     created_at   text NOT NULL,
     updated_at   text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS materials (
     id             text PRIMARY KEY,
     user_id        text NOT NULL,
     label          text NOT NULL DEFAULT 'Other',
     is_resume      integer NOT NULL DEFAULT 0,
     filename       text NOT NULL,
     mime_type      text NOT NULL,
     size_bytes     integer NOT NULL,
     stored_path    text NOT NULL,
     extract_status text NOT NULL DEFAULT 'ok',
     extract_note   text NOT NULL DEFAULT '',
     extracted_text text NOT NULL DEFAULT '',
     created_at     text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS materials_user_idx ON materials(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     token_hash text PRIMARY KEY,
     user_id    text NOT NULL,
     created_at text NOT NULL,
     expires_at text NOT NULL,
     used_at    text
   )`,
  `CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id)`,
  `CREATE TABLE IF NOT EXISTS rate_events (
     id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     scope      text NOT NULL,
     bucket     text NOT NULL,
     created_at text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rate_events_idx ON rate_events(scope, bucket, created_at)`,
  `CREATE TABLE IF NOT EXISTS qualifications (
     user_id      text PRIMARY KEY,
     facts_json   text NOT NULL DEFAULT '[]',
     report_json  text NOT NULL DEFAULT '{}',
     input_hash   text NOT NULL DEFAULT '',
     computed_at  text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS qualification_decisions (
     user_id            text PRIMARY KEY,
     decisions_json     text NOT NULL DEFAULT '[]',
     confirmations_json text NOT NULL DEFAULT '{}',
     updated_at         text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS funnel_events (
     id         text PRIMARY KEY,
     user_id    text NOT NULL,
     name       text NOT NULL,
     created_at text NOT NULL,
     UNIQUE (user_id, name)
   )`,
  `CREATE INDEX IF NOT EXISTS funnel_events_name_idx ON funnel_events(name, created_at)`,
  `CREATE TABLE IF NOT EXISTS application_choices (
     user_id        text NOT NULL,
     application_id text NOT NULL,
     chosen_at      text NOT NULL,
     PRIMARY KEY (user_id, application_id)
   )`,
];

// ----------------------------------------------------- postgres worker shim ---
//
// `Bun.sql` is asynchronous and every caller of this module is not: the exported
// functions are used synchronously all over the app (server functions, the check
// scripts, the backup scheduler) and their signatures are part of the contract.
// So Postgres is reached through one dedicated worker thread that owns the
// connection, and each statement is a blocking round trip over a
// `SharedArrayBuffer`: post the statement, `Atomics.wait` for the worker to
// signal it is done, then read the reply off the message port with
// `receiveMessageOnPort`. The main thread never runs the event loop while a
// statement is in flight, which is also why a transaction here is safe: nothing
// else in this process can interleave between BEGIN and COMMIT.
//
// The worker is part of this file as source text, so it survives bundling: there
// is no extra file to ship and no path to get wrong in the built server.
const PG_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
let channel = null;
let signal = null;
let db = null;
let tx = null;
let url = null;
let inTransaction = false;
function reply(message) {
  channel.postMessage(message);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
// bigint columns (a bare COUNT(*)) come back as BigInt; the app counts with
// numbers, so they are converted here rather than in 62 call sites.
function norm(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = norm(value[key]);
    return out;
  }
  return value;
}
async function exec(conn, text, params) {
  const result = params && params.length ? await conn.unsafe(text, params) : await conn.unsafe(text);
  const rows = Array.isArray(result) ? norm(result) : [];
  const count = result && typeof result.count === "number" ? result.count : rows.length;
  return { rows: rows, count: count };
}
function message(source) {
  return String(source && source.message ? source.message : source);
}
function newTx() {
  tx = new Bun.sql({ url: url, max: 1 });
}
parentPort.on("message", async (request) => {
  try {
    switch (request.op) {
      case "init": {
        channel = request.channel;
        signal = new Int32Array(request.signal);
        url = request.url;
        db = new Bun.sql(url);
        newTx();
        for (const statement of request.schema) await db.unsafe(statement);
        await db.unsafe("SELECT 1");
        reply({ id: request.id, ok: true });
        return;
      }
      case "query": {
        const result = await exec(inTransaction ? tx : db, request.text, request.params);
        reply({ id: request.id, ok: true, rows: result.rows, count: result.count });
        return;
      }
      case "begin": {
        await tx.unsafe("BEGIN");
        inTransaction = true;
        reply({ id: request.id, ok: true });
        return;
      }
      case "commit": {
        await tx.unsafe("COMMIT");
        inTransaction = false;
        reply({ id: request.id, ok: true });
        return;
      }
      case "rollback": {
        try { await tx.unsafe("ROLLBACK"); } catch (rolledBackEarly) { /* connection already gone */ }
        inTransaction = false;
        reply({ id: request.id, ok: true });
        return;
      }
      case "reset": {
        // A transaction connection that failed is discarded: the next BEGIN
        // opens a fresh one rather than reusing a poisoned session.
        try { await tx.unsafe("ROLLBACK"); } catch (nothingToRollBack) { /* not in a transaction */ }
        try { await tx.end(); } catch (alreadyClosed) { /* nothing to close */ }
        inTransaction = false;
        newTx();
        reply({ id: request.id, ok: true });
        return;
      }
      case "close": {
        try { await tx.end(); } catch (alreadyClosed) { /* nothing to close */ }
        try { await db.end(); } catch (alreadyClosed) { /* nothing to close */ }
        reply({ id: request.id, ok: true });
        return;
      }
      default:
        reply({ id: request.id, ok: false, error: "unknown worker op " + String(request.op) });
    }
  } catch (error) {
    // Reported, never thrown: an unhandled rejection here would kill the worker
    // and leave the main thread waiting on a signal that never comes.
    reply({ id: request.id, ok: false, error: message(error) });
  }
});
`;

/** How long the first connection (schema creation included) may take. */
const PG_CONNECT_TIMEOUT_MS = 30_000;
/** How long any single statement may take before the store is treated as lost. */
const PG_QUERY_TIMEOUT_MS = 60_000;

type WorkerReply = { id: number; ok: boolean; rows?: unknown[]; count?: number; error?: string };

/**
 * The main-thread half of the shim above: a synchronous `query(sql, params)`
 * over a worker that owns `Bun.sql`.
 *
 * Failure is always loud. If the database cannot be reached, `start()` throws
 * with what was tried and what came back; it never quietly opens a local file
 * instead, because a silent fallback would look like it was saving a real
 * person's data while actually writing to a store the next publish deletes.
 */
class PostgresStore {
  private worker: Worker | null = null;
  private channel: import("node:worker_threads").MessagePort | null = null;
  private signal: Int32Array | null = null;
  private nextId = 1;
  private txOpen = false;

  /** Opens the connection and applies the schema, once. Throws if it cannot. */
  open(): void {
    if (this.worker) return;
    const url = DATABASE_URL.url;
    if (!url) {
      throw new Error(
        "[applypilot] internal error: the Postgres store was opened without a DATABASE_URL."
      );
    }
    const worker = new Worker(PG_WORKER_SOURCE, { eval: true });
    // The store must never be the reason a process refuses to exit: a check
    // script that has finished its work should end, not hang on a live worker.
    worker.unref();
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.worker = worker;
    this.channel = port1;
    this.signal = signal;
    try {
      this.call(
        "init",
        { channel: port2, signal: signal.buffer, url, schema: POSTGRES_SCHEMA },
        PG_CONNECT_TIMEOUT_MS,
        [port2]
      );
    } catch (error) {
      this.abandon();
      throw new Error(
        `[applypilot] cannot use the managed database at ${redactDatabaseUrl(url)} — ` +
          `${errorText(error)}. The app will not fall back to a local file: that file would be ` +
          "deleted by the next publish while telling the user their data was saved. Check " +
          "DATABASE_URL (host, port, database, user, password) and that the database is reachable."
      );
    }
  }

  /** One statement, blocking until the worker has the answer. */
  query(sql: string, params: unknown[] = []): { rows: unknown[]; count: number } {
    const reply = this.call("query", {
      text: toPostgresPlaceholders(sql),
      params: params.length ? params : undefined,
    });
    return { rows: reply.rows ?? [], count: reply.count ?? 0 };
  }

  /**
   * Runs `fn` inside one database transaction. Commits on return, rolls back on
   * throw. Nested calls join the outer transaction, so a helper that starts one
   * cannot deadlock the store.
   */
  transaction<T>(fn: () => T): T {
    if (this.txOpen) return fn();
    this.call("begin");
    this.txOpen = true;
    try {
      const result = fn();
      this.call("commit");
      this.txOpen = false;
      return result;
    } catch (error) {
      try {
        this.call("rollback");
      } catch {
        // The transaction connection is already gone; the reset below makes the
        // next transaction open a fresh one.
      }
      this.txOpen = false;
      try {
        this.call("reset");
      } catch {
        // Nothing else to do: the original error is the one worth reporting.
      }
      throw error;
    }
  }

  /** Closes the connection. Used by tests and by a clean shutdown. */
  close(): void {
    if (!this.worker) return;
    try {
      this.call("close");
    } catch {
      // Closing a store that is already unreachable is not an error worth raising.
    }
    this.abandon();
  }

  private call(
    op: string,
    extra: Record<string, unknown> = {},
    timeoutMs = PG_QUERY_TIMEOUT_MS,
    transfer: readonly unknown[] = []
  ): WorkerReply {
    const worker = this.worker;
    const channel = this.channel;
    const signal = this.signal;
    if (!worker || !channel || !signal) {
      throw new Error("[applypilot] the Postgres store is not open");
    }
    const id = this.nextId++;
    Atomics.store(signal, 0, 0);
    worker.postMessage({ id, op, ...extra }, transfer as never[]);
    const wait = Atomics.wait(signal, 0, 0, timeoutMs);
    if (wait === "timed-out") {
      // A statement that never came back cannot be cancelled safely, and the
      // worker may still be holding a connection: drop the whole thing, so the
      // next caller opens a fresh one instead of reading someone else's reply.
      this.abandon();
      throw new Error(
        `[applypilot] the database did not answer within ${String(timeoutMs)}ms ` +
          `(statement type: ${op}). The store has been taken down; a later request will ` +
          "reconnect rather than reuse a connection that may still be busy."
      );
    }
    let reply: WorkerReply | undefined;
    let seen = receiveMessageOnPort(channel);
    while (seen && (seen.message as WorkerReply).id !== id) {
      // A late reply to an earlier, abandoned statement — skip it.
      seen = receiveMessageOnPort(channel);
    }
    reply = seen?.message as WorkerReply | undefined;
    if (!reply) throw new Error(`[applypilot] the database gave no answer to ${op}`);
    if (!reply.ok) throw new Error(reply.error ?? "the database rejected the statement");
    return reply;
  }

  private abandon(): void {
    const worker = this.worker;
    this.worker = null;
    this.channel = null;
    this.signal = null;
    this.txOpen = false;
    if (worker) {
      // terminate() rather than a polite close: whatever wedged the statement is
      // still running, and the next use starts from a clean worker.
      void worker.terminate().catch(() => undefined);
    }
  }
}

/**
 * `?` is how every statement in this file is written; Postgres wants `$1, $2…`.
 * Only bare `?` outside string literals are placeholders — the schema's
 * `DEFAULT '[]'` and any quoted text are left exactly as they are.
 */
function toPostgresPlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  for (const character of sql) {
    if (character === "'") {
      inString = !inString;
      out += character;
      continue;
    }
    if (character === "?" && !inString) {
      index += 1;
      out += "$" + String(index);
      continue;
    }
    out += character;
  }
  return out;
}

let store: PostgresStore | null = null;

/** The Postgres connection, opened on first use. Loud when it cannot be opened. */
function postgres(): PostgresStore {
  if (!store) {
    const next = new PostgresStore();
    next.open();
    store = next;
  }
  return store;
}

let handle: Database | null = null;

function sqliteDb(): Database {
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
  // The file backend needs its directory to exist and be writable — that is
  // where the database goes. The managed backend keeps only uploads there, so a
  // directory that cannot be made is a warning about uploads, not a reason to
  // refuse to start against a database that is perfectly reachable.
  if (LOCATION.backend === "sqlite") {
    assertDataDirUsable(LOCATION.dir);
  } else {
    try {
      ensureDataDir(LOCATION.uploads);
    } catch (error) {
      console.warn(`[applypilot] uploads unavailable: ${errorText(error)}`);
    }
  }
  const users = databaseInfo().users;
  return { location: LOCATION, users, tables: tableCounts() };
}

/**
 * One statement, on whichever store is in use. Every function below is written
 * once, in a dialect both engines accept: `?` placeholders (translated to `$1…`
 * for Postgres), `CAST(COUNT(*) AS integer)` rather than a bare count (Postgres
 * returns that as a bigint string otherwise), and `ON CONFLICT … DO NOTHING`,
 * which is the same syntax on both. Anything an engine cannot do at all lives
 * behind one of the helpers here, never in a caller.
 */
function all<T>(sql: string, params: unknown[] = []): T[] {
  if (isPostgres()) return postgres().query(sql, params).rows as T[];
  return sqliteDb()
    .query(sql)
    .all(...(params as never[])) as T[];
}
function one<T>(sql: string, params: unknown[] = []): T | null {
  if (isPostgres()) {
    const rows = postgres().query(sql, params).rows as T[];
    return rows[0] ?? null;
  }
  const row = sqliteDb()
    .query(sql)
    .get(...(params as never[]));
  return (row as T | undefined) ?? null;
}
/** Runs a write and reports how many rows it touched (Postgres `count`, SQLite `changes`). */
function run(sql: string, params: unknown[] = []): number {
  if (isPostgres()) return postgres().query(sql, params).count;
  return sqliteDb()
    .query(sql)
    .run(...(params as never[])).changes;
}

/**
 * One transaction, on either engine. Commits when `fn` returns, rolls back when
 * it throws. Nested calls join the outer transaction on both backends.
 */
function transaction<T>(fn: () => T): T {
  if (isPostgres()) return postgres().transaction(fn);
  return sqliteDb().transaction(fn)();
}

/** True when the managed backend was selected by `DATABASE_URL`. */
function isPostgres(): boolean {
  return LOCATION.backend === "postgres";
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
  // The taken-forward mark belongs to this application, so it goes with it. The
  // funnel step stays: it records that the user got there, which is still true.
  run("DELETE FROM application_choices WHERE user_id = ? AND application_id = ?", [userId, id]);
}

/** Test/diagnostic only: proves the file-backed database is reachable. */
export function databaseInfo(): { path: string; users: number } {
  const row = one<{ n: number }>("SELECT CAST(COUNT(*) AS integer) AS n FROM users");
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
  const row = one<{ n: number }>("SELECT CAST(COUNT(*) AS integer) AS n FROM materials WHERE user_id = ?", [userId]);
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
 * the same moment cannot both win: exactly one sees a row count of 1. Null means
 * the link is unknown, expired, or already used — the caller must not say which.
 */
export function claimReset(tokenHash: string): { user_id: string } | null {
  const row = findResetUser(tokenHash);
  if (!row) return null;
  const spent = run(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    [nowIso(), tokenHash]
  );
  if (spent !== 1) return null;
  return { user_id: row.user_id };
}

/** Called after a successful reset and before reissuing a token (one live link at a time). */
export function deleteResetsForUser(userId: string): number {
  const before = one<{ n: number }>(
    "SELECT CAST(COUNT(*) AS integer) AS n FROM password_resets WHERE user_id = ?",
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
  const before = one<{ n: number }>("SELECT CAST(COUNT(*) AS integer) AS n FROM sessions WHERE user_id = ?", [userId]);
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
    "SELECT CAST(COUNT(*) AS integer) AS n FROM rate_events WHERE scope = ? AND bucket = ? AND created_at >= ?",
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
// ------------------------------------------------------------ funnel events ---
//
// The five steps, in the order a person walks them. This list is the whole
// vocabulary: `recordFunnelEvent` accepts nothing outside it, so a stray call
// cannot invent a sixth step, and the check script proves the recorded set is
// exactly these five.
export const FUNNEL_STEPS = [
  "signup",
  "profile_complete",
  "posting_added",
  "kit_generated",
  "application_taken_forward",
] as const;

export type FunnelEventName = (typeof FUNNEL_STEPS)[number];

/** Who, what, when — the entire shape of a funnel row. No content, ever. */
export type FunnelEvent = {
  id: string;
  user_id: string;
  name: FunnelEventName;
  created_at: string;
};

export function isFunnelStep(value: unknown): value is FunnelEventName {
  return typeof value === "string" && (FUNNEL_STEPS as readonly string[]).includes(value);
}

/**
 * Oldest first, and — for two steps recorded in the same millisecond, which is
 * the normal case for a posting and its kit — in the order the funnel is walked.
 * Without that tie-break the order within a millisecond would be alphabetical,
 * which is not a thing the user did.
 */
function inWalkOrder(rows: FunnelEvent[]): FunnelEvent[] {
  return rows
    .slice()
    .sort((a, b) =>
      a.created_at === b.created_at
        ? FUNNEL_STEPS.indexOf(a.name) - FUNNEL_STEPS.indexOf(b.name)
        : a.created_at < b.created_at
          ? -1
          : 1
    );
}

/**
 * Records that this account has reached this step, and reports whether it was
 * new. Written once per account and step: the UNIQUE(user_id, name) index is the
 * real guard, and one `INSERT … ON CONFLICT (user_id, name) DO NOTHING` is what
 * turns a repeated action (saving the vault a second time, adding a second
 * posting) into no second row — in a single statement, so two requests racing
 * cannot both be told they were the first. The row count says which happened:
 * 1 = this call recorded the step, 0 = it was already recorded.
 *
 * The caller must be the real action, never a page render — see the check script,
 * which proves reading a page writes nothing.
 */
export function recordFunnelEvent(userId: string, name: FunnelEventName): boolean {
  const inserted = run(
    "INSERT INTO funnel_events (id, user_id, name, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (user_id, name) DO NOTHING",
    [newId(), userId, name, nowIso()]
  );
  return inserted === 1;
}

/** This account's own steps, oldest first — what the account holder did, no more. */
export function getFunnelEvents(userId: string): FunnelEvent[] {
  return inWalkOrder(
    all<FunnelEvent>(
      "SELECT id, user_id, name, created_at FROM funnel_events WHERE user_id = ? ORDER BY created_at ASC",
      [userId]
    )
  );
}

/** One step for one account, or null — used to answer "has this already happened?". */
export function getFunnelEvent(userId: string, name: FunnelEventName): FunnelEvent | null {
  return one<FunnelEvent>(
    "SELECT id, user_id, name, created_at FROM funnel_events WHERE user_id = ? AND name = ?",
    [userId, name]
  );
}

/**
 * Every step in the store, for reading the funnel back. Diagnostic/operator use
 * (the check script and any later funnel view) — it hands back ids and step names
 * only, because that is all the table holds.
 */
export function listAllFunnelEvents(limit = 1000): FunnelEvent[] {
  return inWalkOrder(
    all<FunnelEvent>(
      "SELECT id, user_id, name, created_at FROM funnel_events ORDER BY created_at ASC LIMIT ?",
      [limit]
    )
  );
}

/** How many accounts reached each step — the funnel itself. */
export function funnelSummary(): Array<{ name: FunnelEventName; accounts: number }> {
  const counts = new Map<string, number>();
  for (const row of all<{ name: string; n: number }>(
    "SELECT name, CAST(COUNT(DISTINCT user_id) AS integer) AS n FROM funnel_events GROUP BY name"
  )) {
    counts.set(row.name, row.n);
  }
  return FUNNEL_STEPS.map((name) => ({ name, accounts: counts.get(name) ?? 0 }));
}

/**
 * The columns the funnel table actually has, read from the engine rather than
 * from this file. The check script uses this to prove no content column has crept
 * in: `(id, user_id, name, created_at)` is the entire list.
 */
export function funnelEventColumns(): string[] {
  if (isPostgres()) {
    return all<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'funnel_events' ORDER BY ordinal_position"
    ).map((row) => String(row.name));
  }
  const rows = sqliteDb().query("PRAGMA table_info(funnel_events)").all() as Array<{ name: unknown }>;
  return rows.map((row) => String(row.name));
}

/** Total rows in the funnel table — tooling only. */
export function funnelEventCount(): number {
  return one<{ n: number }>("SELECT CAST(COUNT(*) AS integer) AS n FROM funnel_events")?.n ?? 0;
}

// ------------------------------------------- the application taken forward ---

export type ApplicationChoice = {
  user_id: string;
  application_id: string;
  chosen_at: string;
};

/**
 * Marks one of the account's own applications as the one being taken forward,
 * and reports whether that was a new choice. Idempotent: taking the same kit
 * forward twice changes nothing and records nothing new.
 */
export function saveApplicationChoice(userId: string, applicationId: string): boolean {
  // One statement, guarded by the primary key on (user_id, application_id): the
  // row count is 1 only when this call is the one that created the mark.
  const inserted = run(
    "INSERT INTO application_choices (user_id, application_id, chosen_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (user_id, application_id) DO NOTHING",
    [userId, applicationId, nowIso()]
  );
  return inserted === 1;
}

export function getApplicationChoice(userId: string, applicationId: string): ApplicationChoice | null {
  return one<ApplicationChoice>(
    "SELECT user_id, application_id, chosen_at FROM application_choices WHERE user_id = ? AND application_id = ?",
    [userId, applicationId]
  );
}

export function listApplicationChoices(userId: string): ApplicationChoice[] {
  return all<ApplicationChoice>(
    "SELECT user_id, application_id, chosen_at FROM application_choices WHERE user_id = ? ORDER BY chosen_at ASC",
    [userId]
  );
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
  /** Funnel steps recorded for this account — they are deleted with it. */
  funnelEvents: number;
  /** Applications this account had marked as taken forward. */
  applicationChoices: number;
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
    users: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM users WHERE id = ?"),
    profiles: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM profiles WHERE user_id = ?"),
    applications: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM applications WHERE user_id = ?"),
    materials: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM materials WHERE user_id = ?"),
    sessions: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM sessions WHERE user_id = ?"),
    resets: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM password_resets WHERE user_id = ?"),
    qualifications: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM qualifications WHERE user_id = ?"),
    qualificationDecisions: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM qualification_decisions WHERE user_id = ?"),
    funnelEvents: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM funnel_events WHERE user_id = ?"),
    applicationChoices: counts("SELECT CAST(COUNT(*) AS integer) AS n FROM application_choices WHERE user_id = ?"),
    rateEvents: 0,
    materialPaths: materials.map((m) => m.stored_path),
  };

  transaction(() => {
    run("DELETE FROM materials WHERE user_id = ?", [userId]);
    run("DELETE FROM applications WHERE user_id = ?", [userId]);
    run("DELETE FROM profiles WHERE user_id = ?", [userId]);
    run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    run("DELETE FROM password_resets WHERE user_id = ?", [userId]);
    run("DELETE FROM qualifications WHERE user_id = ?", [userId]);
    run("DELETE FROM qualification_decisions WHERE user_id = ?", [userId]);
    // The funnel steps and the taken-forward choice go with the account. Nothing
    // about a deleted person is kept for our own counting: the promise is
    // "we do not keep a copy after you delete your account", and it holds here too.
    run("DELETE FROM funnel_events WHERE user_id = ?", [userId]);
    run("DELETE FROM application_choices WHERE user_id = ?", [userId]);
    run("DELETE FROM users WHERE id = ?", [userId]);
  });

  return deleted;
}

/** Row counts per table for one user — used to prove a deletion left nothing behind. */
export function countRowsForUser(userId: string): Record<string, number> {
  const count = (sql: string, params: unknown[]): number =>
    one<{ n: number }>(sql, params)?.n ?? 0;
  return {
    users: count("SELECT CAST(COUNT(*) AS integer) AS n FROM users WHERE id = ?", [userId]),
    profiles: count("SELECT CAST(COUNT(*) AS integer) AS n FROM profiles WHERE user_id = ?", [userId]),
    applications: count("SELECT CAST(COUNT(*) AS integer) AS n FROM applications WHERE user_id = ?", [userId]),
    materials: count("SELECT CAST(COUNT(*) AS integer) AS n FROM materials WHERE user_id = ?", [userId]),
    sessions: count("SELECT CAST(COUNT(*) AS integer) AS n FROM sessions WHERE user_id = ?", [userId]),
    password_resets: count("SELECT CAST(COUNT(*) AS integer) AS n FROM password_resets WHERE user_id = ?", [userId]),
    qualifications: count("SELECT CAST(COUNT(*) AS integer) AS n FROM qualifications WHERE user_id = ?", [userId]),
    qualification_decisions: count(
      "SELECT CAST(COUNT(*) AS integer) AS n FROM qualification_decisions WHERE user_id = ?",
      [userId]
    ),
    funnel_events: count("SELECT CAST(COUNT(*) AS integer) AS n FROM funnel_events WHERE user_id = ?", [userId]),
    application_choices: count(
      "SELECT CAST(COUNT(*) AS integer) AS n FROM application_choices WHERE user_id = ?",
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
    /** When this account marked this kit as the one being taken forward, if it did. */
    takenForwardAt: string | null;
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
  /**
   * The funnel steps this account reached, and when. These are counts of a local
   * id and a step name — there is no user content in them — so they belong in the
   * export just as much as anything else the account built up, and leaving them
   * out would make the export's own promise ("everything ApplyPilot holds about
   * your account") untrue.
   */
  funnel: {
    events: Array<{ step: FunnelEventName; at: string }>;
  };
};

/**
 * Everything this account holds, as plain data. Scoped by `userId` on every
 * query — there is no path here that can reach another account's rows.
 */
export function exportAccount(userId: string): AccountExport | null {
  const user = one<User>("SELECT id, email, created_at FROM users WHERE id = ?", [userId]);
  if (!user) return null;
  const choices = new Map(
    listApplicationChoices(userId).map((choice) => [choice.application_id, choice.chosen_at])
  );
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
      takenForwardAt: choices.get(application.id) ?? null,
      createdAt: application.created_at,
      updatedAt: application.updated_at,
    })),
    qualifications: readQualificationsForExport(userId),
    funnel: {
      events: getFunnelEvents(userId).map((event) => ({ step: event.name, at: event.created_at })),
    },
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
    "funnel_events",
    "application_choices",
  ];
  const out: Record<string, number> = {};
  for (const name of names) {
    // `name` comes from this fixed list, never from input.
    out[name] = one<{ n: number }>(`SELECT CAST(COUNT(*) AS integer) AS n FROM ${name}`)?.n ?? 0;
  }
  return out;
}

/**
 * Flushes WAL pages into the main database file before it is copied. That is a
 * SQLite idea; there is no WAL file to flush on the managed backend, so this is
 * deliberately nothing there rather than an error.
 */
export function checkpoint(): void {
  if (isPostgres()) return;
  sqliteDb().exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/**
 * Writes a consistent, self-contained snapshot of the database to `path`
 * (SQLite's own VACUUM INTO — the destination must not already exist). Safer
 * than copying the file while the app is running: the snapshot is taken inside
 * a transaction, so a concurrent write cannot leave a torn backup.
 *
 * This is the file backend's backup. The managed backend has no single file to
 * snapshot: backing it up means pg_dump (or the provider's own snapshots), which
 * is a different artefact and is not built yet — so this refuses loudly instead
 * of writing an empty or partial file that a restore would later trust.
 */
export function vacuumInto(path: string): void {
  if (isPostgres()) {
    throw new Error(
      `[applypilot] backup to ${path} is not available on the managed database backend: ` +
        "there is no SQLite file to snapshot. Use the provider's backups or pg_dump. " +
        "(The daily file backup runs only when DATABASE_URL is unset.)"
    );
  }
  sqliteDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}

/**
 * Where the database itself lives (used by the backup/verify tooling): the
 * absolute path of the SQLite file, or — on the managed backend — the connection
 * target with every credential removed, because there is no file to name.
 */
export function databasePath(): string {
  return DB_PATH;
}
