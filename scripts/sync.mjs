#!/usr/bin/env node
// Pulls credit bureau fetch logs from the WealthScape fetch-logs API and writes
// the client x bureau x month aggregate the dashboard reads (data.json).
//
// Only counts are written. Raw rows (customer ids, error messages) never leave
// this process, because data.json is served from a public GitHub Pages site.
//
// Env:
//   FETCH_LOGS_BASE_URL   tenant FIU host, e.g. https://<tenant-fiu-host>
//   FETCH_LOGS_TOKEN      bearer token (channel or user), or instead:
//   CHANNEL_USER_ID / CHANNEL_PASSWORD   to mint a channel token
//   FETCH_LOGS_VENDOR     default FinB
//   FETCH_LOGS_FILE       read rows from a saved JSON response instead of the API
//
// Flags:
//   --list      print row counts per fiuId and exit (use it to fill clients.json)
//   --dry-run   print the aggregate, do not write data.json

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const env = process.env;
const VENDOR = env.FETCH_LOGS_VENDOR || "FinB";

function fail(msg) {
  console.error("sync: " + msg);
  process.exit(1);
}

async function getToken(base) {
  if (env.FETCH_LOGS_TOKEN) return env.FETCH_LOGS_TOKEN.replace(/^Bearer\s+/i, "");
  if (!env.CHANNEL_USER_ID || !env.CHANNEL_PASSWORD) {
    fail("set FETCH_LOGS_TOKEN, or CHANNEL_USER_ID and CHANNEL_PASSWORD");
  }
  const res = await fetch(base + "/pfm/api/v2/channel-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: env.CHANNEL_USER_ID, password: env.CHANNEL_PASSWORD }),
  });
  if (!res.ok) fail(`channel-token returned HTTP ${res.status}`);
  const body = await res.json();
  const token = body.token || body.accessToken || body.access_token || body.data?.token;
  if (!token) fail("channel-token response had no token field");
  return token;
}

async function loadRows() {
  if (env.FETCH_LOGS_FILE) {
    return JSON.parse(await readFile(env.FETCH_LOGS_FILE, "utf8"));
  }
  const base = (env.FETCH_LOGS_BASE_URL || "").replace(/\/+$/, "");
  if (!base) fail("set FETCH_LOGS_BASE_URL (or FETCH_LOGS_FILE)");
  const token = await getToken(base);
  // No bureau param: the API coerces an unknown bureau to EXPERIAN, so one
  // unfiltered call per vendor is the only way to get every bureau.
  const url = `${base}/pfm/api/v2/creditdata/fetch-logs?vendor=${encodeURIComponent(VENDOR)}`;
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) fail(`fetch-logs returned HTTP ${res.status}`);
  return res.json();
}

// LocalDateTime arrives as an ISO string or, with some Jackson configs, as
// [year, month, day, ...]. Either way only the year-month is needed.
function monthOf(v) {
  if (Array.isArray(v) && v.length >= 2) return `${v[0]}-${String(v[1]).padStart(2, "0")}`;
  if (typeof v === "string" && /^\d{4}-\d{2}/.test(v)) return v.slice(0, 7);
  return null;
}

const rows = await loadRows();
if (!Array.isArray(rows)) fail("expected a JSON array of fetch-log rows");

const wanted = rows.filter(r => String(r.vendor || "").toUpperCase() === VENDOR.toUpperCase());

if (args.has("--list")) {
  const per = {};
  for (const r of wanted) per[r.fiuId] = (per[r.fiuId] || 0) + 1;
  console.table(Object.entries(per).sort((a, b) => b[1] - a[1]).map(([fiuId, rows]) => ({ fiuId, rows })));
  process.exit(0);
}

const cfg = JSON.parse(await readFile(path.join(ROOT, "clients.json"), "utf8"));
const names = cfg.clients || {};
const ignore = new Set(cfg.ignore || []);

const agg = new Map();
const unmapped = new Set();
let counted = 0, undated = 0;
for (const r of wanted) {
  if (ignore.has(r.fiuId)) continue;
  // createTime is when the hit was made; dataFetchTime moves on a retry.
  const month = monthOf(r.createTime) || monthOf(r.dataFetchTime);
  if (!month) { undated++; continue; }
  const client = names[r.fiuId] || r.fiuId || "unknown";
  if (!names[r.fiuId]) unmapped.add(client);
  const bureau = String(r.bureau || "UNKNOWN").toUpperCase();
  const key = [client, bureau, month].join("|");
  let a = agg.get(key);
  if (!a) agg.set(key, a = { client, bureau, month, total: 0, successful: 0, failed: 0, pending: 0 });
  a.total++;
  if (r.dataFetchStatus === "SUCCESSFUL") a.successful++;
  else if (r.dataFetchStatus === "FAILED") a.failed++;
  else a.pending++;
  counted++;
}

const out = {
  generatedAt: new Date().toISOString(),
  vendor: VENDOR,
  records: counted,
  unmapped: [...unmapped].sort(),
  rows: [...agg.values()].sort((a, b) =>
    a.client.localeCompare(b.client) || a.bureau.localeCompare(b.bureau) || a.month.localeCompare(b.month)),
};

if (undated) console.warn(`sync: skipped ${undated} rows with no timestamp`);
if (unmapped.size) console.warn("sync: fiuIds with no name in clients.json: " + out.unmapped.join(", "));

if (args.has("--dry-run")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  await writeFile(path.join(ROOT, "data.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`sync: wrote data.json (${counted} records, ${out.rows.length} rows)`);
}
