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
  if (!job) return;
  const entry = { type, message, ts: Date.now() };
  job.logs.push(entry);
  if (job.ws && job.ws.readyState === WebSocket.OPEN) job.ws.send(JSON.stringify(entry));
  console.log(`[${jobId.slice(0, 6)}] ${message}`);
}

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
  res.json({ env, db });
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
  if (req.files?.frame?.[0]) patch.frame_path = saveAsset(req.files.frame[0], `frame_${req.params.id}`);
  if (req.files?.outro?.[0]) patch.outro_path = saveAsset(req.files.outro[0], `outro_${req.params.id}`);
  if (req.files?.reference_image?.[0]) {
    // store with original extension so Flow accepts the format
    const f = req.files.reference_image[0];
    const ext = path.extname(f.originalname).toLowerCase() || ".png";
    const name = `ref_${req.params.id}_${Date.now()}${ext}`;
    fs.renameSync(f.path, path.join(__dirname, "assets", name));
    patch.reference_image_path = name;
  }

  const { data, error } = await supabase.from("clients").update(patch).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    const { days = 7, startDate } = req.body;
    const { data: client } = await supabase.from("clients").select("*").eq("id", req.params.id).single();
    if (!client) return res.status(404).json({ error: "client not found" });

    const items = await groqLib.generateCalendar({
      businessName: client.name,
      businessDetails: client.business_details,
      days, startDate
    });

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

    const prompt = item.source === "rss"
      ? await groqLib.generateNewsPrompt({
          businessName: client.name, businessDetails: client.business_details,
          title: item.topic, summary: item.hook
        })
      : await groqLib.generatePrompt({
          businessName: client.name, businessDetails: client.business_details,
          topic: item.topic, hook: item.hook,
          styleKey: client.prompt_style, styleInstruction: client.prompt_custom
        });

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
    if (!client.cookies) return res.status(400).json({ error: "client has no cookies configured" });

    let prompt = req.body.prompt;
    const calItemId = req.body.calendar_item_id || null;
    let topic = req.body.topic || "";

    if (!prompt && calItemId) {
      const { data: item } = await supabase.from("calendar_items").select("*").eq("id", calItemId).single();
      prompt = item?.prompt;
      topic = item?.topic || topic;
      if (!prompt) {
        prompt = item.source === "rss"
          ? await groqLib.generateNewsPrompt({
              businessName: client.name, businessDetails: client.business_details,
              title: item.topic, summary: item.hook
            })
          : await groqLib.generatePrompt({
              businessName: client.name, businessDetails: client.business_details,
              topic: item.topic, hook: item.hook,
              styleKey: client.prompt_style, styleInstruction: client.prompt_custom
            });
        await supabase.from("calendar_items").update({ prompt, status: "prompt_ready" }).eq("id", calItemId);
      }
    }
    if (!prompt) return res.status(400).json({ error: "prompt or calendar_item_id required" });

    // write cookies to a temp file for the playwright script
    const cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
    fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));

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
    jobs.set(jobId, { logs: [], ws: null });

    // create the video DB row (pending)
    const { data: videoRow } = await supabase.from("videos").insert({
      client_id: client.id, calendar_item_id: calItemId, prompt,
      title: topic || client.name, status: "generating"
    }).select().single();

    res.json({ jobId, videoId: videoRow.id });

    if (calItemId) await supabase.from("calendar_items").update({ status: "generating" }).eq("id", calItemId);

    runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====================================================================
//  PIPELINE: Flow generate → composite frame+outro → upload Drive/YouTube
// ====================================================================
let generationBusy = false; // true while a Flow browser session is running

