# smapiexporter

Reads OpenText Service Management (SMAX) cases from the EMS REST API and writes them as
JSON batches for [smjsonparser](https://github.com/TitanXV4000/smjsonparser), which stores
them in Mongo for qmon and wallboard. It replaces the report download done by
[smexporter](https://github.com/TitanXV4000/smexporter) / smreportparser.

One headless browser stays logged in (OpenText SAML sign-in) and the API is called from
inside that page, so it uses the browser session. Every minute it writes one batch with:

- every case changed since the previous batch (less a 2-minute overlap), with Description
  and the latest comment, and
- every open case with no owner (the unassigned queue), without Description. Their SLT
  target can change without the case's update time changing, and since the queue is never
  empty in practice, this keeps the newest `logTime` (what qmon's freshness checks read)
  moving every minute even when no case changes.

On first start (no state file) it back-fills all open cases plus closed ones updated in the
last `BACKFILL_DAYS`. The time of the newest change is kept in `OUTPUT_PATH/state/api-state.json`,
so after a stop it picks up everything changed while it was down. If the parser has more
than `BACKLOG_LIMIT` unread batches, only the changed cases are written until it catches up.

Batch files are named `cases_<UTC time>_<sequence>.json` and sort oldest first. Rows are
keyed by the column names of the old QMON report (plus `Description`).

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `SM_URL` | | OTSM report URL (gives the host and tenant) |
| `USER_LOGIN`, `PASS` | | OTSM sign-in |
| `OUTPUT_PATH` | `/smexports-api` | where batches are written |
| `REPORT_INTERVAL` | `60000` | ms between batches |
| `OVERLAP_MS` | `120000` | look-back added to "changed since" |
| `BACKFILL_DAYS` | `90` | closed cases updated this recently are loaded on first start |
| `PAGE_SIZE`, `BATCH_ROWS` | `1000` | API page size, rows per file |
| `MAX_FAILED_CYCLES` | `5` | failed minutes in a row before exiting |
| `BACKLOG_LIMIT` | `20` | unread batches before writing changed cases only |
| `ARCHIVE_PATH` | | testing: keep a copy of every batch here |
| `LOG_LEVEL`, `SERVICE_NAME`, `TIMEZONE`, `NODE_ENV` | | logging |

## Run

```
docker build -t tsanford/smapiexporter .
docker run -d --name smapiexporter --restart unless-stopped --shm-size 2g \
  -e TZ=America/Denver -v smapidata:/smexports-api --env-file smapiexporter.env \
  tsanford/smapiexporter
```

On any unexpected error the process
exits, so Docker restarts it with a fresh login.
