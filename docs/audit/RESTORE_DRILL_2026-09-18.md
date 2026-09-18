# Restore drill — 2026-09-18 (issue #199)

**What this is:** the acceptance-criteria drill for #199 — the shipped
backup script (`deploy/backup/mjengo-backup.sh`) executed end-to-end
against a scratch deployment, and the §7.2 restore runbook executed
once, on this sandbox, with real commands and real outputs (only the
`[mjengo-backup]` log prefix and long paths are reproduced verbatim
below; nothing is paraphrased).

**Honest scope — what WAS and was NOT drilled:**

| Drilled in this sandbox | NOT drilled here (operator's step) |
|---|---|
| The real script: dry-run, online `.backup` under a **live WAL writer**, volume tars, sha256 sidecars, weekly refresh logic, retention pruning, failure injection (read-only target, missing DB, bad arg) | Installing the systemd pair on a booted systemd host (sandbox has no running systemd; units follow the proven `mjengo-jobs` pattern) |
| The §7.2 restore runbook at script level: checksum verify → stop-writers → DB restore **incl. the stale-WAL-sidecar trap** → volume untars → `PRAGMA integrity_check` + row counts + byte-identical file diffs | A full `docker compose` stack drill (no docker daemon in the sandbox): `compose stop` → restore into real named volumes → `up -d` → **`GET /api/health` 200** + counts via the API |
| Retention: expired dailies/weeklies planted with `touch -d` and observed being pruned | The compose ACL grant (`setfacl`) for the `mjengo` service user on a real docker host |

Environment: Debian-ish sandbox, GNU bash 5.2.37, sqlite3 3.53.1 (static
CLI downloaded to `/tmp` — the sandbox has no system sqlite3; the script
itself only assumes `sqlite3` on PATH on the host), GNU tar 1.35,
coreutils 9.7, shellcheck 0.10.0. Script under test:
`deploy/backup/mjengo-backup.sh` at repo commit `b603096`
(branch `infra/199-backup-restore`). Scratch tree: `/tmp/mjengo-drill`
(kept out of the repo).

---

## 1) Scratch deployment (three "volumes", one small DB)

```bash
mkdir -p /tmp/mjengo-drill/host/volumes/{app-db,app-photos,website-data} \
         /tmp/mjengo-drill/backups /tmp/mjengo-drill/restore

sqlite3 /tmp/mjengo-drill/host/volumes/app-db/custom.db <<'SQL'
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, daily_rate_cents INTEGER NOT NULL);
CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, direction TEXT NOT NULL);
INSERT INTO projects VALUES ('prj-001','Runda 3BR main build','active');
INSERT INTO projects VALUES ('prj-002','Kiambu perimeter wall','active');
INSERT INTO projects VALUES ('prj-003','Karen roof replacement','closed');
INSERT INTO workers VALUES ('wrk-001','Joseph Mwangi',150000);
-- … (5 workers, 8 ledger_entries total — full statements elided here,
--     they are plain INSERTs like the two above)
PRAGMA journal_mode=WAL;
SQL

# the excluded-by-construction sibling (cache-like, never backed up):
sqlite3 /tmp/mjengo-drill/host/volumes/app-db/ratelimit.db \
  "CREATE TABLE bucket(k TEXT PRIMARY KEY, n INT); INSERT INTO bucket VALUES ('demo',1);"

# app-photos: 3 real photos copied from the repo (public/photos/*.png)
# website-data: submissions.json — 2 fake-PII entries ({id,ts,source,name,email,…})
```

Baseline of the live DB (the numbers every later check must reproduce):

```
$ ls /tmp/mjengo-drill/host/volumes/app-db/
custom.db  ratelimit.db

$ sqlite3 custom.db "PRAGMA integrity_check; \
  SELECT 'projects='||count(*) FROM projects; \
  SELECT 'workers='||count(*) FROM workers; \
  SELECT 'ledger_entries='||count(*) FROM ledger_entries;"
ok
projects=3
workers=5
ledger_entries=8
```

## 2) Dry run (writes nothing)

```bash
MJENGO_DB_PATH=/tmp/mjengo-drill/host/volumes/app-db/custom.db \
MJENGO_PHOTOS_DIR=/tmp/mjengo-drill/host/volumes/app-photos \
MJENGO_WEBSITE_DIR=/tmp/mjengo-drill/host/volumes/website-data \
MJENGO_BACKUP_DIR=/tmp/mjengo-drill/backups \
deploy/backup/mjengo-backup.sh --dry-run
```

```
[mjengo-backup] DRY RUN — nothing will be written
[mjengo-backup] db:       /tmp/mjengo-drill/host/volumes/app-db/custom.db
[mjengo-backup]             → /tmp/mjengo-drill/backups/daily/mjengo-db-20260918T085445Z.db (online sqlite3 .backup + integrity_check)
[mjengo-backup] photos:   /tmp/mjengo-drill/host/volumes/app-photos
[mjengo-backup]             → /tmp/mjengo-drill/backups/daily/mjengo-photos-20260918T085445Z.tar.gz (tar+gzip + tar -tzf read-back)
[mjengo-backup] website:  /tmp/mjengo-drill/host/volumes/website-data  [PII — #151]
[mjengo-backup]             → /tmp/mjengo-drill/backups/daily/mjengo-website-20260918T085445Z.tar.gz (tar+gzip + tar -tzf read-back)
[mjengo-backup] excluded by construction: db/ratelimit.db (+ -wal/-shm) — cache-like, safe to lose
[mjengo-backup] weekly refresh this run: yes
[mjengo-backup] retention: would prune from /tmp/mjengo-drill/backups/daily files older than 7 days:
[mjengo-backup]   (nothing yet — /tmp/mjengo-drill/backups/daily does not exist)
[mjengo-backup] retention: would prune from /tmp/mjengo-drill/backups/weekly files older than 28 days:
[mjengo-backup]   (nothing yet — /tmp/mjengo-drill/backups/weekly does not exist)
[mjengo-backup] DRY RUN complete — nothing was written
```

`echo $?` → `0`; `ls /tmp/mjengo-drill/backups` → empty. (Note the
explicit statement of the ratelimit exclusion — §7.2's rule, enforced by
construction: only the single DB file is ever read.)

## 3) Run #1 (first run — weekly refresh due)

Same env, no `--dry-run`:

```
[mjengo-backup] db: online .backup → /tmp/mjengo-drill/backups/daily/mjengo-db-20260918T085445Z.db
[mjengo-backup] db: integrity_check ok, 28K
[mjengo-backup] photos: tar+gzip /tmp/mjengo-drill/host/volumes/app-photos → /tmp/mjengo-drill/backups/daily/mjengo-photos-20260918T085445Z.tar.gz
[mjengo-backup] photos: 4 entries, 544K
[mjengo-backup] website: tar+gzip /tmp/mjengo-drill/host/volumes/website-data → /tmp/mjengo-drill/backups/daily/mjengo-website-20260918T085445Z.tar.gz
[mjengo-backup] website: 2 entries, 4.0K
[mjengo-backup] weekly: refreshed (/tmp/mjengo-drill/backups/weekly now holds this run's set)
[mjengo-backup] retention: pruned 0 old artifact(s) from /tmp/mjengo-drill/backups/daily (keep 7d)
[mjengo-backup] retention: pruned 0 old artifact(s) from /tmp/mjengo-drill/backups/weekly (keep 28d)
[mjengo-backup] run complete: 6 file(s) under /tmp/mjengo-drill/backups/daily — verify with: sha256sum -c <artifact>.sha256
```

`echo $?` → `0`. Artifacts (note the `0600` perms — `umask 077`; the
website archive is PII, #151; note link count `2` = the weekly hardlink):

```
/tmp/mjengo-drill/backups/daily/:
-rw------- 2 z z  28672 Sep 18 08:54 mjengo-db-20260918T085445Z.db
-rw------- 2 z z     96 Sep 18 08:54 mjengo-db-20260918T085445Z.db.sha256
-rw------- 2 z z 554730 Sep 18 08:54 mjengo-photos-20260918T085445Z.tar.gz
-rw------- 2 z z    104 Sep 18 08:54 mjengo-photos-20260918T085445Z.tar.gz.sha256
-rw------- 2 z z    393 Sep 18 08:54 mjengo-website-20260918T085445Z.tar.gz
-rw------- 2 z z    105 Sep 18 08:54 mjengo-website-20260918T085445Z.tar.gz.sha256
```

**Verification of run #1** (what §7.2 tells an operator to do after any
restore, done here on the backup itself):

```
$ cd /tmp/mjengo-drill/backups/daily && sha256sum -c \
    mjengo-db-20260918T085445Z.db.sha256 \
    mjengo-photos-20260918T085445Z.tar.gz.sha256 \
    mjengo-website-20260918T085445Z.tar.gz.sha256
mjengo-db-20260918T085445Z.db: OK
mjengo-photos-20260918T085445Z.tar.gz: OK
mjengo-website-20260918T085445Z.tar.gz: OK

$ sqlite3 mjengo-db-20260918T085445Z.db "PRAGMA integrity_check; …"
ok
projects=3
workers=5
ledger_entries=8                      # == live baseline

$ tar -tzf mjengo-photos-20260918T085445Z.tar.gz
./
./foundation-done.png
./cement-delivery.png
./walling-progress.png

$ tar -tzf mjengo-website-20260918T085445Z.tar.gz
./
./submissions.json
```

The snapshot is **standalone** — no `-wal`/`-shm` sidecars next to it
(the online backup API folds the WAL into the copy), which is exactly
what makes it safe to move around and restore from.

## 4) Run #2 under a LIVE writer (the WAL-safety proof)

A second process (python3) opened the live DB, held one **uncommitted**
INSERT (`prj-LIVE`) inside an open transaction, and slept — so the
backup ran while the DB was mid-write with WAL sidecars present:

```
$ ls /tmp/mjengo-drill/host/volumes/app-db/     # while the writer held the txn
custom.db  custom.db-shm  custom.db-wal  ratelimit.db
```

Those sidecars are what a naive `cp custom.db backup.db` would have to
get right — and usually gets wrong (a detached or half-copied WAL
restores as corruption). The script's `.backup` path does not care:

```
[mjengo-backup] db: online .backup → /tmp/mjengo-drill/backups/daily/mjengo-db-20260918T085607Z.db
[mjengo-backup] db: integrity_check ok, 28K
[mjengo-backup] photos: tar+gzip … → …/mjengo-photos-20260918T085607Z.tar.gz
[mjengo-backup] photos: 4 entries, 544K
[mjengo-backup] website: tar+gzip … → …/mjengo-website-20260918T085607Z.tar.gz
[mjengo-backup] website: 2 entries, 4.0K
[mjengo-backup] weekly: skipped (a weekly set newer than 6 days already exists)
[mjengo-backup] retention: pruned 0 old artifact(s) from …/daily (keep 7d)
[mjengo-backup] retention: pruned 0 old artifact(s) from …/weekly (keep 28d)
[mjengo-backup] run complete: 6 file(s) under /tmp/mjengo-drill/backups/daily — …
```

`echo $?` → `0`, and the snapshot taken mid-transaction:

```
$ sqlite3 mjengo-db-20260918T085607Z.db "PRAGMA integrity_check; \
  SELECT 'projects='||count(*) FROM projects; \
  SELECT 'uncommitted prj-LIVE rows='||count(*) FROM projects WHERE id='prj-LIVE';"
ok
projects=3
uncommitted prj-LIVE rows=0
```

A consistent **committed-state** snapshot, taken while a writer was
mid-transaction — that is the online-backup guarantee, demonstrated
rather than asserted. After the writer died, SQLite rolled its
uncommitted row back on close (live DB: `projects=3`,
`prj-LIVE rows=0`).

## 5) Failure injection (issue's testing requirement)

**A. read-only backup target dir** (`mkdir -p … && chmod 555 …`, then
`MJENGO_BACKUP_DIR=<that dir>`):

```
$ …mjengo-backup.sh ; echo $?
mkdir: cannot create directory '/tmp/mjengo-drill/backups-ro/daily': Permission denied
[mjengo-backup] FAILED (line 222, exit 1): run did not complete.
1
```

Non-zero exit + one stderr `[mjengo-backup] FAILED …` line (the failing
command's own error lands just above it). Under the timer both lines go
to the journal and the unit is FAILED — dead-man-switchable.

**B. missing database** (`MJENGO_DB_PATH=…/NOPE.db`):

```
[mjengo-backup] FAILED: database not found at MJENGO_DB_PATH=/tmp/mjengo-drill/host/volumes/app-db/NOPE.db — set the real path in /etc/mjengo/backup.env (discovery commands in the env example)
```

`echo $?` → `1` (fast fail, nothing written — also proves the script
never lets sqlite3 "helpfully" create an empty DB and call it a backup).

**C. unknown argument** (`--bogus`): usage to stderr + `FAILED: unknown
argument: --bogus`, exit `1`.

## 6) THE RESTORE (the §7.2 runbook, executed)

Restoring run #2's set into a **fresh scratch host**
(`/tmp/mjengo-drill/restore`), exactly in runbook order:

**Step 0 — stop the app first.** In the drill the live writer above was
already gone (real world: `docker compose stop app jobs-tick` /
`systemctl stop mjengo-app`). The WAL rule's restore half: never swap a
live DB file under a running app.

**Step 1 — verify the backup before trusting it:**

```
$ cd /tmp/mjengo-drill/backups/daily && sha256sum -c \
    mjengo-db-20260918T085607Z.db.sha256 \
    mjengo-photos-20260918T085607Z.tar.gz.sha256 \
    mjengo-website-20260918T085607Z.tar.gz.sha256
mjengo-db-20260918T085607Z.db: OK
mjengo-photos-20260918T085607Z.tar.gz: OK
mjengo-website-20260918T085607Z.tar.gz: OK
```

**Step 2 — restore the DB volume, including the stale-WAL trap.** The
restore dir was pre-seeded with a fake leftover `custom.db-wal` /
`custom.db-shm` from the "dead" old database — the classic way a restore
goes subtly wrong (new main file + stale sidecars = SQLite may replay
foreign WAL frames or refuse). The runbook removes them:

```bash
install -m 0644 mjengo-db-20260918T085607Z.db /tmp/mjengo-drill/restore/app-db/custom.db
rm -f /tmp/mjengo-drill/restore/app-db/custom.db-wal \
      /tmp/mjengo-drill/restore/app-db/custom.db-shm
sqlite3 /tmp/mjengo-drill/restore/app-db/custom.db 'PRAGMA integrity_check;'   # → ok
```

(compose host: the `install` targets
`/var/lib/docker/volumes/<project>_app-db/_data/custom.db`; add
`-o 1000 -g 1000` to hand it to the container's `node` user. No
`ratelimit.db` is restored — the app recreates it; restoring a stale
one would resurrect old throttle state for no benefit.)

**Step 3 — restore the volume tars:**

```bash
tar -C /tmp/mjengo-drill/restore/app-photos   -xzf mjengo-photos-20260918T085607Z.tar.gz
tar -C /tmp/mjengo-drill/restore/website-data -xzf mjengo-website-20260918T085607Z.tar.gz
```

**Step 4 — start the app.** *(Not executable in this sandbox — no docker
daemon / no stack. Real command: `docker compose up -d`, then the
verification below.)*

**Step 5 — verify:**

```
$ sqlite3 /tmp/mjengo-drill/restore/app-db/custom.db "PRAGMA integrity_check; \
  SELECT 'projects='||count(*) FROM projects; SELECT 'workers='||count(*) FROM workers; \
  SELECT 'ledger_entries='||count(*) FROM ledger_entries; \
  SELECT 'prj-LIVE rows='||count(*) FROM projects WHERE id='prj-LIVE';"
ok
projects=3
workers=5
ledger_entries=8
prj-LIVE rows=0

$ diff -r /tmp/mjengo-drill/host/volumes/app-photos /tmp/mjengo-drill/restore/app-photos
photos: diff -r IDENTICAL

$ cmp /tmp/mjengo-drill/host/volumes/website-data/submissions.json \
       /tmp/mjengo-drill/restore/website-data/submissions.json
submissions.json: cmp IDENTICAL
```

Row counts match the pre-incident baseline exactly; photos and the PII
leads file are byte-identical. (On a real stack, finish with
`curl -fsS https://your-host/api/health` → `{"ok":true,"db":"up",…}` —
see §7.2.)

## 7) Retention drill

Planted a 10-day-old daily pair and a 40-day-old weekly pair
(`touch -d '10 days ago' mjengo-db-20260908T043000Z.db` etc.), then one
more run:

```
[mjengo-backup] … run 3 artifacts as usual …
[mjengo-backup] retention: pruned 2 old artifact(s) from /tmp/mjengo-drill/backups/daily (keep 7d)
[mjengo-backup] retention: pruned 2 old artifact(s) from /tmp/mjengo-drill/backups/weekly (keep 28d)
```

Post-run `ls`: the planted `20260908` dailies and `20260809` weeklies
gone; every current artifact kept. Only `mjengo-*` regular files at
depth 1 are ever deleted — the dirs and anything else an operator parks
next to them are untouchable.

Bonus proof that the weekly set costs no extra space (hardlink, same
inode):

```
$ stat -c '%h links  inode %i  %n' \
    …/daily/mjengo-db-20260918T085445Z.db …/weekly/mjengo-db-20260918T085445Z.db
2 links  inode 594459  /tmp/mjengo-drill/backups/daily/mjengo-db-20260918T085445Z.db
2 links  inode 594459  /tmp/mjengo-drill/backups/weekly/mjengo-db-20260918T085445Z.db
```

## 8) Static checks

- `bash -n deploy/backup/mjengo-backup.sh` → clean.
- `shellcheck 0.10.0 deploy/backup/mjengo-backup.sh` → **0 findings**
  (shellcheck was not preinstalled in the sandbox; the official static
  v0.10.0 build was downloaded to `/tmp` for this check).
- `bun run lint` / `bun run test` unaffected (no `src/` changes) — see
  the PR body for the runs.

## 9) Verdict + what remains for the operator

**Verdict: PASS at script level.** The backup script produced verified,
standalone, integrity-checked artifacts under a live WAL writer, failed
loudly on every injected fault, pruned by retention as specified, and
the runbook's restore path returned the exact baseline state (counts,
integrity, byte-identical files) into a fresh location.

**Remaining for the operator on the real host** (this sandbox has
neither docker nor a running systemd): install the timer pair per the
`INSTALL` headers, grant the `mjengo` user read on the compose volumes
(`setfacl` commands in `mjengo-backup.env.example`), and run ONE
full-stack drill: `systemctl start mjengo-backup.service` →
`docker compose stop app` → restore per §7.2 into the real volumes →
`docker compose up -d` → `curl -fsS localhost:3000/api/health` must
answer `{"ok":true,"db":"up",…}`, and (issue #164: the counts are gated
now) the detail probe
`curl -fsS -H "X-Health-Detail: $HEALTH_DETAIL_TOKEN" localhost:3000/api/health`
— or an admin session in the browser — must show the expected `counts`.
A backup that has never been restored on YOUR hardware is still a hope,
not a backup.
