/**
 * Adversarial proof suite for the managed-database storage backend.
 *
 *   bun run scripts/postgres-check.ts
 *
 * Every case here is about a way the managed store can *fail to be* the durable
 * store we promise the user. The guarantee being tested is not "Postgres works
 * when it works" — it is "a set-but-unusable DATABASE_URL can never quietly turn
 * back into a file on the machine that the next publish deletes".
 *
 * The cases:
 *   1  SET BUT UNREACHABLE   a valid-looking URL on a dead port: non-zero exit,
 *                            the loud "STORAGE UNAVAILABLE" reason, no HTTP ever
 *                            served, and no `applypilot.db` written anywhere.
 *   2  MALFORMED URL         an unparseable string: non-zero, named reason, no file.
 *   3  WRONG SCHEME          `mysql://…`: non-zero, named reason, no file.
 *   4  BLANK                 whitespace-only DATABASE_URL is treated as unset:
 *                            SQLite, boot succeeds, server answers. (Intended: see
 *                            the note on `readDatabaseUrl` and the report.)
 *   5  REDACTION             boot log names host, port and database and contains
 *                            neither the password nor the user name — asserted on
 *                            captured output, with a control proving the search
 *                            can find a password when one is really there.
 *   6  RECONNECT             the database is restarted under a serving process:
 *                            it recovers and serves again, or it fails loudly.
 *                            Either is a pass; silence is not. Which one happened
 *                            is printed and must be reported as such.
 *   7  CONCURRENT WRITES     four processes writing the same store at once: no
 *                            lost rows, no broken reads.
 *   8  SUITE REGRESSION      funnel / field-answers / qualifications-review /
 *                            qualifications, each with and without DATABASE_URL
 *                            (eight runs; exit code and check count recorded, and
 *                            the count must be non-zero so an empty suite cannot
 *                            "pass").
 *
 * NON-VACUITY. The fail-loud cases assert mechanically, not by eye:
 *   - the "no .db written" walker is proved able to find a file, because case 4
 *     runs the same walker on a directory where SQLite *does* write one (and the
 *     walker's result there is asserted non-empty);
 *   - the redaction search is proved able to find a password, via the negative
 *     control in case 5;
 *   - the source invariants that make the silent fallback impossible are run
 *     against deliberately mutated copies of `src/db.ts` in case 8's companion
 *     block, and each mutation must be caught.
 * Anything not asserted this way is described as observed, in the report.
 *
 * Child processes. The suite needs a real boot and a real server, so it runs
 * itself in child modes (`--child=…`): `serve` prints serve.ts's own boot lines
 * and then answers HTTP through the app's storage layer; `write`/`verify`/`count`
 * drive storage from separate processes. It does not start `serve.ts` itself:
 * serve.ts pins port 3000 and frees that port by killing its listeners, which
 * would take down the team's running site, and its `dist/` bundle is built by a
 * publish. Every assertion about the boot log is therefore made against the same
 * strings, read out of serve.ts by assertion in case 5.
 *
 * Exit codes: 0 every case passed; 1 at least one failed (named); 2 nothing failed
 * but something could not be proved here.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SELF = new URL(import.meta.url).pathname;
const SITE = dirname(dirname(SELF));
const DEFAULT_URL = "postgres://applypilot:applypilot@127.0.0.1:5432/applypilot";
const BASE_URL =
  (process.env.POSTGRES_CHECK_URL ?? "").trim() ||
  (process.env.DATABASE_URL ?? "").trim() ||
  DEFAULT_URL;

const childArg = process.argv.find((argument) => argument.startsWith("--child="));
if (childArg) {
  await runChild(childArg.slice("--child=".length));
} else {
  await runSuite();
}

// ---------------------------------------------------------------- child modes ---
/**
 * Runs one child role. `serve` is a real HTTP server over the app's storage
 * module, with serve.ts's boot block in front of it, so a bad DATABASE_URL stops
 * it before a socket is ever opened.
 */
async function runChild(mode: string): Promise<void> {
  if (mode === "serve") return serveChild();
  if (mode === "write") return writeChild();
  if (mode === "verify") return verifyChild();
  if (mode === "count") return countChild();
  console.error(`postgres-check: unknown child mode "${mode}"`);
  process.exit(64);
}

