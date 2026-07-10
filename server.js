require("dotenv").config();

const express = require("express");
const multer = require("multer");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
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

// ── live job log streaming ─────────────────────────────────────────
const jobs = new Map(); // jobId -> { logs:[], ws, videoId }
let generationBusy = false; // true while a Flow browser session is running (serializes generations)

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
  if (b.per_part_images !== undefined) patch.per_part_images = b.per_part_images === "true" || b.per_part_images === true;
  if (b.upload_to_drive !== undefined) patch.upload_to_drive = b.upload_to_drive === "true";
  if (b.drive_folder_id !== undefined) patch.drive_folder_id = b.drive_folder_id || null;
  if (b.upload_to_youtube !== undefined) patch.upload_to_youtube = b.upload_to_youtube === "true";
  if (b.yt_default_tags !== undefined) patch.yt_default_tags = b.yt_default_tags;
  // prompt style
  if (b.prompt_style !== undefined) patch.prompt_style = b.prompt_style || "default";
  if (b.prompt_custom !== undefined) patch.prompt_custom = b.prompt_custom || null;
  // content mode + RSS
  if (b.mode !== undefined) patch.mode = b.mode === "rss" ? "rss" : "calendar";
  if (b.rss_feeds !== undefined) patch.rss_feeds = b.rss_feeds;
  if (b.rss_categories !== undefined) patch.rss_categories = b.rss_categories;
  if (b.rss_daily_limit !== undefined) patch.rss_daily_limit = parseInt(b.rss_daily_limit) || 3;

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
app.get("/api/clients/:id/calendar", async (req, res) => {
  const { data, error } = await supabase.from("calendar_items")
    .select("*").eq("client_id", req.params.id).order("scheduled_date");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Generate calendar via Groq and store it
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
      const today = new Date().toISOString().slice(0, 10);
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

    if (calItemId) await supabase.from("calendar_items").update({ status: "generating" }).eq("id", calItemId);

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
  const clean = firstLine.replace(/^\*+|\*+$/g, "").replace(/[#*_`]/g, "").trim();
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

      // Per-part reference images: ask the ChatGPT image server to create ONE
      // image per part (from that part's scene text), save it locally, and paste
      // the matching image when generating each part. Falls back to the client's
      // shared image if a part image can't be made.
      let partImages = [];
      async function makePartImages(p) {
        const parts = groqLib.splitPromptParts(p);
        sendLog(jobId, "info", `🧪 Per-part images: detected ${parts.length} part(s)`);
        if (parts.length < 2) return [];   // only split (2+ part) videos need per-part images
        if (!process.env.CHATGPT_SERVER_URL) {
          sendLog(jobId, "warn", "CHATGPT_SERVER_URL not set — skipping per-part images, using client image");
          return [];
        }
        const local = [];
        for (let k = 0; k < parts.length; k++) {
          try {
            sendLog(jobId, "progress", `🖼️ Creating image for part ${k + 1}…`);
            const dataUrl = await groqLib.generateImage(parts[k], client.image_chat_link || "");  // this client's image chat (blank = fresh chat)
            let buf;
            if (dataUrl.startsWith("data:")) {
              buf = Buffer.from(dataUrl.split(",")[1], "base64");
            } else {
              const r = await fetch(dataUrl);
              buf = Buffer.from(await r.arrayBuffer());
            }
            const fp = path.join(__dirname, "uploads", `partimg_${jobId}_${k}.png`);
            fs.writeFileSync(fp, buf);
            local[k] = fp;
            sendLog(jobId, "success", `✅ Image ready for part ${k + 1}`);
          } catch (e) {
            sendLog(jobId, "warn", `Part ${k + 1} image failed (${e.message}) — using client image`);
            local[k] = null;
          }
        }
        return local;
      }
      try {
        partImages = await makePartImages(currentPrompt);
      } catch (e) {
        sendLog(jobId, "warn", `Per-part image step error: ${e.message}`);
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
        const parts = groqLib.splitPromptParts(currentPrompt);
        if (parts.length > 1) sendLog(jobId, "info", `🧩 Split into ${parts.length} parts`);
        rawFiles = [];
        let failed = false, policy = false;

        for (let i = 0; i < parts.length; i++) {
          if (parts.length > 1) sendLog(jobId, "progress", `🎬 Generating part ${i + 1}/${parts.length}…`);
          // Paste BOTH the per-part generated image AND the client's reference
          // image into Flow (per-part first as the frame, reference as anchor).
          const imgs = [...new Set([partImages[i], imagePath].filter(Boolean))];
          if (imgs.length) sendLog(jobId, "info", `🖼️ Part ${i + 1}: pasting ${imgs.length} image(s) into Flow`);
          const res = await generatePart({ jobId, partIndex: i, cookiesPath, profileDir, imagePaths: imgs, prompt: parts[i] });
          if (!res.file) { failed = true; policy = res.policy; break; }
          rawFiles.push(res.file);
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
              promptSample: client.prompt_sample, splitParts: client.split_parts
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
          const title = videoTitle;   // use the prompt's title, not client name
          const hashtags = (client.yt_hashtags
            ? client.yt_hashtags.split(",").map(h => h.trim()).filter(Boolean).map(h => h.startsWith("#") ? h : "#" + h).join(" ")
            : (meta.hashtags || ""));
          const descBase = applyTpl(client.yt_desc_tpl, { description: meta.description, client: client.name })
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
function generateOne({ client, prompt, topic, calItemId, link }) {
  let cookiesPath = null;
  if (client.cookies) {
    cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
    fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));
  }

  const jobId = uuidv4();
  jobs.set(jobId, { logs: [], ws: null, clientId: client.id });

  return (async () => {
    // sync this client's assets to local disk first (no-op if already present)
    await assetsSync.ensureLocalAssets(client, path.join(__dirname, "assets"));

    let imagePath = null;
    if (client.reference_image_path) {
      const ref = path.join(__dirname, "assets", client.reference_image_path);
      if (fs.existsSync(ref)) imagePath = ref;
    }

    const { data: videoRow } = await supabase.from("videos").insert({
      client_id: client.id, calendar_item_id: calItemId || null, prompt,
      title: topic || client.name, status: "generating"
    }).select().single();
    return new Promise(resolve => {
      runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic, onComplete: resolve });
    });
  })();
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
    const ins = await supabase.from("calendar_items").insert({
      client_id: client.id, topic: it.title, hook: it.summary, link: it.link,
      source: "rss", scheduled_date: dateStr, status: "generating"
    }).select().single();
    ci = ins.data;

    const prompt = await groqLib.generateNewsPrompt({
      businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
      title: it.title, summary: it.summary, splitParts: client.split_parts
    });
    await supabase.from("calendar_items").update({ prompt }).eq("id", ci.id);

    if (process.env.DASHBOARD_ONLY === "1") {
      await supabase.from("calendar_items").update({ status: "prompt_ready" }).eq("id", ci.id);
      return;
    }

    await waitUntilFree();
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
  if (!clientHasSession(client)) return res.status(400).json({ error: "no login profile — run: node login-once.js " + client.id });
  if (!clientFeeds(client)) return res.status(400).json({ error: "no RSS categories or feeds configured" });
  res.json({ ok: true, message: "RSS run started — watch the server logs and the client's calendar." });
  (async () => {
    const today = new Date().toISOString().slice(0, 10);
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
  const today = new Date().toISOString().slice(0, 10);
  let clients;
  try {
    const { data } = await supabase.from("clients").select("*").eq("mode", "rss");
    clients = data || [];
  } catch { return; }

  for (const client of clients) {
    if (client.last_rss_run === today) continue;        // already ran today
    const feeds = clientFeeds(client);
    if (!clientHasSession(client) || !feeds) {
      if (!clientHasSession(client)) console.log(`⏭️  RSS [${client.name}] skipped — no login profile (run: node login-once.js ${client.id})`);
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
//  PROMPT RESOLUTION for a calendar item
//   • user_prompt present (Excel upload) → enhancePrompt (keep wording, reformat+split)
//   • source "rss"                       → generateNewsPrompt (theme-safe, split)
//   • otherwise                          → generatePrompt (house calendar format)
// ====================================================================
async function promptForItem(client, item) {
  if (item.user_prompt && String(item.user_prompt).trim()) {
    return groqLib.enhancePrompt({
      userPrompt: item.user_prompt,
      businessName: client.name, businessDetails: client.business_details,
      splitParts: client.split_parts, chatLink: client.chatgpt_link
    });
  }
  if (item.source === "rss") {
    return groqLib.generateNewsPrompt({
      businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
      title: item.topic, summary: item.hook, splitParts: client.split_parts
    });
  }
  return groqLib.generatePrompt({
    businessName: client.name, businessDetails: client.business_details, chatLink: client.chatgpt_link,
    topic: item.topic, hook: item.hook,
    styleKey: client.prompt_style, styleInstruction: client.prompt_custom,
    promptSample: client.prompt_sample, splitParts: client.split_parts
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

async function retryFailedForToday() {
  if (generationBusy) { console.log("↩︎ retry: generation busy, will try later"); return; }
  const today = new Date().toISOString().slice(0, 10);

  // Items that were supposed to run today but didn't succeed.
  const { data: items } = await supabase.from("calendar_items")
    .select("*").eq("scheduled_date", today).in("status", ["error", "generating"]);
  if (!items || !items.length) { console.log("↩︎ retry: nothing to retry"); return; }

  console.log(`↩︎ Afternoon retry: ${items.length} item(s) to re-attempt`);
  const clientCache = {};
  for (const item of items) {
    try {
      let client = clientCache[item.client_id];
      if (!client) {
        const { data: c } = await supabase.from("clients").select("*").eq("id", item.client_id).single();
        client = clientCache[item.client_id] = c;
      }
      if (!client) continue;
      if (!clientHasSession(client)) { console.log(`  ⏭️ ${client.name}: no login profile`); continue; }

      // Mark any stuck video rows for this item as error so they don't linger.
      await supabase.from("videos").update({ status: "error", error: "superseded by afternoon retry" })
        .eq("calendar_item_id", item.id).in("status", ["generating"]);

      const prompt = (item.prompt && item.prompt.trim()) ? item.prompt : await promptForItem(client, item);
      await supabase.from("calendar_items").update({ status: "generating", prompt, error: null }).eq("id", item.id);

      await waitUntilFree();
      await generateOne({ client, prompt, topic: item.topic, calItemId: item.id, link: item.link });
    } catch (e) {
      console.log(`  ✗ retry failed for item ${item.id}: ${e.message}`);
      await supabase.from("calendar_items").update({ status: "error", error: e.message }).eq("id", item.id);
    }
  }
}

// Time-gated trigger: check every 15 min; fire once per day at/after RETRY_HOUR.
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() >= RETRY_HOUR && lastRetryDate !== today) {
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