function runPipeline({ jobId, client, cookiesPath, imagePath, prompt, videoRow, topic, onComplete }) {
  generationBusy = true;
  sendLog(jobId, "info", `🚀 Generating for ${client.name}`);
  sendLog(jobId, "info", `📋 ${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}`);

  const scriptPath = path.join(__dirname, "uploads", `script_${jobId}.js`);
  fs.writeFileSync(scriptPath, buildScript({
    cookiesPath, imagePath,
    prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
    aspectRatio: "9:16", speed: "1x", duration: "10s", jobId
  }));

  const proc = spawn("node", [scriptPath], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: "production", NODE_PATH: path.join(__dirname, "node_modules") }
  });

  let rawVideoFile = null;

  proc.stdout.on("data", (data) => {
    data.toString().split("\n").filter(l => l.trim()).forEach(line => {
      if (line.startsWith("__VIDEO__:")) { rawVideoFile = line.replace("__VIDEO__:", "").trim(); return; }
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

  proc.on("close", async (code) => {
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(cookiesPath); } catch {}

    if (!rawVideoFile) {
      sendLog(jobId, "error", `❌ Generation failed (exit ${code})`);
      await supabase.from("videos").update({ status: "error", error: "flow generation failed" }).eq("id", videoRow.id);
      generationBusy = false;
      if (onComplete) onComplete(false);
      return;
    }

    await supabase.from("videos").update({ raw_file: rawVideoFile }).eq("id", videoRow.id);
    sendLog(jobId, "success", `🎬 Raw video ready: ${rawVideoFile}`);

    // ---- composite frame + outro ----
    let finalName = rawVideoFile;
    try {
      const framePng = client.frame_path ? path.join(__dirname, "assets", client.frame_path) : null;
      const outroClip = client.outro_path ? path.join(__dirname, "assets", client.outro_path) : null;

      if (framePng || outroClip) {
        sendLog(jobId, "progress", "🎨 Compositing (frame · outro)…");
        const finalPath = await videoLib.compose({
          videoIn: path.join(__dirname, "outputs", rawVideoFile),
          framePng, outroClip,
          outDir: path.join(__dirname, "outputs"),
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

    const finalFull = path.join(__dirname, "outputs", finalName);

    // ---- Drive upload ----
    if (client.upload_to_drive) {
      if (!client.youtube_tokens) {
        sendLog(jobId, "warn", "Drive upload skipped — Google account not connected for this client");
      } else {
        try {
          sendLog(jobId, "progress", "☁️  Uploading to Google Drive…");
          const link = await googleLib.uploadToDrive({
            tokens: client.youtube_tokens, filePath: finalFull,
            name: `${client.name} - ${topic || finalName}.mp4`,
            folderId: client.drive_folder_id
          });
          await supabase.from("videos").update({ drive_url: link }).eq("id", videoRow.id);
          sendLog(jobId, "success", `✅ Drive: ${link}`);
        } catch (e) { sendLog(jobId, "error", `Drive upload failed: ${e.message}`); }
      }
    }

    // ---- YouTube upload (official API) ----
    if (client.upload_to_youtube && client.youtube_tokens) {
      try {
        sendLog(jobId, "progress", "📺 Preparing YouTube metadata…");
        const meta = await groqLib.generateYouTubeMeta({
          businessName: client.name, businessDetails: client.business_details,
          topic, prompt, defaultTags: client.yt_tags || client.yt_default_tags
        });

        // apply client templates / defaults
        const title = applyTpl(client.yt_title_tpl, { title: meta.title, client: client.name, topic })
          || meta.title;
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
          youtube_url: yt, title, description,
          hashtags, tags: tags.join(", ")
        }).eq("id", videoRow.id);
        sendLog(jobId, "success", `✅ YouTube: ${yt}`);
      } catch (e) { sendLog(jobId, "error", `YouTube upload failed: ${e.message}`); }
    } else if (client.upload_to_youtube) {
      sendLog(jobId, "warn", "YouTube upload skipped — channel not connected (Configure YouTube)");
    }

    await supabase.from("videos").update({ status: "uploaded" }).eq("id", videoRow.id);
    if (videoRow.calendar_item_id)
      await supabase.from("calendar_items").update({ status: "done" }).eq("id", videoRow.calendar_item_id);
    sendLog(jobId, "success", "🏁 Done");
    generationBusy = false;
    if (onComplete) onComplete(true);
  });
}

// ====================================================================
//  RSS — fetch feeds, ingest as items, daily auto-generate
// ====================================================================

// Reusable: run one full generation and resolve when the pipeline finishes.
function generateOne({ client, prompt, topic, calItemId, link }) {
  const cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
  fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));

  let imagePath = null;
  if (client.reference_image_path) {
    const ref = path.join(__dirname, "assets", client.reference_image_path);
    if (fs.existsSync(ref)) imagePath = ref;
  }

  const jobId = uuidv4();
  jobs.set(jobId, { logs: [], ws: null });

  return (async () => {
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
    }, 3000);
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
    const { data: existing } = await supabase.from("calendar_items")
      .select("link").eq("client_id", client.id).not("link", "is", null);
    const have = new Set((existing || []).map(e => e.link));
    const fresh = items.filter(i => !have.has(i.link));

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

// Daily scheduler: for each RSS client, ingest newest articles and auto-generate
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
    if (!client.cookies || !feeds) continue;            // not ready

    try {
      const items = await rssLib.fetchFeeds(feeds, 20);
      const { data: existing } = await supabase.from("calendar_items")
        .select("link").eq("client_id", client.id).not("link", "is", null);
      const have = new Set((existing || []).map(e => e.link));
      const fresh = items.filter(i => !have.has(i.link)).slice(0, client.rss_daily_limit || 3);

      console.log(`📰 RSS [${client.name}] ${fresh.length} new article(s) to generate`);
      for (const it of fresh) {
        const { data: ci } = await supabase.from("calendar_items").insert({
          client_id: client.id, topic: it.title, hook: it.summary, link: it.link,
          source: "rss", scheduled_date: today, status: "generating"
        }).select().single();

        const prompt = await groqLib.generateNewsPrompt({
          businessName: client.name, businessDetails: client.business_details,
          title: it.title, summary: it.summary
        });
        await supabase.from("calendar_items").update({ prompt }).eq("id", ci.id);

        await waitUntilFree();
        await generateOne({ client, prompt, topic: it.title, calItemId: ci.id, link: it.link });
      }
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

// ====================================================================
//  GOOGLE OAUTH (Drive + YouTube) — per client
// ====================================================================
app.get("/api/oauth/google/start", (req, res) => {
  const clientId = req.query.client_id;
  if (!clientId) return res.status(400).send("client_id required");
  res.redirect(googleLib.getAuthUrl(clientId));
});

app.get("/api/oauth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query; // state = our client id
    const { tokens, channelName } = await googleLib.exchangeCode(code);
    await supabase.from("clients").update({ youtube_tokens: tokens, youtube_channel: channelName || null }).eq("id", state);
    res.send(`<html><body style="font-family:sans-serif;background:#0a0a0f;color:#e8e8f0;padding:40px">
      ✅ Google account connected${channelName ? ` (channel: ${channelName})` : ""}. You can close this tab and return to Flow Studio.
      <script>setTimeout(()=>window.close(),1500)</script></body></html>`);
  } catch (e) {
    res.status(500).send("OAuth failed: " + e.message);
  }
});

const PORT = process.env.PORT || 3000;
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