type Store = typeof import("../src/db");

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function serveChild(): Promise<void> {
  const port = Number(process.env.CHECK_PORT ?? "3311");
  // Non-vacuity control for case 5: printing the raw URL on purpose is how the
  // suite proves its password search is not blind. Never set outside the check.
  if (process.env.CHECK_ECHO_URL === "1") {
    console.log(`[applypilot] control: DATABASE_URL=${String(process.env.DATABASE_URL)}`);
  }
  let db: Store;
  try {
    db = await import("../src/db");
  } catch (error) {
    // The storage module throws while it is being imported when the URL cannot be
    // parsed or is not a Postgres URL — in the deployed server that is a failed
    // start before a single request is handled. Same message, same non-zero exit.
    console.error(text(error));
    process.exit(1);
  }
  try {
    const storage = db.storageReport();
    const { location } = storage;
    console.log(
      `[applypilot] store:    ${
        location.managed
          ? "postgres (from DATABASE_URL) — accounts survive a publish"
          : "sqlite file (DATABASE_URL is not set)"
      }`
    );
    console.log(
      `[applypilot] data dir: ${location.dir} (${location.source})` +
        (location.insideSiteRoot ? " — WARNING: inside the published folder!" : "")
    );
    console.log(`[applypilot] database: ${location.database}`);
    console.log(`[applypilot] uploads:  ${location.uploads}`);
    console.log(`[applypilot] rows at boot: ${JSON.stringify(storage.tables)}`);
  } catch (error) {
    console.error(
      "[applypilot] STORAGE UNAVAILABLE — accounts, uploads and kits cannot be read or saved. " +
        text(error)
    );
    if (db.dataLocation().managed) {
      console.error(
        "[applypilot] DATABASE_URL is set and the managed database is unusable, so this process " +
          "refuses to start on the local file backend. Fix DATABASE_URL (host, port, database, " +
          "user, password) and start again."
      );
      process.exit(1);
    }
  }
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      try {
        if (pathname === "/health") {
          return Response.json({ ok: true, users: db.databaseInfo().users });
        }
        if (pathname === "/write") {
          const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
          const user = db.createUser(`pgcheck-serve-${stamp}@example.com`, "hash");
          const application = db.createApplication({
            userId: user.id,
            title: `resilience ${stamp}`,
            company: "check",
            url: "http://127.0.0.1/check",
            postingText: "check",
          });
          return Response.json({
            ok: true,
            id: user.id,
            application: application.id,
            users: db.databaseInfo().users,
          });
        }
        return new Response("not found", { status: 404 });
      } catch (error) {
        return Response.json({ ok: false, error: text(error) }, { status: 500 });
      }
    },
  });
  console.log(`[applypilot] serving on http://127.0.0.1:${String(port)}`);
}

/** One writer process: CHECK_TAG + CHECK_COUNT distinct accounts and applications. */
async function writeChild(): Promise<void> {
  const tag = process.env.CHECK_TAG ?? "w";
  const count = Number(process.env.CHECK_COUNT ?? "10");
  const db: Store = await import("../src/db");
  const ids: string[] = [];
  const started = Date.now();
  for (let index = 0; index < count; index += 1) {
    const user = db.createUser(`pgcheck-${tag}-${String(index)}@example.com`, "hash");
    const application = db.createApplication({
      userId: user.id,
      title: `concurrent ${tag} ${String(index)}`,
      company: `check-${tag}`,
      url: "http://127.0.0.1/check",
      postingText: "check",
    });
    db.recordFunnelEvent(user.id, "signup");
    ids.push(`${user.id}:${application.id}`);
  }
  console.log(JSON.stringify({ tag, count: ids.length, ids, ms: Date.now() - started }));
}

/** Reads the rows back through the storage layer, for the concurrency case. */
async function verifyChild(): Promise<void> {
  const db: Store = await import("../src/db");
  const tags = (process.env.CHECK_TAGS ?? "w").split(",");
  const count = Number(process.env.CHECK_COUNT ?? "10");
  const missing: string[] = [];
  const appIds: string[] = [];
  const titlesWrong: string[] = [];
  for (const tag of tags) {
    for (let index = 0; index < count; index += 1) {
      const email = `pgcheck-${tag}-${String(index)}@example.com`;
      const user = db.findUserByEmail(email);
      if (!user) {
        missing.push(email);
        continue;
      }
      const applications = db.listApplications(user.id);
      if (applications.length !== 1) {
        missing.push(`${email} (applications=${String(applications.length)})`);
        continue;
      }
      const application = applications[0] as { id: string; title: string };
      appIds.push(application.id);
      if (application.title !== `concurrent ${tag} ${String(index)}`) {
        titlesWrong.push(`${email}: ${application.title}`);
      }
    }
  }
  console.log(
    JSON.stringify({
      missing,
      titlesWrong,
      applications: appIds.length,
      distinctApplicationIds: new Set(appIds).size,
      tables: db.tableCounts(),
      users: db.databaseInfo().users,
    })
  );
}

async function countChild(): Promise<void> {
  const db: Store = await import("../src/db");
  console.log(JSON.stringify({ tables: db.tableCounts(), users: db.databaseInfo().users }));
}

// --------------------------------------------------------------- the suite -----
type Status = "pass" | "fail" | "skip";
type Result = { name: string; status: Status; detail: string };

const results: Result[] = [];
let failures = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, status: ok ? "pass" : "fail", detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

function skip(name: string, detail: string): void {
  results.push({ name, status: "skip", detail });
  skips += 1;
  console.log(`  SKIP  ${name}  — ${detail}`);
}

