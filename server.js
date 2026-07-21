require("dotenv").config();

const express = require("express");
const multer = require("multer");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const supabase = require("./lib/supabase");
const assetsSync = require("./lib/assets-sync");
const groqLib = require("./lib/groq");
const videoLib = require("./lib/video");
const googleLib = require("./lib/google");
const rssLib = require("./lib/rss");
const feedsLib = require("./lib/feeds");
const { buildScript } = require("./lib/flow");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

const upload = multer({ dest: "uploads/" });
["uploads", "outputs", "assets"].forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

// LOCAL calendar day (YYYY-MM-DD). "today" must mean the operator's day, not UTC
// (UTC can be a day behind near midnight IST). Defaults to IST (+330 min);
// override with TZ_OFFSET_MINUTES in the environment (e.g. -480 for US Pacific).
const TZ_OFFSET_MIN = parseInt(process.env.TZ_OFFSET_MINUTES || "330", 10);
function localToday() {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
function localHour() {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60000).getUTCHours();
}

// ── live job log streaming ─────────────────────────────────────────
const jobs = new Map(); // jobId -> { logs:[], ws, videoId }
let generationBusy = false; // true while a Flow browser session is running (serializes generations)
const activeItems = new Set(); // calendar_item ids being generated RIGHT NOW by this process

wss.on("connection", (ws, req) => {
  const jobId = new URL(req.url, "http://localhost").searchParams.get("jobId");
  if (jobId && jobs.has(jobId)) {
    const job = jobs.get(jobId);
    job.ws = ws;
    job.logs.forEach(l => ws.send(JSON.stringify(l)));
  }
});

function sendLog(jobId, type, message) {
  const job = jobs.get(jobId);
  const entry = { type, message, ts: Date.now() };
  if (job) {
    job.logs.push(entry);
    if (job.ws && job.ws.readyState === WebSocket.OPEN) job.ws.send(JSON.stringify(entry));
  }
  console.log(`[${jobId.slice(0, 6)}] ${message}`);
  // Relay to Supabase so the Render dashboard (a different machine) can show
  // logs from the local generator. Fire-and-forget; never blocks the pipeline.
  supabase.from("job_logs").insert({
    job_id: jobId,
    client_id: job?.clientId || null,
    type, message, ts: entry.ts
  }).then(() => {}, () => {});
}

