/**
 * poller.js — the bridge between Render (dashboard) and your local PC (browser).
 *
 * Render writes calendar_items into Supabase. This poller runs on your PC,
 * finds DUE items, and triggers your LOCAL server.js to generate them — so
 * the Playwright/Chrome browser runs on your real machine + residential IP
 * (the only place Flow actually works).
 *
 * No tunnels, no webhooks. Supabase is the message bus.
 *
 *   Setup:  put this in the project root, alongside server.js
 *   Env:    reads the same .env (SUPABASE_URL, SUPABASE_SERVICE_KEY)
 *   Run:    1) start the server:  node server.js
 *           2) start the poller:  node poller.js
 *           (or once-a-day via Task Scheduler using run-local.ps1)
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOCAL_API    = process.env.LOCAL_API || "http://localhost:3000";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const RUN_ONCE     = process.argv.includes("--once");   // process all due, then exit

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A calendar item is "due" when it's scheduled for today (or earlier) and
// hasn't been processed yet. We treat planned/prompt_ready as ready-to-run.
async function getDueItems() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("calendar_items")
    .select("*")
    .in("status", ["planned", "prompt_ready"])
    .lte("scheduled_date", today)
    .order("scheduled_date", { ascending: true });
  if (error) { log("⚠️  Supabase query error:", error.message); return []; }
  return data || [];
}

async function triggerGenerate(item) {
  // Claim the item first so a second poller / re-run won't double-process it.
  const { data: claimed } = await supabase
    .from("calendar_items")
    .update({ status: "generating" })
    .eq("id", item.id)
    .eq("status", item.status)         // optimistic lock: only if still unprocessed
    .select()
    .single();
  if (!claimed) { log("· already claimed, skipping", item.id); return; }

  log(`▶ generating: "${(item.topic||"").slice(0,50)}" (client ${item.client_id})`);
  try {
    const res = await fetch(`${LOCAL_API}/api/clients/${item.client_id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendar_item_id: item.id })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    log(`  ✓ job started (jobId ${body.jobId})`);
    // The local server runs the full pipeline (generate→download→compose→upload)
    // and updates calendar_items.status to done/error itself. We just kicked it off.
  } catch (e) {
    log(`  ✗ failed to start: ${e.message}`);
    // release it back so it can be retried next cycle
    await supabase.from("calendar_items").update({ status: item.status }).eq("id", item.id);
  }
}

async function processAllDue() {
  const due = await getDueItems();
  if (!due.length) { log("no due items"); return 0; }
  log(`${due.length} due item(s)`);
  for (const item of due) {
    await triggerGenerate(item);
    // serialize: let the server's own concurrency guard pace generation.
    // small gap so we don't fire them all at once.
    await sleep(4000);
  }
  return due.length;
}

(async () => {
  // Sanity: is the local server up?
  try {
    const h = await fetch(`${LOCAL_API}/api/health`).then(r => r.json()).catch(() => null);
    log("local server:", h ? "OK" : "(no /api/health — is server.js running?)");
  } catch { log("⚠️  Could not reach local server at", LOCAL_API, "— start server.js first"); }

  if (RUN_ONCE) {
    log("RUN ONCE: clearing all due items then exiting");
    await processAllDue();
    log("done.");
    process.exit(0);
  }

  log(`Polling every ${POLL_SECONDS}s. Ctrl+C to stop.`);
  for (;;) {
    try { await processAllDue(); } catch (e) { log("loop error:", e.message); }
    await sleep(POLL_SECONDS * 1000);
  }
})();