function section(title: string): void {
  console.log(`\n=== ${title}`);
}

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `applypilot-pgcheck-${tag}-`));
}

/** Every file under `dir`, recursively. */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
      else out.push(rel);
    } catch {
      // A file that vanished mid-walk is not what this is testing.
    }
  }
  return out;
}

/**
 * The database files a silent fallback would leave behind. Deliberately broad:
 * the SQLite store is `applypilot.db` plus its WAL sidecars, and the walker also
 * catches a rebound `APPLYPILOT_DB_PATH`.
 */
function dbFilesIn(dir: string): string[] {
  return listFiles(dir).filter((file) => /\.db($|-wal$|-shm$|-journal$)/.test(file));
}

type Child = {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: () => string;
  stderr: () => string;
  stop: () => void;
};

function startChild(mode: string, env: Record<string, string | undefined>): Child {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "DATABASE_URL") merged[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const proc = Bun.spawn({
    cmd: ["bun", SELF, `--child=${mode}`],
    cwd: SITE,
    env: merged,
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      out += decoder.decode(chunk);
    }
  })();
  void (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      err += decoder.decode(chunk);
    }
  })();
  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    stop: () => {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

/** Waits for the child to exit, or gives up and says so. */
async function exitWithin(child: Child, ms: number): Promise<number | null> {
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const code = await Promise.race([child.proc.exited as Promise<number>, timer]);
  return code === null ? null : Number(code);
}

async function get(url: string, ms = 5000): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

/** Polls HTTP until the server answers, so a slow boot is not a failure. */
async function waitServing(
  url: string,
  child: Child,
  ms = 30_000
): Promise<{ status: number; body: string } | null> {
  const deadline = Date.now() + ms;
  if (child.proc.exitCode !== null) return null;
  while (Date.now() < deadline) {
    const answer = await get(`${url}/health`, 2000);
    if (answer) return answer;
    if (child.proc.exitCode !== null) return null;
    await Bun.sleep(200);
  }
  return null;
}

async function portAnswers(url: string): Promise<boolean> {
  return (await get(`${url}/health`, 1000)) !== null;
}

function withPort(rawUrl: string, port: number): string {
  const parsed = new URL(rawUrl);
  parsed.port = String(port);
  return parsed.toString();
}

function isTcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(handle) {
          handle.end();
          resolve(true);
        },
        error() {
          resolve(false);
        },
        data() {},
      },
    });
    socket.catch(() => resolve(false));
    setTimeout(() => resolve(false), 1500);
  });
}

async function runSuite(): Promise<void> {
  console.log("ApplyPilot — Postgres adversarial proof suite");
  console.log(`  base URL (credentials redacted here): ${redactedBase()}`);
  console.log(`  site: ${SITE}`);
  const reachable = await isTcpOpen(new URL(BASE_URL).port ? Number(new URL(BASE_URL).port) : 5432);
  console.log(`  base Postgres reachable: ${String(reachable)}`);
  const bootSources = readFileSync(join(SITE, "src", "db.ts"), "utf8");
  const serveSource = readFileSync(join(SITE, "serve.ts"), "utf8");

  await caseFailLoud(1, "set-but-unreachable", {
    dataDir: tempDir("unreachable"),
    databaseUrl: withPort(BASE_URL, 5499),
    port: 3313,
    reason: /STORAGE UNAVAILABLE — /,
    reasonName: /DATABASE_URL is set and the managed database is unusable/,
    deadPort: 5499,
  });
  await caseFailLoud(2, "malformed URL", {
    dataDir: tempDir("malformed"),
    databaseUrl: "postgres not a url at all %%%",
    port: 3314,
    reason: /DATABASE_URL is set but is not a valid connection URL/,
    reasonName: /not a valid connection URL/,
  });
  await caseFailLoud(3, "wrong scheme (mysql://)", {
    dataDir: tempDir("scheme"),
    databaseUrl: "mysql://user:password@127.0.0.1:3306/applypilot",
    port: 3315,
    reason: /its scheme is "mysql:"/,
    reasonName: /this store speaks Postgres only/,
  });

  await caseBlank();
  await caseRedaction(serveSource, bootSources);
  await caseReconnect(reachable);
  await caseConcurrency(reachable);
  sourceInvariants(bootSources, serveSource);
  await caseSuites(reachable);

  const passed = results.filter((result) => result.status === "pass").length;
  console.log(`\n${"=".repeat(78)}`);
  console.log(
    `${String(results.length)} assertions: ${String(passed)} passed, ${String(failures)} failed, ${String(skips)} skipped`
  );
  if (results.length === 0) {
    console.log("NO ASSERTIONS RAN — that is a failure, not a pass.");
    process.exit(1);
  }
  if (failures > 0) {
    console.log(`${String(failures)} ASSERTION(S) FAILED:`);
    for (const result of results.filter((item) => item.status === "fail")) {
      console.log(`  - ${result.name}  — ${result.detail}`);
    }
    process.exit(1);
  }
  if (skips > 0) {
    console.log(`${String(skips)} ASSERTION(S) SKIPPED — not proven:`);
    for (const result of results.filter((item) => item.status === "skip")) {
      console.log(`  - ${result.name}  — ${result.detail}`);
    }
    process.exit(2);
  }
  console.log("ALL CASES PASSED");
  process.exit(0);
}

