# Backup and restore

Everything a person has given ApplyPilot lives in two places on this machine, both
inside the **data directory** — which is deliberately *outside* the folder the site is
published from:

| What | Where |
| --- | --- |
| Accounts, profiles, postings, kits, sessions, reset links, rate-limit counters | `<data dir>/applypilot.db` (SQLite, WAL mode) |
| Uploaded originals (résumés, transcripts…) | `<data dir>/uploads/<user id>/…` |
| Nightly backups | `<data dir>/backups/` |

`<data dir>` is `APPLYPILOT_DATA_DIR` when that is set (absolute path required), otherwise
`<site dir>/../../.data/applypilot` — for this workspace, `/home/team/.data/applypilot`. The
server prints the resolved path on every boot (`.run/server.log`, line
`[applypilot] data dir: …`), and a signed-in user sees it on the Account page. Nothing the app
stores is written inside the site directory any more: a publish replaces that directory, and any
state kept there — the database included — was reset on the next ship.

One database file plus one uploads folder, on one disk, with no replica. That is the
single biggest operational risk in this build, so it is backed up nightly.

## What a backup contains

Each run writes three files into `<data dir>/backups/`:

| File | What it is |
| --- | --- |
| `applypilot-<YYYY-MM-DD>.sqlite` | A complete, consistent snapshot of the database, taken with SQLite's own `VACUUM INTO`, so a write happening at the same moment cannot leave a torn copy. |
| `uploads-<YYYY-MM-DD>.tar.gz` | Every stored original, in the same `<user id>/<file>` layout the app reads. |
| `backup-<YYYY-MM-DD>.json` | The manifest: when it ran, row counts per table, the uploads file/byte counts, and the SHA-256 of the database snapshot. |

## When it runs

- **Nightly, from the site server itself.** `serve.ts` starts a scheduler that checks
  every 20 minutes and takes the day's backup once the local hour is 03:00 or later —
  and, if the process was asleep at 03:00, on the next boot after that (the first check
  is 30 seconds after start). The line to look for in `.run/server.log` is
  `[applypilot] nightly backup written: …`.
- **On demand:** `bun run backup` from the site directory. Same code path, same output.
- **Retention:** the newest 14 dated backups are kept; older ones are deleted
  automatically at the end of every run.

A failed backup is logged (`[applypilot] nightly backup FAILED: …`) and never takes the
site down.

## Known gap, stated plainly

The backups sit on the same disk as the data they protect. That covers a bad write, a
corrupted database, an accidental deletion and a botched deploy — it does **not** cover
the disk or the machine dying. Copying `data/backups/` somewhere off this machine is
still outstanding and should be done before anyone relies on this for real data.

## Rehearsing a restore (safe, do this first)

```
cd /home/team/shared/site
bun run restore-check                 # newest backup
bun run restore-check --date 2026-09-26
bun run restore-check --to /tmp/scratch     # choose the scratch directory
```

This copies the snapshot into a scratch directory, extracts the uploads archive there,
opens the restored database read-only and prints every table's row count next to the
count recorded in the manifest, then does the same for the uploads file count and size.
It prints `RESTORE CHECK PASSED` only when every number matches, and exits non-zero when
one does not. It never touches the live database or the live uploads folder.

## Restoring for real

Set `DATA=/home/team/.data/applypilot` (or whatever `[applypilot] data dir:` prints in
`.run/server.log`) and use it in place of `data` below.

1. **Stop the site** so nothing writes during the swap. Restarting it later with
   `bun run publish` is enough — do not start a second server.
2. **Keep the current state**, in case you are restoring the wrong thing:
   `mv $DATA /tmp/data-before-restore-$(date +%s)`.
3. **Put the database back:**
   ```
   mkdir -p $DATA
   cp $DATA/backups/applypilot-<DATE>.sqlite $DATA/applypilot.db
   ```
   Do not copy `-wal`/`-shm` files — the snapshot is a complete database on its own. If
   stale ones exist from the old file, delete them:
   `rm -f $DATA/applypilot.db-wal $DATA/applypilot.db-shm`.
4. **Put the uploads back:**
   ```
   mkdir -p $DATA/uploads
   tar -xzf $DATA/backups/uploads-<DATE>.tar.gz -C $DATA/uploads
   ```
5. **Check the SHA-256** of the restored file against the manifest before starting:
   `sha256sum $DATA/applypilot.db` versus `databaseSha256` in
   `$DATA/backups/backup-<DATE>.json`.
6. **Restart:** `bun run publish`. The database schema is created idempotently on open,
   so a snapshot taken before a schema change still opens and later gains any new tables.
7. **Confirm the row counts** with `bun -e '…'` (or `sqlite3 $DATA/applypilot.db "select count(*) from users;"`)
   and compare against the manifest, then sign in and open an application kit.

## Checking that a deletion really deleted

```
bun run account-check <email or user id>
```

Prints the row count in every table that can hold a person's data plus the contents of
their uploads folder, and exits non-zero if anything is left. Exit 0 means nothing of
theirs remains in the database or on disk.
