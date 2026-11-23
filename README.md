# FinB billing dashboard

Static reconciliation dashboard for credit data reports billed through FinB.

## Where the numbers come from

`index.html` reads `data.json`. If that file is missing it falls back to the
snapshot embedded in the page (Jan to May 2026).

`data.json` is built by `scripts/sync.mjs` from the WealthScape fetch-logs API:

    GET https://<tenant-fiu-host>/pfm/api/v2/creditdata/fetch-logs?vendor=FinB

The script groups the rows by client, bureau and month and writes counts only.
Customer ids and error messages are never written, because this site is public.

## Refreshing

    export FETCH_LOGS_BASE_URL=https://<tenant-fiu-host>
    export FETCH_LOGS_TOKEN=<channel token>      # or CHANNEL_USER_ID + CHANNEL_PASSWORD
    node scripts/sync.mjs --list                  # row counts per fiuId
    node scripts/sync.mjs                         # writes data.json

Commit and push `data.json` to publish. Node 18 or newer, no dependencies.

The `Sync fetch logs` workflow does the same every day at 07:00 IST once the
repository secrets `FETCH_LOGS_BASE_URL`, `CHANNEL_USER_ID` and
`CHANNEL_PASSWORD` are set. Until then it does nothing.

## Client names

The API identifies clients by `fiuId`. `clients.json` maps each one to the name
used in the rate cards:

    { "clients": { "<fiuId>": "Airpay" }, "ignore": ["<test fiuId>"] }

A `fiuId` with no entry shows up under its raw id with "no rate", so new
clients are visible rather than dropped. Rates live in `CLIENT_RATES` and
`BASE_RATES` in `index.html`.

## Counting rules

- One log row is one attempt. Only `SUCCESSFUL` rows are billable.
- The month is taken from `createTime` (server time).
- Both `CREDIT_DATA_REPORT` and `CREDIT_DATA_PDF` rows are counted.