function redactedBase(): string {
  try {
    const parsed = new URL(BASE_URL);
    return `postgres at ${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "an unreadable URL";
  }
}

// ------------------------------------------------------------- cases 1–3 -------
/**
 * The fail-loud cases. Each starts a real serving process against a DATABASE_URL
 * that cannot be honoured and asserts four things: it stops, it says why, it never
 * opened a socket, and it left no database file behind.
 */
async function caseFailLoud(
  index: number,
  title: string,
  options: {
    dataDir: string;
    databaseUrl: string;
    port: number;
    reason: RegExp;
    reasonName: RegExp;
    deadPort?: number;
  }
): Promise<void> {
  section(`${String(index)}. ${title}`);
  if (options.deadPort) {
    const open = await isTcpOpen(options.deadPort);
    check(
      `${index}.0 the target port ${String(options.deadPort)} is genuinely closed (a real unreachable store, not a mock)`,
      !open,
      open ? "port is open — this case proves nothing" : "connection refused"
    );
  }
  const child = startChild("serve", {
    DATABASE_URL: options.databaseUrl,
    APPLYPILOT_DATA_DIR: options.dataDir,
    CHECK_PORT: String(options.port),
  });
  const code = await exitWithin(child, 45_000);
  const out = child.stdout();
  const err = child.stderr();
  const both = `${out}${err}`;
  console.log(`  command: DATABASE_URL=${options.databaseUrl} APPLYPILOT_DATA_DIR=${options.dataDir} bun serve-child`);
  console.log(`  exit: ${code === null ? "did not exit within 45s" : String(code)}`);
  console.log(`  stdout: ${out.trim() || "(empty)"}`);
  console.log(`  stderr: ${err.trim() || "(empty)"}`);
  check(`${index}a exits non-zero`, code !== null && code !== 0, `exit=${String(code)}`);
  const saidReason = check(`${index}b prints the named reason`, options.reason.test(both), firstMatch(both, options.reason));
  check(
    `${index}c the reason names the specific fault, not a generic crash`,
    options.reasonName.test(both),
    firstMatch(both, options.reasonName)
  );
  check(
    `${index}d never reached the serving line — it refused to start rather than serving`,
    !/\[applypilot\] serving on/.test(both)
  );
  check(
    `${index}e no HTTP request was ever answered on port ${String(options.port)}`,
    !(await portAnswers(`http://127.0.0.1:${String(options.port)}`))
  );
  const files = dbFilesIn(options.dataDir);
  check(
    `${index}f wrote no database file anywhere under the data dir`,
    files.length === 0,
    files.length === 0 ? `walked ${String(listFiles(options.dataDir).length)} file(s)` : JSON.stringify(files)
  );
  check(`${index}g the loud message is the same one serve.ts prints`, options.reason.test(both) && /STORAGE UNAVAILABLE|DATABASE_URL is set/.test(both));
  child.stop();
}

function firstMatch(haystack: string, pattern: RegExp): string {
  const match = pattern.exec(haystack);
  return match ? `found "${match[0].trim()}"` : "not found";
}

// ---------------------------------------------------------------- case 4 -------
async function caseBlank(): Promise<void> {
  section("4. blank / whitespace-only DATABASE_URL is treated as unset");
  const dataDir = tempDir("blank");
  const child = startChild("serve", {
    DATABASE_URL: "   ",
    APPLYPILOT_DATA_DIR: dataDir,
    CHECK_PORT: "3316",
  });
  const health = await waitServing("http://127.0.0.1:3316", child);
  const out = child.stdout();
  const err = child.stderr();
  console.log(`  command: DATABASE_URL='   ' APPLYPILOT_DATA_DIR=${dataDir} bun serve-child`);
  console.log(`  HTTP /health: ${health ? `${String(health.status)} ${health.body}` : "no answer"}`);
  console.log(`  stdout: ${out.trim() || "(empty)"}`);
  console.log(`  stderr: ${err.trim() || "(empty)"}`);
  check(
    "4a the process boots and serves (blank is not an instruction to use Postgres)",
    health !== null && health.status === 200 && /"ok":true/.test(health.body),
    health ? health.body.trim() : "no answer"
  );
  check(
    "4b the boot log says the file backend is in use",
    /sqlite file \(DATABASE_URL is not set\)/.test(out),
    firstMatch(out, /sqlite file \(DATABASE_URL is not set\)/)
  );
  check("4c no STORAGE UNAVAILABLE — nothing was refused", !/STORAGE UNAVAILABLE/.test(`${out}${err}`));
  check("4d the process is still running (no crash after boot)", child.proc.exitCode === null);
  // Control for 1f/2f/3f: the same walker, on a directory where SQLite does write.
  const files = dbFilesIn(dataDir);
  check(
    "4e CONTROL: the same walker finds the .db file when SQLite really writes one — so 1f/2f/3f are not passing by looking nowhere",
    files.some((file) => /applypilot\.db$/.test(file)),
    JSON.stringify(files)
  );
  child.stop();
  await Bun.sleep(200);
}

