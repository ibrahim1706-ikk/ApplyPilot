// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server (provisioning starts it as `engine`; a team
// member's `bun run publish` runs as their own user), so publish never collides
// with an already-running server. Every sandbox user has passwordless sudo, so
// the takeover works across user boundaries.
import handler from "./dist/server/server.js";
import { dataLocation, storageReport } from "./src/db.ts";
import { startBackupScheduler } from "./src/server/backup.ts";

// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
/**
 * Seconds a connection may go without bytes in either direction before Bun closes
 * it. Bun's default is 10, and it counts a request whose handler is still running
 * but has written nothing yet — so a server function waiting on an AI provider for
 * 12s dies mid-flight and the platform gateway hands the visitor an empty 502.
 * 255 is the maximum Bun accepts; handlers that regularly run long should still
 * write bytes early (stream) or split into start-then-poll.
 */
const IDLE_TIMEOUT = 255;
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      idleTimeout: IDLE_TIMEOUT,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) return new Response(file);
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the built server entry default-exports a Bun fetch handler, and the dist import is untyped.
        return (handler as { fetch: (r: Request) => Response | Promise<Response> }).fetch(req);
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`team-site serving on http://${HOST}:${String(PORT)}`);

// Say where durable state lives, at boot, in the log. This is the line to read
// when asking "did the last publish wipe the accounts?": on the file backend the
// data directory must NOT be inside the site folder, because a publish replaces
// that folder — and on the managed backend the accounts are not in that folder
// at all, which is the whole point of DATABASE_URL.
try {
  const storage = storageReport();
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
  // Never a credential: on the managed backend this is the host, port and
  // database with the user name and password stripped off.
  console.log(`[applypilot] database: ${location.database}`);
  console.log(`[applypilot] uploads:  ${location.uploads}`);
  console.log(`[applypilot] rows at boot: ${JSON.stringify(storage.tables)}`);
} catch (error) {
  console.error(
    "[applypilot] STORAGE UNAVAILABLE — accounts, uploads and kits cannot be read or saved. " +
      `${error instanceof Error ? error.message : String(error)}`
  );
  // With DATABASE_URL set, starting anyway would mean serving pages off a local
  // file that the next publish deletes — the exact failure this store was moved
  // off the machine to fix, but with the app claiming the user's data is safe.
  // So a managed store that cannot be reached stops the process instead.
  if (dataLocation().managed) {
    console.error(
      "[applypilot] DATABASE_URL is set and the managed database is unusable, so this process " +
        "refuses to start on the local file backend. Fix DATABASE_URL (host, port, database, " +
        "user, password) and start again."
    );
    process.exit(1);
  }
}

// Nightly backup of the database and the uploads folder. This process is the one
// long-running thing the app owns, so the daily check lives here: it runs shortly
// after boot (which catches a day the server was asleep at 03:00) and then every
// 20 minutes. Failure is logged and never fatal — a backup must not take the site
// down, and a failed one has to be visible in .run/server.log.
try {
  startBackupScheduler(20);
  console.log("[applypilot] nightly backup scheduler started (runs daily at/after 03:00)");
} catch (error) {
  console.error("[applypilot] could not start the backup scheduler:", error);
}