// Recent generation logs (read from Supabase) — lets ANY dashboard (Render or
// local) show live logs from the local generator. Poll with ?since=<ts>.
app.get("/api/logs", async (req, res) => {
  try {
    const since = Number(req.query.since || 0);
    const clientId = req.query.client_id;
    let q = supabase.from("job_logs").select("*").gt("ts", since).order("ts", { ascending: true }).limit(300);
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// helper: persist an uploaded file into assets/ with a stable name
function saveAsset(file, prefix) {
  if (!file) return null;
  const ext = path.extname(file.originalname) || "";
  const name = `${prefix}_${Date.now()}${ext}`;
  const dest = path.join(__dirname, "assets", name);
  fs.renameSync(file.path, dest);
  return name;
}

// helper: fill {placeholders} in a template; returns null if template is empty
function applyTpl(tpl, vars) {
  if (!tpl) return null;
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
}

// ====================================================================
//  CLIENTS
// ====================================================================
app.get("/api/clients", async (req, res) => {
  try {
    const { data, error } = await supabase.from("clients").select("*").order("created_at");
    if (error) return res.status(500).json({ error: error.message + (error.hint ? " — " + error.hint : "") });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Supabase unreachable: " + e.message });
  }
});

app.get("/api/styles", (req, res) => res.json(groqLib.promptStyles.list()));
app.get("/api/feed-categories", (req, res) => res.json(feedsLib.list()));

// Health check — visit http://localhost:3000/api/health to verify Supabase + env
app.get("/api/health", async (req, res) => {
  const env = {
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_key: !!process.env.SUPABASE_SERVICE_KEY,
    groq_key: !!process.env.GROQ_API_KEY,
    google_oauth: !!process.env.GOOGLE_CLIENT_ID
  };
  let db = "ok";
  try {
    const { error } = await supabase.from("clients").select("id").limit(1);
    if (error) db = "error: " + error.message;
  } catch (e) { db = "unreachable: " + e.message; }
  res.json({ env, db, busy: generationBusy });
});

app.get("/api/clients/:id", async (req, res) => {
  const { data, error } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.post("/api/clients", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const { data, error } = await supabase.from("clients").insert({ name }).select().single();
    if (error) return res.status(500).json({ error: error.message + (error.hint ? " — " + error.hint : "") });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Supabase request failed: " + e.message + " (check SUPABASE_URL/SERVICE_KEY in .env and that you ran supabase-schema.sql)" });
  }
});

// Update client config (multipart: cookies json text, frame, outro, reference image + json fields)
app.post("/api/clients/:id/config", upload.fields([
  { name: "frame", maxCount: 1 },
  { name: "outro", maxCount: 1 },
  { name: "reference_image", maxCount: 1 }
]), async (req, res) => {
  const patch = {};
  const b = req.body;
  if (b.name !== undefined) patch.name = b.name;
  if (b.business_details !== undefined) patch.business_details = b.business_details;
  if (b.chatgpt_link !== undefined) patch.chatgpt_link = b.chatgpt_link || null;
  if (b.image_chat_link !== undefined) patch.image_chat_link = b.image_chat_link || null;
  if (b.prompt_sample !== undefined) patch.prompt_sample = b.prompt_sample || null;
  if (b.split_parts !== undefined) patch.split_parts = b.split_parts === "true" || b.split_parts === true;
  if (b.video_seconds !== undefined) { const s10 = Math.max(10, Math.min(30, Math.round(Number(b.video_seconds)/10)*10)); patch.video_seconds = [10,20,30].includes(s10) ? s10 : 10; }
  if (b.per_part_images !== undefined) patch.per_part_images = b.per_part_images === "true" || b.per_part_images === true;
  if (b.upload_to_drive !== undefined) patch.upload_to_drive = b.upload_to_drive === "true";
  if (b.drive_folder_id !== undefined) patch.drive_folder_id = b.drive_folder_id || null;
  if (b.upload_to_youtube !== undefined) patch.upload_to_youtube = b.upload_to_youtube === "true";
  if (b.yt_default_tags !== undefined) patch.yt_default_tags = b.yt_default_tags;
  // prompt style
  if (b.prompt_style !== undefined) patch.prompt_style = b.prompt_style || "default";
  if (b.prompt_custom !== undefined) patch.prompt_custom = b.prompt_custom || null;
  // content mode + RSS
  if (b.mode !== undefined) patch.mode = ["rss", "products"].includes(b.mode) ? b.mode : "calendar";
  if (b.rss_feeds !== undefined) patch.rss_feeds = b.rss_feeds;
  if (b.rss_categories !== undefined) patch.rss_categories = b.rss_categories;
  if (b.rss_daily_limit !== undefined) patch.rss_daily_limit = parseInt(b.rss_daily_limit) || 3;

  // Fixed prompt (skip ChatGPT entirely for the video prompt)
  if (b.fixed_prompt_mode !== undefined) patch.fixed_prompt_mode = b.fixed_prompt_mode === "true" || b.fixed_prompt_mode === true;
  if (b.fixed_prompt !== undefined) patch.fixed_prompt = b.fixed_prompt || null;
  // Fixed prompt for the per-part IMAGE generation step
  if (b.fixed_image_prompt !== undefined) patch.fixed_image_prompt = b.fixed_image_prompt || null;
  // Voiceover on/off + language
  if (b.voiceover_enabled !== undefined) patch.voiceover_enabled = b.voiceover_enabled === "true" || b.voiceover_enabled === true;
  if (b.voiceover_language !== undefined) patch.voiceover_language = b.voiceover_language || "Hindi/Hinglish";
  // Day-fixed monthly topics: [{day:"Mon",topic:"..."}]
  if (b.topic_days !== undefined) {
    try { patch.topic_days = typeof b.topic_days === "string" ? JSON.parse(b.topic_days) : b.topic_days; }
    catch { return res.status(400).json({ error: "topic_days must be valid JSON" }); }
  }
  if (b.product_images !== undefined) {
    try { patch.product_images = typeof b.product_images === "string" ? JSON.parse(b.product_images) : b.product_images; }
    catch { return res.status(400).json({ error: "product_images must be valid JSON" }); }
  }

  if (b.cookies) {
    try { patch.cookies = JSON.parse(b.cookies); }
    catch { return res.status(400).json({ error: "cookies must be valid JSON" }); }
  }
  if (req.files?.frame?.[0]) {
    patch.frame_path = saveAsset(req.files.frame[0], `frame_${req.params.id}`);
    await assetsSync.uploadAsset(path.join(__dirname, "assets", patch.frame_path), patch.frame_path);
  }
  if (req.files?.outro?.[0]) {
    patch.outro_path = saveAsset(req.files.outro[0], `outro_${req.params.id}`);
    await assetsSync.uploadAsset(path.join(__dirname, "assets", patch.outro_path), patch.outro_path);
  }
  if (req.files?.reference_image?.[0]) {
    // store with original extension so Flow accepts the format
    const f = req.files.reference_image[0];
    const ext = path.extname(f.originalname).toLowerCase() || ".png";
    const name = `ref_${req.params.id}_${Date.now()}${ext}`;
    fs.renameSync(f.path, path.join(__dirname, "assets", name));
    patch.reference_image_path = name;
    await assetsSync.uploadAsset(path.join(__dirname, "assets", name), name);
  }

  const { data, error } = await supabase.from("clients").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete a client's reference image (clears DB path + removes local + storage copy)
app.delete("/api/clients/:id/reference-image", async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("reference_image_path").eq("id", req.params.id).single();
    const name = client?.reference_image_path;
    if (name) {
      try { fs.unlinkSync(path.join(__dirname, "assets", name)); } catch {}
      try { await supabase.storage.from("assets").remove([name]); } catch {}
    }
    const { data, error } = await supabase.from("clients")
      .update({ reference_image_path: null }).eq("id", req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/clients/:id", async (req, res) => {
  const { error } = await supabase.from("clients").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ====================================================================
//  CONTENT CALENDAR
// ====================================================================
// This is omni_flow's OWN operational table (local Supabase) — the entire
// pipeline (RSS/topic-days/products-mode generation, the recovery sweep,
// promptForItem, the videos table foreign key, per-item reference_image)
// reads and writes it directly. It must stay the source of truth for this
// dashboard's Calendar tab; proxying it out to the scheduler app's separate
// Supabase table caused generated items to never show up here (they were
// written to this table but the tab was reading a different one).
app.get("/api/clients/:id/calendar", async (req, res) => {
  const { data, error } = await supabase.from("calendar_items")
    .select("*").eq("client_id", req.params.id).order("scheduled_date");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Product-mode: upload up to 7 product photos (appended to existing set).
app.post("/api/clients/:id/product-images", upload.array("images", 7), async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("id,product_images").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    const existing = Array.isArray(client.product_images) ? client.product_images : [];
    const added = [];
    for (const f of (req.files || [])) {
      const name = saveAsset(f, `product_${req.params.id}`);
      await assetsSync.uploadAsset(path.join(__dirname, "assets", name), name);
      added.push(name);
    }
    const product_images = [...existing, ...added].slice(0, 7);
    const { data, error } = await supabase.from("clients").update({ product_images }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================================================================
//  PRODUCT MODE — no content calendar at all: 7 fixed daily slots (one
//  week), each using client.fixed_prompt (skip ChatGPT) and one of the
//  client's uploaded product images. Call this once to seed the week;
//  call again next week to seed the next one (it only adds days that
//  don't already have an item).
// ====================================================================
app.post("/api/clients/:id/products/populate-week", async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    if (!client.fixed_prompt || !String(client.fixed_prompt).trim()) {
      return res.status(400).json({ error: "Set a Fixed Prompt for this client first (Config → Fixed Prompt)." });
    }
    const images = Array.isArray(client.product_images) ? client.product_images : [];

    const startDate = req.body?.startDate ? new Date(req.body.startDate) : new Date();
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const img = images.length ? images[i % images.length] : null;
      const label = img ? path.parse(img).name.replace(/[-_]+/g, " ") : `Product Day ${i + 1}`;
      rows.push({
        client_id: client.id, scheduled_date: dateStr, topic: label,
        reference_image: img, status: "planned"
      });
    }
    const targetDates = rows.map(r => r.scheduled_date);

    // Switching to products mode means this client's OLD calendar (regular
    // AI topics, RSS items, whatever) is no longer relevant — replace the
    // client's ENTIRE not-yet-produced calendar, not just these 7 dates.
    // Already-produced/in-progress items (done/generating/uploaded/composited)
    // are always kept, everywhere else in this app, and that rule applies here too.
    const { data: existing } = await supabase.from("calendar_items")
      .select("id,scheduled_date,status").eq("client_id", client.id);

    const produced = new Set((existing || []).filter(e => ["done", "generating", "uploaded", "composited"].includes(e.status)).map(e => e.scheduled_date));
    const toDeleteIds = (existing || []).filter(e => !["done", "generating", "uploaded", "composited"].includes(e.status)).map(e => e.id);
    if (toDeleteIds.length) {
      await supabase.from("calendar_items").delete().in("id", toDeleteIds);
    }

    const fresh = rows.filter(r => !produced.has(r.scheduled_date));
    if (!fresh.length) return res.json({ inserted: 0, message: "Every day this week already has a finished/in-progress video — nothing to replace." });
    const { data, error } = await supabase.from("calendar_items").insert(fresh).select();
    if (error) throw error;
    res.json({ inserted: data.length, items: data, skipped: rows.length - fresh.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate calendar — delegates the Groq call + storage to the scheduler.
// Generate calendar via ChatGPT and store it in omni_flow's OWN local
// calendar_items table (same reasoning as the GET above — this table is
// what the sweep/pipeline actually operate on).
app.post("/api/clients/:id/calendar/generate", async (req, res) => {
  try {
    const { days = 30, startDate } = req.body;
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });

    const items = await groqLib.generateCalendar({
      businessName: client.name,
      businessDetails: client.business_details, chatLink: client.chatgpt_link,
      days, startDate
    });

    // REPLACE: remove existing not-yet-produced items for this client so the new
    // calendar takes their place. Keep items already done/generating/uploaded so
    // we never wipe finished work or an in-progress job.
    await supabase.from("calendar_items")
      .delete()
      .eq("client_id", client.id)
      .in("status", ["planned", "prompt_ready", "error"]);

    const rows = items.map(it => ({ ...it, client_id: client.id, status: "planned" }));
    const { data, error } = await supabase.from("calendar_items").insert(rows).select();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a Flow prompt for one calendar item
app.post("/api/calendar/:itemId/prompt", async (req, res) => {
  try {
    const { data: item } = await supabase.from("calendar_items").select("*").eq("id", req.params.itemId).single();
    if (!item) return res.status(404).json({ error: "item not found" });
    const { data: client } = await supabase.from("clients").select("*").eq("id", item.client_id).single();

    const prompt = await promptForItem(client, item);

    const { data, error } = await supabase.from("calendar_items")
      .update({ prompt, status: "prompt_ready" }).eq("id", item.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================================================================
//  VIDEOS
// ====================================================================
app.get("/api/clients/:id/videos", async (req, res) => {
  const { data, error } = await supabase.from("videos")
    .select("*").eq("client_id", req.params.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * Kick off generation for a client.
 * body: { calendar_item_id?, prompt?, image?(optional via separate field) }
 * Uses the client's stored cookies. Image optional (multipart).
 */
app.post("/api/clients/:id/generate", upload.fields([{ name: "image", maxCount: 1 }]), async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    // Allow generation if EITHER cookies are configured OR a persistent login
    // profile exists for this client (profiles/<id>). Profile is preferred.
    const hasProfile = fs.existsSync(path.join(__dirname, "profiles", String(client.id)));
    if (!client.cookies && !hasProfile && process.env.DASHBOARD_ONLY !== "1") {
      return res.status(400).json({ error: "client has no login profile or cookies. Run: node login-once.js " + client.id });
    }

    // Make sure this client's assets (reference image, frame, outro) exist on
    // THIS machine's local assets/ folder — download any missing ones from
    // Supabase Storage. This is what lets you upload assets on the Render
    // dashboard and have them appear here on the local generator.
    if (process.env.DASHBOARD_ONLY !== "1") {
      await assetsSync.ensureLocalAssets(client, path.join(__dirname, "assets"));
    }

    let prompt = req.body.prompt;
    const calItemId = req.body.calendar_item_id || null;
    let topic = req.body.topic || "";

    if (!prompt && calItemId) {
      const { data: item } = await supabase.from("calendar_items").select("*").eq("id", calItemId).single();
      prompt = item?.prompt;
      topic = item?.topic || topic;
      if (!prompt) {
        prompt = await promptForItem(client, item);
        await supabase.from("calendar_items").update({ prompt, status: "prompt_ready" }).eq("id", calItemId);
      }
    }
    if (!prompt) return res.status(400).json({ error: "prompt or calendar_item_id required" });

    // write cookies to a temp file for the playwright script
    let cookiesPath = null;
    if (client.cookies) {
      cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
      fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));
    }

    let imagePath = null;
    if (req.files?.image?.[0]) {
      const orig = req.files.image[0];
      const ext = path.extname(orig.originalname).toLowerCase() || ".png";
      imagePath = orig.path + ext;
      fs.renameSync(orig.path, imagePath);
    } else if (client.reference_image_path) {
      // use the client's fixed reference image stored in assets/
      const ref = path.join(__dirname, "assets", client.reference_image_path);
      if (fs.existsSync(ref)) imagePath = ref;
    }

    const jobId = uuidv4();
    jobs.set(jobId, { logs: [], ws: null, clientId: client.id });

    // create the video DB row (pending)
    // DASHBOARD_ONLY (set on Render): never launch a browser here — datacenter
    // IPs get flagged by Flow. Instead, queue the job: create a calendar item
    // the local poller will pick up and generate on the real-IP machine.
    if (process.env.DASHBOARD_ONLY === "1") {
      const today = localToday();
      let queuedItemId = calItemId;
      if (!queuedItemId) {
        const { data: ci } = await supabase.from("calendar_items").insert({
          client_id: client.id, topic: topic || client.name, prompt,
          source: "manual", scheduled_date: today, status: "prompt_ready"
        }).select().single();
        queuedItemId = ci?.id;
      } else {
        // ensure it's pickable by the poller (planned/prompt_ready)
        await supabase.from("calendar_items").update({ status: "prompt_ready", prompt }).eq("id", queuedItemId);
      }
      // remove the premature video row + temp cookie file we created above
      try { fs.existsSync(cookiesPath) && fs.unlinkSync(cookiesPath); } catch {}
      return res.json({ queued: true, calendar_item_id: queuedItemId,
        message: "Queued for your local PC. Make sure poller.js is running there." });
    }

    // SERIALIZE: only one Flow browser session at a time. A persistent profile
    // can be opened by exactly one Chrome instance, so concurrent jobs (e.g. the
    // poller firing several due items at once) would collide with
    // "profile already in use". Tell the caller we're busy; it will retry later.
    if (generationBusy) {
      try { fs.existsSync(cookiesPath) && fs.unlinkSync(cookiesPath); } catch {}
      return res.status(409).json({ busy: true, error: "a generation is already running; try again shortly" });
    }
    generationBusy = true;   // claim the lock synchronously, before any await

    const { data: videoRow } = await supabase.from("videos").insert({
      client_id: client.id, calendar_item_id: calItemId, prompt,
      title: topic || client.name, status: "generating"
    }).select().single();

    res.json({ jobId, videoId: videoRow.id });

    if (calItemId) await supabase.from("calendar_items").update({ status: "generating", updated_at: new Date().toISOString() }).eq("id", calItemId);

    runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic });
  } catch (e) {
    generationBusy = false;   // release lock if we failed before the pipeline took over
    res.status(500).json({ error: e.message });
  }
});

// ====================================================================
//  PIPELINE: Flow generate → composite frame+outro → upload Drive/YouTube
// ====================================================================

// Derive a short human title from a prompt when no topic is set (manual prompts).
function deriveTitle(prompt) {
  const firstLine = String(prompt).split(/\n/).map(s => s.trim()).find(Boolean) || "video";
  // Strip a leading "PART 1 (0-10 sec) — " style marker so the fallback
  // title is just the actual short punchy title, never "PART 1 ...".
  const noPartPrefix = firstLine.replace(/^PART\s*\d+\s*\([^)]*\)\s*[-–—]\s*/i, "").trim();
  const clean = (noPartPrefix || firstLine).replace(/^\*+|\*+$/g, "").replace(/[#*_`]/g, "").trim();
  const words = clean.split(/\s+/).slice(0, 10).join(" ");
  return (words || "video").slice(0, 80);
}

// Generate ONE clip for a single prompt part. Resolves to the raw filename or null.
function generatePart({ jobId, partIndex, cookiesPath, profileDir, imagePath, imagePaths, prompt }) {
  return new Promise((resolve) => {
    const partJob = `${jobId}_p${partIndex}`;
    const scriptPath = path.join(__dirname, "uploads", `script_${partJob}.js`);
    fs.writeFileSync(scriptPath, buildScript({
      cookiesPath, profileDir,
      imagePaths: imagePaths || (imagePath ? [imagePath] : []),
      prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
      aspectRatio: "9:16", speed: "1x", duration: "10s", jobId: partJob
    }));

    const proc = spawn("node", [scriptPath], {
      cwd: __dirname,
      env: { ...process.env, NODE_ENV: "production", NODE_PATH: path.join(__dirname, "node_modules") }
    });
    let rawVideoFile = null;
    let policyHit = false;

    proc.stdout.on("data", (data) => {
      data.toString().split("\n").filter(l => l.trim()).forEach(line => {
        if (line.startsWith("__VIDEO__:")) { rawVideoFile = line.replace("__VIDEO__:", "").trim(); return; }
        if (/Policy violation|Ended: policy/i.test(line)) policyHit = true;
        const type =
          line.includes("❌") || line.toLowerCase().includes("failed") ? "error" :
          line.includes("✅") ? "success" :
          line.includes("→") || line.includes("Polling") ? "progress" : "info";
        sendLog(jobId, type, line.replace(/\r/g, ""));
      });
    });
    proc.stderr.on("data", (data) => {
      data.toString().split("\n").filter(l => l.trim()).forEach(line => {
        if (!line.includes("DeprecationWarning") && !line.includes("ExperimentalWarning"))
          sendLog(jobId, "warn", line);
      });
    });
    proc.on("close", () => {
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve({ file: rawVideoFile, policy: policyHit });
    });
  });
}

function runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic, onComplete }) {
  generationBusy = true;
  (async () => {
    sendLog(jobId, "info", `🧭 pipeline build: PER-PART-IMAGES v4 — file: ${__filename}`);
    const outDir = path.join(__dirname, "outputs");
    // Per-client persistent Chrome profile (logged in once via login-once.js).
    // If it exists, generation uses it (no cookie expiry). Else falls back to cookies.
    const candidateProfile = path.join(__dirname, "profiles", String(client.id));
    const profileDir = fs.existsSync(candidateProfile) ? candidateProfile : null;
    if (profileDir) sendLog(jobId, "info", "🔐 Using persistent login profile");
    prompt = groqLib.sanitizePrompt(prompt);   // safety net for manual prompts too
    const parts = groqLib.splitPromptParts(prompt);
    const videoTitle = (topic && topic.trim()) || deriveTitle(prompt);

    sendLog(jobId, "info", `🚀 Generating for ${client.name}`);
    sendLog(jobId, "info", `📋 ${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}`);

    try {
      // 1) Generate each part — with auto-retry on policy violation / failure.
      //    On a policy hit we regenerate a fresh, safer prompt and try again.
      const MAX_ATTEMPTS = 3;
      let rawFiles = [];
      let currentPrompt = prompt;
      let success = false;

      // ── RESUMABLE per-part cache ───────────────────────────────────────
      // Part clips and their images are keyed by the CALENDAR ITEM (stable
      // across runs) + a hash of that part's text. So if credits run out or the
      // power dies after part 1, the next crawl REUSES part 1's saved clip and
      // image and generates ONLY the missing part(s), then concatenates and
      // composites as normal. Changing the prompt changes the hash, which
      // correctly forces a fresh render.
      const stableKey = (videoRow && videoRow.calendar_item_id) || jobId;
      const partHash = (t) => crypto.createHash("sha1").update(String(t)).digest("hex").slice(0, 8);
      const partVideoPath = (i, t) => path.join(outDir, `part_${stableKey}_${i}_${partHash(t)}.mp4`);
      const partImgPath   = (i, t) => path.join(__dirname, "uploads", `partimg_${stableKey}_${i}_${partHash(t)}.png`);
      const bigEnough = (p) => { try { return fs.statSync(p).size > 10000; } catch { return false; } };

      // Make (or reuse) the ChatGPT image for ONE part — never re-buys an image
      // that was already produced for this exact part text.
      async function imageForPart(i, text) {
        const fp = partImgPath(i, text);
        if (bigEnough(fp)) { sendLog(jobId, "info", `♻️ Reusing saved image for part ${i + 1}`); return fp; }
        if (!process.env.CHATGPT_SERVER_URL) {
          sendLog(jobId, "warn", "CHATGPT_SERVER_URL not set — using client image");
          return null;
        }
        try {
          sendLog(jobId, "progress", `🖼️ Creating image for part ${i + 1}…`);
          // For clients with a fixed image-generation prompt configured, always
          // use that exact text instead of the text derived from this part's
          // scene — keeps product/reference imagery consistent across videos.
          const imgPromptText = (client.fixed_image_prompt && client.fixed_image_prompt.trim())
            ? client.fixed_image_prompt.trim()
            : text;
          const dataUrl = await groqLib.generateImage(imgPromptText, client.image_chat_link || "");
          let buf;
          if (dataUrl.startsWith("data:")) buf = Buffer.from(dataUrl.split(",")[1], "base64");
          else { const r = await fetch(dataUrl); buf = Buffer.from(await r.arrayBuffer()); }
          fs.writeFileSync(fp, buf);
          sendLog(jobId, "success", `✅ Image ready for part ${i + 1}`);
          return fp;
        } catch (e) {
          sendLog(jobId, "warn", `Part ${i + 1} image failed (${e.message}) — using client image`);
          return null;
        }
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
        const parts = groqLib.splitPromptParts(currentPrompt);
        if (parts.length > 1) sendLog(jobId, "info", `🧩 Split into ${parts.length} parts`);
        rawFiles = [];
        let failed = false, policy = false;

        for (let i = 0; i < parts.length; i++) {
          const keep = partVideoPath(i, parts[i]);
          // Produced by an earlier run (credits/power died) → reuse, don't re-render.
          if (bigEnough(keep)) {
            sendLog(jobId, "success", `♻️ Part ${i + 1}/${parts.length} already generated — reusing saved clip`);
            rawFiles.push(path.basename(keep));
            continue;
          }
          if (parts.length > 1) sendLog(jobId, "progress", `🎬 Generating part ${i + 1}/${parts.length}…`);
          // Image is created only for parts that still need rendering.
          const partImg = await imageForPart(i, parts[i]);
          // Paste BOTH the per-part image AND the client's reference image.
          const imgs = [...new Set([partImg, imagePath].filter(Boolean))];
          if (imgs.length) sendLog(jobId, "info", `🖼️ Part ${i + 1}: pasting ${imgs.length} image(s) into Flow`);
          const res = await generatePart({ jobId, partIndex: i, cookiesPath, profileDir, imagePaths: imgs, prompt: parts[i] });
          if (!res.file) { failed = true; policy = res.policy; break; }
          // Persist under the stable name so a later crawl can reuse it.
          try { fs.renameSync(path.join(outDir, res.file), keep); rawFiles.push(path.basename(keep)); }
          catch { rawFiles.push(res.file); }
        }

        if (!failed) { success = true; break; }

        // Failed this attempt. Retry with a freshly generated, safer prompt.
        if (attempt < MAX_ATTEMPTS) {
          sendLog(jobId, "warn", policy
            ? `⚠️ Policy violation — regenerating a safer prompt (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
            : `⚠️ Generation failed — retrying with a fresh prompt (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
          try {
            const fresh = await groqLib.generatePrompt({
              businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
              topic: videoTitle, styleKey: client.prompt_style, styleInstruction: client.prompt_custom,
              promptSample: client.prompt_sample, parts: partsForClient(client)
            });
            currentPrompt = groqLib.sanitizePrompt(fresh);
            sendLog(jobId, "info", `📋 New prompt: ${currentPrompt.slice(0, 90)}…`);
          } catch (e) {
            sendLog(jobId, "error", `Could not regenerate prompt: ${e.message}`);
            break;
          }
        }
      }

      if (!success) {
        sendLog(jobId, "error", `❌ Failed after ${MAX_ATTEMPTS} attempts`);
        try { fs.unlinkSync(cookiesPath); } catch {}
        await supabase.from("videos").update({ status: "error", error: "failed after retries (policy/other)" }).eq("id", videoRow.id);
        generationBusy = false; if (onComplete) onComplete(false); return;
      }
      try { fs.unlinkSync(cookiesPath); } catch {}

      // 2) Concatenate parts (if more than one) into a single base video
      let rawVideoFile;
      if (rawFiles.length > 1) {
        sendLog(jobId, "progress", "🔗 Joining parts…");
        const joined = await videoLib.concatParts(
          rawFiles.map(f => path.join(outDir, f)), outDir, `flow_${jobId}`
        );
        rawVideoFile = path.basename(joined);
        sendLog(jobId, "success", `✅ Joined ${rawFiles.length} parts: ${rawVideoFile}`);
      } else {
        rawVideoFile = rawFiles[0];
      }

      await supabase.from("videos").update({ raw_file: rawVideoFile, title: videoTitle }).eq("id", videoRow.id);
      sendLog(jobId, "success", `🎬 Raw video ready: ${rawVideoFile}`);

      // 3) Composite frame + outro on the (possibly joined) video
      let finalName = rawVideoFile;
      try {
        const framePng = client.frame_path ? path.join(__dirname, "assets", client.frame_path) : null;
        const outroClip = client.outro_path ? path.join(__dirname, "assets", client.outro_path) : null;
        if (framePng || outroClip) {
          sendLog(jobId, "progress", "🎨 Compositing (frame · outro)…");
          const finalPath = await videoLib.compose({
            videoIn: path.join(outDir, rawVideoFile),
            framePng, outroClip, outDir,
            baseName: path.parse(rawVideoFile).name
          });
          finalName = path.basename(finalPath);
          sendLog(jobId, "success", `✅ Composited: ${finalName}`);
        } else {
          sendLog(jobId, "info", "No frame/outro configured — skipping compositing");
        }
      } catch (e) {
        sendLog(jobId, "error", `Compositing failed: ${e.message}`);
      }

      await supabase.from("videos").update({ final_file: finalName, status: "composited" }).eq("id", videoRow.id);
      sendLog(jobId, "video", finalName);

      const finalFull = path.join(outDir, finalName);

      // 4) Drive upload — filename = prompt TITLE (not client name)
      if (client.upload_to_drive) {
        // GLOBAL Drive: one connection for the whole dashboard, stored in settings.
        const driveTokens = await getSetting("drive_tokens");
        if (!driveTokens || !driveTokens.refresh_token) {
          sendLog(jobId, "warn", "Drive upload skipped — global Drive not connected (Connect Drive in the dashboard)");
        } else {
          try {
            sendLog(jobId, "progress", "☁️  Uploading to Google Drive…");
            const link = await googleLib.uploadToDrive({
              tokens: driveTokens, filePath: finalFull,
              name: `${videoTitle}.mp4`,
              folderId: client.drive_folder_id,   // per-client target folder in the shared Drive
              onTokens: (fresh) => { setSetting("drive_tokens", fresh).catch(() => {}); }
            });
            await supabase.from("videos").update({ drive_url: link }).eq("id", videoRow.id);
            sendLog(jobId, "success", `✅ Drive: ${link}`);
          } catch (e) {
            if (e.code === "REAUTH") {
              await setSetting("drive_tokens", null);   // dead token → force global reconnect
              sendLog(jobId, "error", "Drive upload failed — global Drive disconnected (reconnect it in the dashboard)");
            } else {
              sendLog(jobId, "error", `Drive upload failed: ${e.message}`);
            }
          }
        }
      }

      // 5) YouTube upload — title = prompt TITLE
      if (client.upload_to_youtube && client.youtube_tokens) {
        try {
          sendLog(jobId, "progress", "📺 Preparing YouTube metadata…");
          const meta = await groqLib.generateYouTubeMeta({
            businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
            topic: videoTitle, prompt, defaultTags: client.yt_tags || client.yt_default_tags
          });
          const hashtags = (client.yt_hashtags
            ? client.yt_hashtags.split(",").map(h => h.trim()).filter(Boolean).map(h => h.startsWith("#") ? h : "#" + h).join(" ")
            : (meta.hashtags || ""));
          const title = applyTpl(client.yt_title_tpl, { title: videoTitle, topic: videoTitle, client: client.name, hashtags }) || videoTitle;
          const descBase = applyTpl(client.yt_desc_tpl, { description: meta.description, client: client.name, hashtags })
            || meta.description || "";
          const description = `${descBase}\n\n${hashtags}`.trim();
          const tagSet = [
            ...String(client.yt_tags || "").split(","),
            ...String(meta.tags || "").split(",")
          ].map(t => t.trim()).filter(Boolean);
          const tags = [...new Set(tagSet)];

          sendLog(jobId, "progress", "📺 Uploading to YouTube…");
          const yt = await googleLib.uploadToYouTube({
            tokens: client.youtube_tokens, filePath: finalFull,
            title, description, tags,
            onLog: (m) => sendLog(jobId, "info", m)
          });
          await supabase.from("videos").update({
            youtube_url: yt, title, description, hashtags, tags: tags.join(", ")
          }).eq("id", videoRow.id);
          sendLog(jobId, "success", `✅ YouTube: ${yt}`);
        } catch (e) {
          const msg = /invalid_grant/i.test(e.message)
            ? "YouTube token expired/revoked — reconnect YouTube for this client in Config"
            : `YouTube upload failed: ${e.message}`;
          sendLog(jobId, "error", msg);
        }
      } else if (client.upload_to_youtube) {
        sendLog(jobId, "warn", "YouTube upload skipped — channel not connected (Configure YouTube)");
      }

      await supabase.from("videos").update({ status: "uploaded" }).eq("id", videoRow.id);
      if (videoRow.calendar_item_id)
        await supabase.from("calendar_items").update({ status: "done" }).eq("id", videoRow.calendar_item_id);
      sendLog(jobId, "success", "🏁 Done");
      generationBusy = false;
      if (onComplete) onComplete(true);
    } catch (e) {
      sendLog(jobId, "error", `Pipeline error: ${e.message}`);
      try { fs.unlinkSync(cookiesPath); } catch {}
      await supabase.from("videos").update({ status: "error", error: e.message }).eq("id", videoRow.id);
      generationBusy = false;
      if (onComplete) onComplete(false);
    }
  })();
}

// ====================================================================
//  RSS — fetch feeds, ingest as items, daily auto-generate
// ====================================================================

// Reusable: run one full generation and resolve when the pipeline finishes.
function generateOne({ client, prompt, topic, calItemId, link, referenceImage }) {
  let cookiesPath = null;
  if (client.cookies) {
    cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
    fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));
  }

  const jobId = uuidv4();
  jobs.set(jobId, { logs: [], ws: null, clientId: client.id });

  if (calItemId) activeItems.add(calItemId);
  return (async () => {
    // sync this client's assets to local disk first (no-op if already present)
    await assetsSync.ensureLocalAssets(client, path.join(__dirname, "assets"));

    // Per-item reference image (product mode: one product photo per day)
    // takes priority over the client's single default reference image.
    let imagePath = null;
    const preferredRef = referenceImage || client.reference_image_path;
    if (preferredRef) {
      const ref = path.join(__dirname, "assets", preferredRef);
      if (fs.existsSync(ref)) imagePath = ref;
    }

    const { data: videoRow } = await supabase.from("videos").insert({
      client_id: client.id, calendar_item_id: calItemId || null, prompt,
      title: topic || client.name, status: "generating"
    }).select().single();
    return new Promise(resolve => {
      runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic,
        onComplete: (ok) => { if (calItemId) activeItems.delete(calItemId); resolve(ok); } });
    });
  })().catch(e => { if (calItemId) activeItems.delete(calItemId); throw e; });
}

function waitUntilFree(timeoutMs = 20 * 60 * 1000) {
  return new Promise(resolve => {
    if (!generationBusy) return resolve();
    const start = Date.now();
    const t = setInterval(() => {
      if (!generationBusy || Date.now() - start > timeoutMs) { clearInterval(t); resolve(); }
    }, 3001);
  });
}

// Resolve a client's effective feed list: chosen categories + any custom URLs.
function clientFeeds(client) {
  const cats = String(client.rss_categories || "").split(",").map(s => s.trim()).filter(Boolean);
  const catUrls = feedsLib.feedsForCategories(cats);
  const custom = rssLib.feedUrls(client.rss_feeds);
  return [...new Set([...catUrls, ...custom])].join("\n");
}

// Manual: pull feeds and ingest any new articles as planned items (no auto-generate)
app.post("/api/clients/:id/rss/fetch", async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    const feeds = clientFeeds(client);
    if (!feeds) return res.status(400).json({ error: "no RSS categories or feeds configured" });

    const items = await rssLib.fetchFeeds(feeds, 20);

    // REPLACE: clear old not-yet-produced RSS items so a fresh fetch takes their
    // place (keeps done/generating/uploaded ones intact).
    await supabase.from("calendar_items")
      .delete()
      .eq("client_id", client.id).eq("source", "rss")
      .in("status", ["planned", "prompt_ready", "error"]);

    // Dedup only against links we've already PRODUCED (done/uploaded), so the
    // same article isn't re-made — but articles that were merely planned before
    // can come back in a fresh fetch.
    const { data: existing } = await supabase.from("calendar_items")
      .select("link").eq("client_id", client.id).not("link", "is", null)
      .in("status", ["done", "uploaded", "generating"]);
    const have = new Set((existing || []).map(e => e.link));
    const fresh = items.filter(i => !have.has(i.link)).slice(0, client.rss_daily_limit || 10);

    let inserted = [];
    if (fresh.length) {
      const rows = fresh.map(i => ({
        client_id: client.id, topic: i.title, hook: i.summary, link: i.link,
        source: "rss", status: "planned",
        scheduled_date: (i.isoDate ? i.isoDate.slice(0, 10) : new Date().toISOString().slice(0, 10))
      }));
      const { data } = await supabase.from("calendar_items").insert(rows).select();
      inserted = data || [];
    }
    res.json({ fetched: items.length, new: inserted.length, items: inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A client can generate if it has a persistent login profile OR legacy cookies.
function clientHasSession(client) {
  const hasProfile = fs.existsSync(path.join(__dirname, "profiles", String(client.id)));
  return hasProfile || !!client.cookies;
}

// Pick ONE fresh, unique news item PER configured category (plus one from any
// custom feeds), skipping anything this client has ever used before. Returns
// [{ title, summary, link, isoDate, _category }].
async function pickDailyNews(client) {
  // Every link this client has ever queued/produced — so news never repeats.
  const { data: existing } = await supabase.from("calendar_items")
    .select("link").eq("client_id", client.id).not("link", "is", null);
  const used = new Set((existing || []).map(e => e.link));

  const cats = String(client.rss_categories || "").split(",").map(s => s.trim()).filter(Boolean);
  const chosen = [];
  const pickedLinks = new Set();

  const takeOne = async (feedList, categoryLabel) => {
    const feedsStr = Array.isArray(feedList) ? feedList.join("\n") : String(feedList || "");
    if (!feedsStr.trim()) return;
    let items = [];
    try { items = await rssLib.fetchFeeds(feedsStr, 15); } catch (e) { console.log(`  feed error [${categoryLabel}]: ${e.message}`); }
    const pick = items.find(i => i.link && !used.has(i.link) && !pickedLinks.has(i.link));
    if (pick) { pick._category = categoryLabel; chosen.push(pick); pickedLinks.add(pick.link); }
  };

  // One unique article per category.
  for (const cat of cats) {
    await takeOne(feedsLib.feedsForCategories([cat]), cat);
  }
  // One from custom feeds, if any.
  const custom = rssLib.feedUrls(client.rss_feeds);
  if (custom && custom.length) await takeOne(custom, "custom");

  // Optional per-day cap (safety). 0/blank = one per category (all).
  const cap = client.rss_daily_limit && client.rss_daily_limit > 0 ? client.rss_daily_limit : chosen.length;
  return chosen.slice(0, cap);
}

// Generate ONE news video end-to-end (prompt → video → YouTube upload w/ meta).
async function generateNewsItem(client, it, dateStr) {
  let ci = null;
  try {
    // Same lifecycle as every other calendar item: starts "planned" (queued,
    // nothing running yet) — NOT "generating", since we haven't even written
    // the prompt yet. "generating" is reserved for the moment the Flow
    // pipeline actually starts, matching the manual "Generate" button's
    // convention (see calendar_items status update right before runPipeline).
    const ins = await supabase.from("calendar_items").insert({
      client_id: client.id, topic: it.title, hook: it.summary, link: it.link,
      source: "rss", scheduled_date: dateStr, status: "planned",
      meta: { skipThemeDistillation: it._skipThemeDistillation === true }
    }).select().single();
    if (ins.error || !ins.data) {
      throw new Error(`calendar_items insert failed: ${ins.error?.message || "no row returned"}`);
    }
    ci = ins.data;

    // Same fixed-prompt bypass as promptForItem(): if this client is set to
    // always use one exact prompt, skip ChatGPT entirely — for RSS/topic-day
    // items too, not just the regular AI calendar. (The fetched article
    // still drove which day/whether this ran; only the PROMPT TEXT is fixed.)
    let prompt;
    if (client.fixed_prompt_mode && client.fixed_prompt && String(client.fixed_prompt).trim()) {
      prompt = String(client.fixed_prompt).trim();
    } else {
      prompt = await groqLib.generateNewsPrompt({
        businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
        title: it.title, summary: it.summary, parts: partsForClient(client),
        voiceoverEnabled: client.voiceover_enabled !== false,
        voiceoverLanguage: client.voiceover_language || "Hindi/Hinglish",
        skipThemeDistillation: it._skipThemeDistillation === true
      });
    }
    await supabase.from("calendar_items").update({ prompt, status: "prompt_ready" }).eq("id", ci.id);

    if (process.env.DASHBOARD_ONLY === "1") {
      // Dashboard-only instance stops here — item sits as "prompt_ready",
      // same queued state a manually-typed calendar item would be in,
      // waiting for the LOCAL worker's sweep to pick it up and generate.
      return;
    }

    await waitUntilFree();
    // Flip to "generating" right as the actual Flow pipeline takes over —
    // same moment/convention the manual "Generate" button uses.
    await supabase.from("calendar_items").update({ status: "generating", updated_at: new Date().toISOString() }).eq("id", ci.id);
    // generateOne → runPipeline handles concat/composite AND the YouTube upload
    // with ChatGPT-generated title/description/tags/hashtags.
    await generateOne({ client, prompt, topic: it.title, calItemId: ci.id, link: it.link });
  } catch (articleErr) {
    console.log(`  ✗ RSS article failed (${client.name}): ${articleErr.message}`);
    if (ci?.id) {
      await supabase.from("calendar_items").update({ status: "error", error: articleErr.message }).eq("id", ci.id);
    } else {
      await supabase.from("calendar_items").insert({
        client_id: client.id, topic: it.title, link: it.link, source: "rss",
        scheduled_date: dateStr, status: "error", error: articleErr.message
      });
    }
  }
}

// Manual trigger: generate today's per-category news for ONE client right now
// (ignores the once-a-day guard). Handy for testing without waiting.
app.post("/api/clients/:id/rss/run-now", async (req, res) => {
  const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
  if (!client) return res.status(404).json({ error: "client not found" });
  // On a DASHBOARD_ONLY instance (e.g. Render) this only fetches articles and
  // writes prompts ("prompt_ready"); actual Flow generation happens on your
  // local worker instance, which has its own session — no session needed here.
  if (process.env.DASHBOARD_ONLY !== "1" && !clientHasSession(client)) {
    return res.status(400).json({ error: "no login profile — run: node login-once.js " + client.id });
  }
  if (!clientFeeds(client)) return res.status(400).json({ error: "no RSS categories or feeds configured" });
  res.json({
    ok: true,
    message: process.env.DASHBOARD_ONLY === "1"
      ? "Fetching articles and queuing prompts — your local worker will generate the videos next time it syncs."
      : "RSS run started — watch the server logs and the client's calendar."
  });
  (async () => {
    const today = localToday();
    try {
      const fresh = await pickDailyNews(client);
      console.log(`📰 [run-now] RSS [${client.name}] ${fresh.length} unique article(s)`);
      for (const it of fresh) await generateNewsItem(client, it, today);
      await supabase.from("clients").update({ last_rss_run: today }).eq("id", client.id);
    } catch (e) { console.log(`[run-now] error (${client.name}): ${e.message}`); }
  })();
});

// Daily scheduler: for each RSS client, pick unique per-category news & auto-generate
async function runRssScheduler() {
  const today = localToday();
  let clients;
  try {
    const { data } = await supabase.from("clients").select("*").eq("mode", "rss");
    clients = data || [];
  } catch { return; }

  for (const client of clients) {
    if (client.last_rss_run === today) continue;        // already ran today
    const feeds = clientFeeds(client);
    // On DASHBOARD_ONLY (Render): still fetch + queue prompts, just never
    // launches a browser — generateNewsItem() already stops at "prompt_ready"
    // there. Only bail on missing session for the LOCAL worker instance.
    const needsSession = process.env.DASHBOARD_ONLY !== "1" && !clientHasSession(client);
    if (needsSession || !feeds) {
      if (needsSession) console.log(`⏭️  RSS [${client.name}] skipped — no login profile (run: node login-once.js ${client.id})`);
      continue;
    }
    try {
      const fresh = await pickDailyNews(client);
      console.log(`📰 RSS [${client.name}] ${fresh.length} unique article(s) across categories`);
      for (const it of fresh) await generateNewsItem(client, it, today);
      await supabase.from("clients").update({ last_rss_run: today }).eq("id", client.id);
    } catch (e) {
      console.log(`RSS scheduler error for ${client.name}:`, e.message);
    }
  }
}

// check hourly; also once ~30s after startup
setInterval(() => runRssScheduler().catch(e => console.log("RSS scheduler:", e.message)), 60 * 60 * 1000);
setTimeout(() => runRssScheduler().catch(() => {}), 30 * 1000);

// ====================================================================
//  TOPIC-DAYS — day-fixed monthly topics (independent of RSS categories
//  and independent of `mode`). Config: client.topic_days = [{day:"Mon",
//  topic:"AI news"}, ...]. On a matching weekday, fetch that topic's
//  LATEST article, distill+generate via the same safe pipeline as RSS,
//  once per client per day.
// ====================================================================
const WEEKDAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Resolve ONE topic-day entry to a fresh article, whichever type it is:
//  - { type:"category", category:"technology" } → pick a fresh article from
//    that curated category's feeds (same feeds as the RSS mode uses), skipping
//    any link this client has already produced/queued.
//  - { type:"topic", topic:"..." } (or legacy {topic} with no type) → Google
//    News search for that exact free-text topic (fetchTopicArticle).
// Returns { title, summary, link, isoDate, _label } or null.
async function resolveDayEntryArticle(client, entry) {
  if (entry.type === "category" && entry.category) {
    const feeds = feedsLib.feedsForCategories([entry.category]);
    console.log(`[topic-day] category "${entry.category}" → ${feeds.length} feed(s): ${feeds.join(", ") || "(none — unknown category key?)"}`);
    if (!feeds.length) return null;
    const { data: existing } = await supabase.from("calendar_items")
      .select("link").eq("client_id", client.id).not("link", "is", null);
    const used = new Set((existing || []).map(e => e.link));
    let items = [];
    try { items = await rssLib.fetchFeeds(feeds.join("\n"), 15); }
    catch (e) { console.log(`[topic-day] fetchFeeds threw: ${e.message}`); }
    console.log(`[topic-day] fetched ${items.length} item(s), ${used.size} already used by this client`);
    const pick = items.find(i => i.link && !used.has(i.link));
    if (!pick) { console.log(`[topic-day] no unused article found (all ${items.length} already used, or feeds returned 0)`); return null; }
    const label = feedsLib.CATEGORIES[entry.category]?.label || entry.category;
    return { title: pick.title, summary: pick.summary, link: pick.link, isoDate: pick.isoDate, _label: label };
  }
  const topic = entry.topic || "";
  if (!topic.trim()) return null;
  console.log(`[topic-day] free-text topic search: "${topic}"`);
  const article = await rssLib.fetchTopicArticle(topic);
  if (!article) console.log(`[topic-day] Google News search returned nothing for "${topic}"`);
  return article ? { ...article, _label: topic } : null;
}

// Topic-days represent "exactly ONE plan for this weekday" (unlike regular
// RSS mode, which intentionally makes several items/day). So when a
// topic-day fires, it should REPLACE whatever calendar item this client
// already has for today (a generic AI-calendar item, a leftover from a
// previous run, etc.) rather than sit alongside it as a duplicate — but
// only if today's existing item isn't already produced/in-progress.
// Returns true if it's safe to proceed with generateNewsItem, false if
// today's slot is already finished/running (so we skip, not duplicate).
async function overrideTodayForTopicDay(client, today) {
  const { data: existing } = await supabase.from("calendar_items")
    .select("id,status").eq("client_id", client.id).eq("scheduled_date", today);
  if (!existing || !existing.length) return true;

  const stillSafe = existing.every(e => !["done", "generating", "uploaded", "composited"].includes(e.status));
  if (!stillSafe) return false; // already produced/running today — don't touch or duplicate

  await supabase.from("calendar_items").delete().in("id", existing.map(e => e.id));
  return true;
}

async function runTopicDaysScheduler() {
  const today = localToday();
  const todayName = WEEKDAY_NAMES[new Date().getDay()];
  let clients;
  try {
    const { data } = await supabase.from("clients").select("*").not("topic_days", "is", null);
    clients = (data || []).filter(c => Array.isArray(c.topic_days) && c.topic_days.length);
  } catch { return; }

  for (const client of clients) {
    if (client.last_topic_run === today) continue; // already ran today
    const entry = client.topic_days.find(e => e && e.day === todayName && (String(e.topic || "").trim() || (e.type === "category" && e.category)));
    if (!entry) continue;
    // On a DASHBOARD_ONLY instance (e.g. Render) this only needs to fetch the
    // article + write the prompt (status -> "prompt_ready"); the actual Flow
    // generation happens on your LOCAL worker instance, which has its own
    // login session and picks up "prompt_ready" items via its own sweep.
    if (process.env.DASHBOARD_ONLY !== "1" && !clientHasSession(client)) {
      console.log(`⏭️  Topic-day [${client.name}] skipped — no login profile`); continue;
    }

    try {
      const article = await resolveDayEntryArticle(client, entry);
      if (!article) { console.log(`📌 Topic-day [${client.name}]: no article found today`); continue; }

      // Dedup: skip if we already made a video from this exact link.
      const { data: existing } = await supabase.from("calendar_items")
        .select("id").eq("client_id", client.id).eq("link", article.link).limit(1);
      if (existing && existing.length) { console.log(`📌 Topic-day [${client.name}] "${article._label}": already produced this article`); }
      else {
        const canProceed = await overrideTodayForTopicDay(client, today);
        if (!canProceed) {
          console.log(`📌 Topic-day [${client.name}]: today's slot is already produced/running — skipping, not duplicating`);
        } else {
          console.log(`📌 Topic-day [${client.name}] "${article._label}": ${article.title}`);
          // The day's label (topic OR category) is already an evergreen,
          // brand-chosen concept, so skip the news-headline distillation pass,
          // but still run through generatePrompt's full safety/policy rules.
          await generateNewsItem(
            client,
            { title: article._label, summary: article.summary, link: article.link, _skipThemeDistillation: true },
            today
          );
        }
      }
      await supabase.from("clients").update({ last_topic_run: today }).eq("id", client.id);
    } catch (e) {
      console.log(`Topic-day scheduler error for ${client.name}:`, e.message);
    }
  }
}

setInterval(() => runTopicDaysScheduler().catch(e => console.log("Topic-day scheduler:", e.message)), 60 * 60 * 1000);
setTimeout(() => runTopicDaysScheduler().catch(() => {}), 45 * 1000);

// Fast test — just fetch the article, don't generate a video. No login
// session needed. Good for quickly checking a topic/category actually
// returns something before wiring up a full day.
app.post("/api/clients/:id/topic-days/test-fetch", async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    let entry = null;
    if (req.body && req.body.category) entry = { type: "category", category: req.body.category };
    else if (req.body && req.body.topic) entry = { type: "topic", topic: req.body.topic };
    else entry = (client.topic_days || [])[0] || null;
    if (!entry || (!entry.topic && !entry.category)) return res.status(400).json({ error: "no topic or category configured/provided" });

    const article = await resolveDayEntryArticle(client, entry);
    if (!article) return res.json({ found: false });
    res.json({ found: true, article });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger for testing one client's topic-day right now (ignores the
// once-a-day guard and the weekday check). Accepts either:
//   { topic: "AI news" }                          — free-text topic
//   { category: "technology" }                     — curated category
//   {} (no body)                                    — uses the client's first
//                                                      configured topic_days entry
app.post("/api/clients/:id/topic-days/run-now", async (req, res) => {
  const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
  if (!client) return res.status(404).json({ error: "client not found" });

  let entry = null;
  if (req.body && req.body.category) entry = { type: "category", category: req.body.category };
  else if (req.body && req.body.topic) entry = { type: "topic", topic: req.body.topic };
  else entry = (client.topic_days || [])[0] || null;
  if (!entry || (!entry.topic && !entry.category)) return res.status(400).json({ error: "no topic or category configured/provided" });
  // Same DASHBOARD_ONLY exception as the scheduler: on a dashboard-only
  // instance (e.g. Render) this just queues the prompt for your local
  // worker to pick up — no browser session needed here.
  if (process.env.DASHBOARD_ONLY !== "1" && !clientHasSession(client)) {
    return res.status(400).json({ error: "no login profile — run: node login-once.js " + client.id });
  }

  const label = entry.type === "category" ? (feedsLib.CATEGORIES[entry.category]?.label || entry.category) : entry.topic;
  res.json({
    ok: true,
    message: process.env.DASHBOARD_ONLY === "1"
      ? `Fetching "${label}" and queuing the prompt — your local worker will generate the video next time it syncs.`
      : `Topic-day test run started for "${label}" — watch server logs / the client's calendar.`
  });
  (async () => {
    const today = localToday();
    console.log(`[run-now topic-day] starting for ${client.name} — ${label}`);
    try {
      const article = await resolveDayEntryArticle(client, entry);
      if (!article) return console.log(`[run-now topic-day] no article found for "${label}"`);
      console.log(`[run-now topic-day] found article: ${article.title} (${article.link})`);
      const canProceed = await overrideTodayForTopicDay(client, today);
      if (!canProceed) return console.log(`[run-now topic-day] today's slot is already produced/running for ${client.name} — skipping, not duplicating`);
      await generateNewsItem(client, { title: article._label, summary: article.summary, link: article.link, _skipThemeDistillation: true }, today);
      console.log(`[run-now topic-day] generateNewsItem finished for ${client.name}`);
    } catch (e) { console.log(`[run-now topic-day] error (${client.name}):`, e.message); }
  })();
});

// ====================================================================
//  PROMPT RESOLUTION for a calendar item
//   • user_prompt present (Excel upload) → enhancePrompt (keep wording, reformat+split)
//   • source "rss"                       → generateNewsPrompt (theme-safe, split)
//   • otherwise                          → generatePrompt (house calendar format)
// ====================================================================
// Number of 10s parts for a client: video_seconds (10/20/30 -> 1/2/3),
// falling back to the legacy split_parts boolean (true=2, false=1).
function partsForClient(client) {
  const sec = Number(client && client.video_seconds);
  if (sec === 10 || sec === 20 || sec === 30) return sec / 10;
  if (client && client.split_parts === false) return 1;   // explicitly single
  return 2;   // default = 20s (2 parts)
}

async function promptForItem(client, item) {
  // 1) Client configured to ALWAYS use one fixed prompt — never calls ChatGPT
  //    for the video prompt at all. Also applies automatically in "products"
  //    mode, since that mode is defined as "one fixed prompt for every day"
  //    — no need to separately toggle fixed_prompt_mode too.
  const useFixedPrompt = (client.fixed_prompt_mode || client.mode === "products")
    && client.fixed_prompt && String(client.fixed_prompt).trim();
  if (useFixedPrompt) {
    return String(client.fixed_prompt).trim();
  }

  const voiceoverEnabled = client.voiceover_enabled !== false; // default true
  const voiceoverLanguage = client.voiceover_language || "Hindi/Hinglish";

  if (item.user_prompt && String(item.user_prompt).trim()) {
    return groqLib.enhancePrompt({
      userPrompt: item.user_prompt,
      businessName: client.name, businessDetails: client.business_details,
      parts: partsForClient(client), chatLink: client.chatgpt_link,
      voiceoverEnabled, voiceoverLanguage
    });
  }
  if (item.source === "rss") {
    return groqLib.generateNewsPrompt({
      businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
      title: item.topic, summary: item.hook, parts: partsForClient(client),
      voiceoverEnabled, voiceoverLanguage,
      skipThemeDistillation: item.meta?.skipThemeDistillation === true
    });
  }
  return groqLib.generatePrompt({
    businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
    topic: item.topic, hook: item.hook,
    styleKey: client.prompt_style, styleInstruction: client.prompt_custom,
    promptSample: client.prompt_sample, parts: partsForClient(client),
    voiceoverEnabled, voiceoverLanguage
  });
}

// ====================================================================
//  EXCEL CALENDAR IMPORT (per client)
//  Upload an .xlsx whose rows already contain the PROMPT you wrote. It REPLACES
//  the client's current calendar (keeps items already done/generating/uploaded).
//  At generation time each row's prompt is sent to ChatGPT to be ENHANCED +
//  SPLIT (not rewritten), and per-part images are generated.
//
//  Accepted columns (header row, case-insensitive; extra columns ignored):
//    prompt   (required) — the full prompt you want used
//    date     (optional) — YYYY-MM-DD; blank = auto sequential from today
//    topic    (optional) — short label / title
//    hook     (optional) — one-line angle
// ====================================================================
app.post("/api/clients/:id/calendar/import-xlsx", upload.single("file"), async (req, res) => {
  try {
    const { data: client } = await supabase.from("clients").select("id,name").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });
    if (!req.file) return res.status(400).json({ error: "no file uploaded (field name must be 'file')" });

    let XLSX;
    try { XLSX = require("xlsx"); }
    catch { return res.status(500).json({ error: "The 'xlsx' package isn't installed. Run: npm install xlsx" }); }

    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
    try { fs.unlinkSync(req.file.path); } catch {}

    // Tolerant header mapping (case/spacing-insensitive).
    const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
    const pick = (row, names) => {
      for (const key of Object.keys(row)) {
        if (names.includes(norm(key))) return row[key];
      }
      return "";
    };

    const today = new Date();
    const rows = [];
    let seq = 0;
    for (const r of raw) {
      const promptText = String(pick(r, ["prompt", "videoprompt", "script"]) || "").trim();
      if (!promptText) continue;   // skip rows without a prompt
      const topic = String(pick(r, ["topic", "title", "idea"]) || "").trim();
      const hook = String(pick(r, ["hook", "angle"]) || "").trim();
      let dateStr = String(pick(r, ["date", "scheduleddate", "day"]) || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const d = new Date(today); d.setDate(today.getDate() + seq);
        dateStr = d.toISOString().slice(0, 10);
      }
      rows.push({
        client_id: client.id,
        topic: topic || `Video ${seq + 1}`,
        hook,
        user_prompt: promptText,
        prompt: null,
        source: "excel",
        scheduled_date: dateStr,
        status: "planned"
      });
      seq++;
    }

    if (!rows.length) return res.status(400).json({ error: "No rows with a 'prompt' column were found in the sheet." });

    // Override current calendar: drop items not yet produced; keep done/generating/uploaded.
    await supabase.from("calendar_items").delete()
      .eq("client_id", client.id).in("status", ["planned", "prompt_ready", "error"]);
    const { data, error } = await supabase.from("calendar_items").insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, imported: data.length, message: `Imported ${data.length} calendar item(s) with your prompts.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================================================================
//  AFTERNOON RETRY (second daily pass ~3 PM)
//  Finds today's calendar items whose video did NOT generate (status "error",
//  or "generating" that got stuck) and re-runs them. Runs once per day when the
//  local hour is >= RETRY_HOUR. Also exposed manually for testing.
// ====================================================================
const RETRY_HOUR = parseInt(process.env.RETRY_HOUR || "15", 10);   // 15 = 3 PM local
let lastRetryDate = null;

// ── RECOVERY SWEEP ─────────────────────────────────────────────────────
// Crawls ALL clients for TODAY's calendar items and resumes anything that
// didn't finish. Survives power cuts: when the PC boots and this process
// starts, `activeItems` is empty, so items left marked "generating" by the
// killed process are detected as stale and restarted automatically.
//   done / uploaded / composited → skip (already produced today)
//   error                        → restart
//   generating older than STUCK_MINUTES and not running here → restart
//   planned / prompt_ready       → start (unless RECOVER_PLANNED=0)
const STUCK_MINUTES    = parseInt(process.env.STUCK_MINUTES || "30", 10);
const SWEEP_MINUTES    = parseInt(process.env.SWEEP_MINUTES || "240", 10);   // crawl every 4 hours by default
const RECOVER_PLANNED  = process.env.RECOVER_PLANNED !== "0";   // default: also start not-yet-started items
let sweepRunning = false;

function isStale(item) {
  const ts = item.updated_at || item.created_at;
  if (!ts) return true;                       // no timestamp → assume orphaned
  return (Date.now() - new Date(ts).getTime()) > STUCK_MINUTES * 60 * 1000;
}

async function runRecoverySweep(reason = "scheduled") {
  // Dashboard-only deployments (e.g. Render) can't drive Flow — never sweep there.
  if (process.env.DASHBOARD_ONLY === "1") return;
  if (sweepRunning) return;                   // never overlap sweeps
  sweepRunning = true;
  try {
    const today = localToday();
    const wanted = ["error", "generating"];
    if (RECOVER_PLANNED) wanted.push("planned", "prompt_ready");

    const { data: items } = await supabase.from("calendar_items")
      .select("*").eq("scheduled_date", today).in("status", wanted);
    if (!items || !items.length) { console.log(`🧹 sweep (${reason}): nothing pending for ${today}`); return; }

    // Decide what actually needs (re)starting.
    const todo = items.filter(it => {
      if (activeItems.has(it.id)) return false;              // running right now here
      if (it.status === "generating") return isStale(it);    // only if stuck > STUCK_MINUTES
      return true;                                            // error / planned / prompt_ready
    });
    if (!todo.length) { console.log(`🧹 sweep (${reason}): ${items.length} pending, none stale/ready yet`); return; }

    console.log(`🧹 sweep (${reason}): resuming ${todo.length} item(s) for ${today}`);
    const clientCache = {};
    for (const item of todo) {
      try {
        let client = clientCache[item.client_id];
        if (!client) {
          const { data: c } = await supabase.from("clients").select("*").eq("id", item.client_id).single();
          client = clientCache[item.client_id] = c;
        }
        if (!client || client.active === false) continue;
        if (!clientHasSession(client)) { console.log(`  ⏭️ ${client.name}: no login profile`); continue; }

        // Retire any orphaned video rows for this item (from the killed run).
        await supabase.from("videos").update({ status: "error", error: "orphaned — restarted by recovery sweep" })
          .eq("calendar_item_id", item.id).eq("status", "generating");

        const prompt = (item.prompt && item.prompt.trim()) ? item.prompt : await promptForItem(client, item);
        await supabase.from("calendar_items")
          .update({ status: "generating", prompt, error: null, updated_at: new Date().toISOString() })
          .eq("id", item.id);

        console.log(`  ▶ ${client.name}: ${item.topic || item.id} (was ${item.status})`);
        await waitUntilFree();                                 // one Flow session at a time
        await generateOne({ client, prompt, topic: item.topic, calItemId: item.id, link: item.link, referenceImage: item.reference_image || null });
      } catch (e) {
        console.log(`  ✗ sweep failed for item ${item.id}: ${e.message}`);
        await supabase.from("calendar_items")
          .update({ status: "error", error: e.message, updated_at: new Date().toISOString() }).eq("id", item.id);
      }
    }
  } finally {
    sweepRunning = false;
  }
}

// Back-compat: the afternoon pass now uses the same engine.
async function retryFailedForToday() { return runRecoverySweep("afternoon"); }

// Recovery crawl: every SWEEP_MINUTES (default 4 hours), plus ~60s after
// startup so a power-cut/reboot resumes today's unfinished work immediately.
setInterval(() => runRecoverySweep("scheduled").catch(e => console.log("sweep:", e.message)), SWEEP_MINUTES * 60 * 1000);
setTimeout(() => runRecoverySweep("startup").catch(e => console.log("sweep:", e.message)), 60 * 1000);

// Manual trigger — force the sweep right now instead of waiting for the
// next SWEEP_MINUTES interval. Only does anything on the LOCAL worker
// instance (DASHBOARD_ONLY instances never sweep — see runRecoverySweep).
// Debug helper: exactly what does THIS client have queued for TODAY,
// straight from the table — no scrolling through 1000+ rows in Supabase.
app.get("/api/clients/:id/calendar/today", async (req, res) => {
  const today = localToday();
  const { data, error } = await supabase.from("calendar_items")
    .select("*").eq("client_id", req.params.id).eq("scheduled_date", today)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ today, count: data.length, items: data });
});

app.get("/api/sweep/run-now", (req, res) => res.status(405).json({ error: "use POST" }));
app.post("/api/sweep/run-now", async (req, res) => {
  if (process.env.DASHBOARD_ONLY === "1") {
    return res.status(400).json({ error: "This is a DASHBOARD_ONLY instance — it never runs the sweep. Trigger this on your local worker instead." });
  }
  res.json({ ok: true, message: "Sweep started — watch the local terminal." });
  runRecoverySweep("manual").catch(e => console.log("sweep:", e.message));
});

// Time-gated trigger: check every 15 min; fire once per day at/after RETRY_HOUR.
setInterval(() => {
  const now = new Date();
  const today = localToday();
  if (localHour() >= RETRY_HOUR && lastRetryDate !== today) {
    lastRetryDate = today;
    console.log(`⏰ ${now.toLocaleTimeString()} — running afternoon retry pass`);
    retryFailedForToday().catch(e => console.log("afternoon retry:", e.message));
  }
}, 15 * 60 * 1000);

// Manual trigger for testing.
app.post("/api/retry-failed/run-now", async (req, res) => {
  res.json({ ok: true, message: "Afternoon retry started — watch server logs." });
  retryFailedForToday().catch(e => console.log("retry-now:", e.message));
});

// ====================================================================
//  YOUTUBE settings (per client) — official API only
// ====================================================================
app.post("/api/clients/:id/youtube", async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.upload_to_youtube !== undefined) patch.upload_to_youtube = !!b.upload_to_youtube;
  if (b.yt_hashtags !== undefined) patch.yt_hashtags = b.yt_hashtags;
  if (b.yt_tags !== undefined) patch.yt_tags = b.yt_tags;
  if (b.yt_title_tpl !== undefined) patch.yt_title_tpl = b.yt_title_tpl;
  if (b.yt_desc_tpl !== undefined) patch.yt_desc_tpl = b.yt_desc_tpl;
  const { data, error } = await supabase.from("clients").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/clients/:id/youtube/disconnect", async (req, res) => {
  const { error } = await supabase.from("clients")
    .update({ youtube_tokens: null, youtube_channel: null }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post("/api/clients/:id/drive/disconnect", async (req, res) => {
  const { error } = await supabase.from("clients")
    .update({ drive_tokens: null }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ====================================================================
//  GLOBAL SETTINGS (key/value) — used for the ONE shared Drive connection
// ====================================================================
async function getSetting(key) {
  const { data } = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
  return data ? data.value : null;
}
async function setSetting(key, value) {
  await supabase.from("settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

// Global Drive: status, connect, disconnect (one Drive account for all clients).
app.get("/api/settings/drive", async (req, res) => {
  const t = await getSetting("drive_tokens");
  res.json({ connected: !!(t && t.refresh_token) });
});
app.get("/api/oauth/drive-global/start", (req, res) => {
  res.redirect(googleLib.getServiceAuthUrl("__global__::drive", "drive"));
});
app.post("/api/settings/drive/disconnect", async (req, res) => {
  await setSetting("drive_tokens", null);
  res.json({ ok: true });
});

// ====================================================================
//  GOOGLE OAUTH (Drive = global · YouTube = per client)
// ====================================================================
app.get("/api/oauth/google/start", (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) return res.status(400).send("client_id required");
  res.redirect(googleLib.getAuthUrl(clientId));
});

// Per-service connect flow. service = "youtube" | "drive".
// (Drive here is kept for backward compatibility but the pipeline now uses the
//  GLOBAL Drive connection; prefer /api/oauth/drive-global/start.)
app.get("/api/oauth/:service/start", (req, res) => {
  const clientId = req.query.client_id;
  const service = req.params.service;
  if (!clientId) return res.status(400).send("client_id required");
  if (service !== "youtube" && service !== "drive") return res.status(400).send("bad service");
  res.redirect(googleLib.getServiceAuthUrl(`${clientId}::${service}`, service));
});

app.get("/api/oauth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    // state is "<clientId>", "<clientId>::<service>", or "__global__::drive".
    const [clientId, service] = String(state || "").split("::");

    // GLOBAL Drive connection → store in settings, not on a client.
    if (clientId === "__global__" && service === "drive") {
      const prev = await getSetting("drive_tokens");
      const { tokens } = await googleLib.exchangeCode(code, prev);
      await setSetting("drive_tokens", tokens);
      return res.send(`<html><body style="font-family:sans-serif;background:#0a0a0f;color:#e8e8f0;padding:40px">
        ✅ Google Drive connected (global). You can close this tab and return to Flow Studio.
        <script>setTimeout(()=>window.close(),1500)</script></body></html>`);
    }

    // Per-client: carry old refresh_token forward on re-consent.
    const { data: existing } = await supabase.from("clients")
      .select("youtube_tokens, drive_tokens").eq("id", clientId).maybeSingle();
    const prevTokens = service === "youtube" ? existing?.youtube_tokens
                     : service === "drive" ? existing?.drive_tokens
                     : (existing?.youtube_tokens || existing?.drive_tokens);
    const { tokens, channelName } = await googleLib.exchangeCode(code, prevTokens);

    let patch, label;
    if (service === "drive") {
      patch = { drive_tokens: tokens };
      label = "Google Drive (this client)";
    } else if (service === "youtube") {
      patch = { youtube_tokens: tokens, youtube_channel: channelName || null };
      label = channelName ? `YouTube (${channelName})` : "YouTube";
    } else {
      patch = { youtube_tokens: tokens, drive_tokens: tokens, youtube_channel: channelName || null };
      label = channelName ? `Google (${channelName})` : "Google";
    }
    await supabase.from("clients").update(patch).eq("id", clientId);

    res.send(`<html><body style="font-family:sans-serif;background:#0a0a0f;color:#e8e8f0;padding:40px">
      ✅ ${label} connected. You can close this tab and return to Flow Studio.
      <script>setTimeout(()=>window.close(),1500)</script></body></html>`);
  } catch (e) {
    res.status(500).send("OAuth failed: " + e.message);
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎬  Flow Studio → http://localhost:${PORT}`);
  const miss = [];
  if (!process.env.SUPABASE_URL) miss.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_KEY) miss.push("SUPABASE_SERVICE_KEY");
  if (miss.length) {
    console.log("\n⚠️  Missing env vars: " + miss.join(", "));
    console.log("    Clients can't be saved until these are set in .env.");
    console.log("    1) cp .env.example .env  2) fill values  3) run supabase-schema.sql  4) restart\n");
  } else {
    console.log("    Supabase configured. Visit /api/health to verify the DB connection.");
  }
});