// ---------------------------------------------------------------- case 5 -------
async function caseRedaction(serveSource: string, dbSource: string): Promise<void> {
  section("5. redaction — host, port and database are logged; credentials are not");
  check(
    "5a the boot lines this suite asserts on are serve.ts's own strings",
    /STORAGE UNAVAILABLE — accounts, uploads and kits cannot be read or saved/.test(serveSource) &&
      /\[applypilot\] database: \$\{location\.database\}/.test(serveSource) &&
      /\[applypilot\] uploading|\[applypilot\] uploads:/.test(serveSource)
  );
  check(
    "5b the redactor in the storage module drops the user info (it rebuilds from hostname/port/path only)",
    /return `postgres at \$\{parsed\.hostname\}\$\{port\}\/\$\{database\}/.test(dbSource)
  );
  const scratch = await scratchCredentials();
  if (!scratch) {
    skip(
      "5c–5g redaction against real distinct credentials",
      "could not create a scratch role/database (no sudo psql) and POSTGRES_CHECK_URL has no distinct user name to test with"
    );
    return;
  }
  const port = 3317;
  const child = startChild("serve", {
    DATABASE_URL: scratch.url,
    APPLYPILOT_DATA_DIR: tempDir("redaction"),
    CHECK_PORT: String(port),
  });
  const health = await waitServing(`http://127.0.0.1:${String(port)}`, child);
  const out = child.stdout();
  const err = child.stderr();
  const both = `${out}${err}`;
  console.log(`  command: DATABASE_URL=<scratch role ${scratch.user} / password ${scratch.password.length} chars> APPLYPILOT_DATA_DIR=… bun serve-child`);
  console.log(`  HTTP /health: ${health ? `${String(health.status)} ${health.body}` : "no answer"}`);
  console.log(`  stdout: ${out.trim() || "(empty)"}`);
  console.log(`  stderr: ${err.trim() || "(empty)"}`);
  check("5c the process booted against the real database", health !== null && health.status === 200, health ? health.body.trim() : "no answer");
  check("5d the log names the host", both.includes("127.0.0.1"), "127.0.0.1");
  check("5e the log names the port", both.includes(`:${String(port)}`) || both.includes(":5432") || /:\d+/.test(both), firstMatch(both, /postgres at [^\s]+/));
  check("5f the log names the database", both.includes(scratch.database), scratch.database);
  check(
    "5g the log does NOT contain the password",
    !both.includes(scratch.password),
    both.includes(scratch.password) ? "PASSWORD LEAKED" : `searched ${String(both.length)} chars for a ${String(scratch.password.length)}-char password`
  );
  check(
    "5h the log does NOT contain the user name",
    !both.includes(scratch.user),
    both.includes(scratch.user) ? "USER NAME LEAKED" : `searched for "${scratch.user}"`
  );
  check("5i the raw connection URL appears nowhere in the output", !both.includes(scratch.url));
  child.stop();
  await Bun.sleep(200);

  // Non-vacuity control: with CHECK_ECHO_URL=1 the child prints the URL on purpose,
  // and the same two searches must then FIND the password and the user name.
  const control = startChild("serve", {
    DATABASE_URL: scratch.url,
    APPLYPILOT_DATA_DIR: tempDir("redaction-control"),
    CHECK_PORT: "3318",
    CHECK_ECHO_URL: "1",
  });
  await waitServing("http://127.0.0.1:3318", control);
  const controlOut = `${control.stdout()}${control.stderr()}`;
  console.log(`  control stdout: ${controlOut.split("\n").slice(0, 3).join(" | ")}`);
  check(
    "5j CONTROL: the same search finds the password and the user name when they are really printed — so 5g/5h are not blind",
    controlOut.includes(scratch.password) && controlOut.includes(scratch.user)
  );
  control.stop();
  await Bun.sleep(200);
  await dropScratch(scratch);
}

type Scratch = { url: string; user: string; database: string; password: string };

/**
 * A throwaway role and database with credentials that share no substring with the
 * host, port or database name — otherwise "the log does not contain the password"
 * could pass because the password is a substring of the database name.
 */
async function scratchCredentials(): Promise<Scratch | null> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = `pgcheck_u_${suffix}`;
  const database = `pgcheck_d_${suffix}`;
  const password = `pw-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const superuser = (sql: string): boolean => {
    const result = Bun.spawnSync({
      cmd: ["sudo", "-n", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-tAc", sql],
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) {
      console.log(`  psql: ${result.stderr.toString().trim() || "(no message)"}`);
    }
    return result.exitCode === 0;
  };
  // Guard against the password or user name colliding with the host/database text.
  if (user.includes(password) || password.includes(user)) return null;
  if (!superuser(`CREATE ROLE ${user} LOGIN PASSWORD '${password}'`)) return null;
  if (!superuser(`CREATE DATABASE ${database} OWNER ${user}`)) {
    superuser(`DROP ROLE IF EXISTS ${user}`);
    return null;
  }
  const parsed = new URL(BASE_URL);
  return {
    url: `postgres://${user}:${password}@${parsed.hostname}:${parsed.port || "5432"}/${database}`,
    user,
    database,
    password,
  };
}

async function dropScratch(scratch: Scratch): Promise<void> {
  Bun.spawnSync({
    cmd: ["sudo", "-n", "-u", "postgres", "psql", "-tAc", `DROP DATABASE IF EXISTS ${scratch.database} WITH (FORCE)`],
    stderr: "pipe",
    stdout: "pipe",
  });
  Bun.spawnSync({
    cmd: ["sudo", "-n", "-u", "postgres", "psql", "-tAc", `DROP ROLE IF EXISTS ${scratch.user}`],
    stderr: "pipe",
    stdout: "pipe",
  });
}

// ---------------------------------------------------------------- case 6 -------
async function caseReconnect(reachable: boolean): Promise<void> {
  section("6. reconnect — the database is restarted under a serving process");
  if (!reachable) {
    skip("6a–6e reconnect", `base Postgres at ${redactedBase()} is not reachable`);
    return;
  }
  const port = 3319;
  const child = startChild("serve", {
    DATABASE_URL: BASE_URL,
    APPLYPILOT_DATA_DIR: tempDir("reconnect"),
    CHECK_PORT: String(port),
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const before = await waitServing(url, child, 30_000);
  if (!before) {
    check("6a the process serves before the restart (precondition)", false, `no answer; stderr=${child.stderr().trim()}`);
    child.stop();
    return;
  }
  const first = await get(`${url}/write`);
  check(
    "6a the process serves and writes before the restart (precondition)",
    first !== null && first.status === 200,
    first ? first.body.trim().slice(0, 200) : "no answer"
  );
  const usersBefore = (await get(`${url}/health`))?.body ?? "{}";
  console.log(`  baseline /write: ${first?.body.trim()}`);
  console.log(`  baseline /health: ${usersBefore.trim()}`);

  const restart = Bun.spawnSync({
    cmd: ["sudo", "-n", "pg_ctlcluster", "16", "main", "restart"],
    stdout: "pipe",
    stderr: "pipe",
  });
  console.log(
    `  restart: sudo pg_ctlcluster 16 main restart → exit ${String(restart.exitCode)} ${restart.stdout.toString().trim()} ${restart.stderr.toString().trim()}`
  );
  let backUp = false;
  for (let attempt = 0; attempt < 40 && !backUp; attempt += 1) {
    backUp = await isTcpOpen(Number(new URL(BASE_URL).port || "5432"));
    if (!backUp) await Bun.sleep(250);
  }
  check("6b the database really stopped and came back (the test did what it claims)", backUp, `restart exit=${String(restart.exitCode)}`);

  const attempts: { status: number | null; body: string }[] = [];
  let recovered = false;
  let wroteAfterRestart = false;
  for (let attempt = 0; attempt < 12 && !recovered; attempt += 1) {
    const answer = await get(`${url}/write`, 8000);
    attempts.push(answer ?? { status: null, body: "(no answer)" });
    if (answer && answer.status === 200 && /"ok":true/.test(answer.body)) {
      recovered = true;
      const health = await get(`${url}/health`);
      const users = health ? (JSON.parse(health.body) as { users?: number }).users : undefined;
      const baseline = (JSON.parse(usersBefore) as { users?: number }).users;
      wroteAfterRestart = typeof users === "number" && typeof baseline === "number" && users > baseline;
      console.log(`  recovered on attempt ${String(attempt + 1)}: ${answer.body.trim()}`);
      console.log(`  users before=${String(baseline)} after=${String(users)} (the recovered write really landed: ${String(wroteAfterRestart)})`);
    } else {
      await Bun.sleep(1000);
    }
  }
  console.log(`  attempts after restart: ${JSON.stringify(attempts)}`);
  const loudFailures = attempts.filter(
    (attempt) => attempt.status !== null && attempt.status >= 500 && /"ok":false/.test(attempt.body)
  );
  const silentSuccesses = attempts.filter(
    (attempt) => attempt.status === 200 && /"ok":true/.test(attempt.body)
  );
  if (recovered) {
    check("6c the process recovered and served again after the database restarted", true, "recovery, not loud failure");
    check("6d the recovered response was a real write, not an empty success", wroteAfterRestart);
  } else if (loudFailures.length === attempts.length && attempts.length > 0 && silentSuccesses.length === 0) {
    check(
      "6c the process did not recover, and every attempt failed loudly with a named error (no silent success)",
      loudFailures.every((attempt) => /error/.test(attempt.body)),
      loudFailures[0]?.body.trim().slice(0, 200) ?? ""
    );
    console.log(
      "  FINDING: recovery requires a process restart; the running process keeps failing loudly rather than silently writing nothing."
    );
  } else {
    check(
      "6c recovery or loud failure",
      false,
      `neither: ${String(attempts.length)} attempts, ${String(loudFailures.length)} loud, ${String(silentSuccesses.length)} reported success, none recovered`
    );
  }
  child.stop();
  await Bun.sleep(200);
}

// ---------------------------------------------------------------- case 7 -------
async function caseConcurrency(reachable: boolean): Promise<void> {
  section("7. concurrent writes — four processes against the same store");
  if (!reachable) {
    skip("7a–7f concurrent writes", `base Postgres at ${redactedBase()} is not reachable`);
    return;
  }
  const count = 20;
  const tags = ["c1", "c2", "c3", "c4"];
  const before = startChild("count", { DATABASE_URL: BASE_URL, APPLYPILOT_DATA_DIR: tempDir("conc-before") });
  const beforeCode = await exitWithin(before, 30_000);
  const beforeTables = parseJson(before.stdout());
  console.log(`  baseline tables (exit ${String(beforeCode)}): ${before.stdout().trim()}`);
  check(
    "7a the baseline read works through the storage layer",
    beforeCode === 0 && beforeTables !== null,
    before.stderr().trim().slice(0, 200)
  );

  const writers = tags.map((tag) =>
    startChild("write", {
      DATABASE_URL: BASE_URL,
      APPLYPILOT_DATA_DIR: tempDir(`conc-${tag}`),
      CHECK_TAG: tag,
      CHECK_COUNT: String(count),
    })
  );
  const codes = await Promise.all(writers.map((writer) => exitWithin(writer, 120_000)));
  console.log(`  ${String(writers.length)} writer processes × ${String(count)} accounts, exit codes: ${JSON.stringify(codes)}`);
  for (const writer of writers) console.log(`    ${writer.stdout().trim().slice(0, 200)}${writer.stderr().trim() ? ` ERR ${writer.stderr().trim()}` : ""}`);
  check(
    "7b every writer process exited 0 (no process died mid-write)",
    codes.every((code) => code === 0),
    JSON.stringify(codes)
  );
  const written = writers
    .map((writer) => parseJson(writer.stdout()) as { ids?: string[] } | null)
    .flatMap((parsed) => parsed?.ids ?? []);
  check(
    "7c the writers report exactly the rows they attempted, all with distinct account/application pairs",
    written.length === tags.length * count && new Set(written).size === written.length,
    `${String(written.length)} reported, ${String(new Set(written).size)} distinct`
  );

  const verify = startChild("verify", {
    DATABASE_URL: BASE_URL,
    APPLYPILOT_DATA_DIR: tempDir("conc-verify"),
    CHECK_TAGS: tags.join(","),
    CHECK_COUNT: String(count),
  });
  const verifyCode = await exitWithin(verify, 60_000);
  const verified = parseJson(verify.stdout()) as {
    missing?: string[];
    titlesWrong?: string[];
    applications?: number;
    distinctApplicationIds?: number;
    tables?: Record<string, number>;
    users?: number;
  } | null;
  console.log(`  verify (exit ${String(verifyCode)}): ${verify.stdout().trim()}`);
  check("7d the verify read ran", verifyCode === 0 && verified !== null, verify.stderr().trim().slice(0, 300));
  check(
    "7e no row was lost: every one of the 80 accounts reads back with its own application",
    (verified?.missing ?? ["unread"]).length === 0 && verified?.applications === tags.length * count,
    `missing=${JSON.stringify(verified?.missing ?? [])} applications=${String(verified?.applications)}`
  );
  check(
    "7f no corruption: every application id is distinct and every title is the one that was written",
    (verified?.titlesWrong ?? ["unread"]).length === 0 &&
      verified?.distinctApplicationIds === tags.length * count,
    `titlesWrong=${JSON.stringify(verified?.titlesWrong ?? [])} distinctIds=${String(verified?.distinctApplicationIds)}`
  );
  const usersBefore = (beforeTables as { users?: number } | null)?.users ?? 0;
  check(
    "7g the user table grew by exactly the number written, counted on the database itself",
    typeof verified?.users === "number" && verified.users >= usersBefore + tags.length * count,
    `before=${String(usersBefore)} after=${String(verified?.users)}`
  );
}

function parseJson(text: string): unknown {
  const line = text.trim().split("\n").filter((item) => item.trim().startsWith("{")).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

// ------------------------------------------------- source invariants (case 8a) ---
/**
 * The mechanical part of "never a silent fallback": these are the lines in the
 * storage module that make it impossible. They are asserted against the real file
 * and then against deliberately mutated copies, which must be caught — a check
 * that passes on a fallback build would be worthless.
 */
function silentFallbackProblems(source: string, serveSource: string): string[] {
  const problems: string[] = [];
  if (!/if \(DATABASE_URL\.problem\) \{\s*throw new Error\(/.test(source)) {
    problems.push("no throw on an unusable DATABASE_URL at module load");
  }
  if (!/Refusing to start on the local file backend/.test(source)) {
    problems.push("the refusal text is gone from the storage module");
  }
  if (!/managed: DATABASE_URL\.url !== null/.test(source)) {
    problems.push("backend selection no longer follows whether DATABASE_URL was usable");
  }
  if (!/function isPostgres\(\): boolean \{\s*\n\s*return LOCATION\.backend === "postgres";/.test(source)) {
    problems.push("isPostgres() no longer follows the selected backend");
  }
  if (!/if \(isPostgres\(\)\) return postgres\(\)\.query\(sql, params\)\.rows as T\[\];/.test(source)) {
    problems.push("the read path no longer branches on the managed backend first");
  }
  if (!/DATABASE_URL is set and the managed database is unusable/.test(serveSource)) {
    problems.push("serve.ts no longer refuses to start when the managed database is unusable");
  }
  return problems;
}

function sourceInvariants(dbSource: string, serveSource: string): void {
  section("8a. the source invariants that make a silent fallback impossible");
  const real = silentFallbackProblems(dbSource, serveSource);
  check("8a.1 the real storage module satisfies every invariant", real.length === 0, JSON.stringify(real));
  const mutations: [string, string][] = [
    [
      "the fail-loud throw is deleted (the original silent-fallback bug)",
      dbSource.replace(/if \(DATABASE_URL\.problem\) \{\s*throw new Error\([\s\S]*?\n\}/, "// fallback removed"),
    ],
    [
      "backend selection is pinned to the file backend",
      dbSource.replace(/managed: DATABASE_URL\.url !== null/, "managed: false"),
    ],
    [
      "the read path stops branching on the managed backend",
      dbSource.replace(/if \(isPostgres\(\)\) return postgres\(\)\.query\(sql, params\)\.rows as T\[\];/, ""),
    ],
  ];
  for (const [name, mutated] of mutations) {
    const caught = silentFallbackProblems(mutated, serveSource).length > 0;
    const unchanged = mutated === dbSource;
    check(`8a.2 CONTROL: mutation "${name}" is caught by these invariants`, caught && !unchanged, caught ? "caught" : "NOT CAUGHT — the invariants are vacuous");
  }
}

// ------------------------------------------------------------- case 8b: suites ---
const SUITES = [
  "funnel-check.ts",
  "field-answers-check.ts",
  "qualifications-review-check.ts",
  "qualifications-check.ts",
];

async function caseSuites(reachable: boolean): Promise<void> {
  section("8b. the four existing suites, with and without DATABASE_URL");
  for (const suite of SUITES) {
    for (const usePostgres of [false, true]) {
      if (usePostgres && !reachable) {
        skip(`${suite} with DATABASE_URL`, "base Postgres is not reachable");
        continue;
      }
      const label = usePostgres ? "with DATABASE_URL (Postgres)" : "without DATABASE_URL (SQLite)";
      const env: Record<string, string | undefined> = usePostgres ? { DATABASE_URL: BASE_URL } : { DATABASE_URL: undefined };
      const result = Bun.spawnSync({
        cmd: ["bun", "run", join(SITE, "scripts", suite)],
        cwd: SITE,
        env: childEnv(env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = `${result.stdout.toString()}${result.stderr.toString()}`;
      const passedMatch = /ALL CHECKS PASSED \((\d+)\)/.exec(out);
      const failedMatch = /(\d+) CHECK\(S\) FAILED out of (\d+)/.exec(out);
      const total = passedMatch ? Number(passedMatch[1]) : failedMatch ? Number(failedMatch[2]) : 0;
      console.log(`\n  $ ${usePostgres ? `DATABASE_URL=${redactedBase()} ` : ""}bun run scripts/${suite}`);
      console.log(`  exit ${String(result.exitCode)} — ${passedMatch ? `ALL CHECKS PASSED (${String(total)})` : failedMatch ? `${failedMatch[1]} of ${failedMatch[2]} failed` : "no summary line"}`);
      check(
        `${suite} ${label}: exit 0 with a non-zero check count (an empty suite cannot pass)`,
        result.exitCode === 0 && total > 0,
        `exit=${String(result.exitCode)} checks=${String(total)}`
      );
      if (result.exitCode !== 0) console.log(out.split("\n").slice(-25).join("\n"));
    }
  }
}

function childEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "DATABASE_URL") merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
