/**
 * worker.js — one-shot job runner for GitHub Actions (free-plan mode).
 *
 * Does, once, then exits:
 *   1. RSS ingest + auto-generate for clients in "rss" mode (same logic as the
 *      in-server scheduler, but single-run).
 *   2. Processes any videos the dashboard queued (status = "queued").
 *
 * Pipeline per video: Flow (Playwright) → ffmpeg frame/outro → Drive/YouTube
 * upload → Supabase status updates. Local files are throwaway; everything
 * durable goes to Drive/YouTube/Supabase.
 *
 * Run with a display available, e.g.:  xvfb-run node worker.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const supabase = require("./lib/supabase");
const groqLib = require("./lib/groq");
const videoLib = require("./lib/video");
const googleLib = require("./lib/google");
const rssLib = require("./lib/rss");
const feedsLib = require("./lib/feeds");
const { buildScript } = require("./lib/flow");
const assetsLib  = require("./lib/assets");
const flowApiLib = require("./lib/flow-api");
const veoLib     = (() => { try { return require("./lib/veo"); } catch { return null; } })();

["uploads", "outputs", "assets"].forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

const MAX_VIDEOS_PER_RUN = parseInt(process.env.WORKER_MAX_VIDEOS || "4", 10);
let processed = 0;

const log = (m) => console.log(`[worker] ${m}`);

function applyTpl(tpl, vars) {
  if (!tpl) return null;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// ── core pipeline (mirrors server.js runPipeline, console-only) ──────
function runFlow({ client, prompt, jobId, imagePath }) {
  return new Promise((resolve) => {
    const cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
    fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));

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
    proc.stdout.on("data", d => d.toString().split("\n").filter(l => l.trim()).forEach(line => {
      if (line.startsWith("__VIDEO__:")) { rawVideoFile = line.replace("__VIDEO__:", "").trim(); return; }
      console.log(`  ${line.replace(/\r/g, "")}`);
    }));
    proc.stderr.on("data", d => d.toString().split("\n").filter(l => l.trim()).forEach(line => {
      if (!line.includes("DeprecationWarning") && !line.includes("ExperimentalWarning")) console.log(`  [err] ${line}`);
    }));

    proc.on("close", (code) => {
      try { fs.unlinkSync(scriptPath); } catch {}
      try { fs.unlinkSync(cookiesPath); } catch {}
      resolve({ rawVideoFile, code });
    });
  });
}

async function processVideo({ client, videoRow, prompt, topic }) {
  const jobId = uuidv4();
  log(`🚀 ${client.name} — "${(topic || prompt).slice(0, 70)}"`);
  await supabase.from("videos").update({ status: "generating" }).eq("id", videoRow.id);

  // pull this client's assets from Supabase Storage (runner disk is empty)
  const imagePath = client.reference_image_path ? await assetsLib.fetchAsset(client.reference_image_path) : null;
  if (client.reference_image_path && !imagePath) log("⚠️  reference image not in Supabase Storage — generating without it");

  let rawVideoFile = null;

  if (process.env.GEMINI_API_KEY && veoLib) {
    // Path 1: Official Veo API
    try {
      rawVideoFile = await veoLib.generateVideo({
        prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
        imagePath, aspectRatio: "9:16", durationSeconds: 8,
        outDir: path.join(__dirname, "outputs"),
        baseName: `veo_${jobId}`, onLog: (m) => log(m)
      });
    } catch (e) { log(`Veo API failed: ${e.message}`); }

  } else if (process.env.CAPTCHA_API_KEY) {
    // Path 2: Direct Flow API + captcha solving (no browser, uses Omni Flash credits)
    try {
      log(`🔑 Using direct Flow API with captcha solving (${process.env.CAPTCHA_SERVICE || "anticaptcha"})`);
      rawVideoFile = await flowApiLib.generateVideo({
        cookies: client.cookies,
        prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
        imagePath, aspectRatio: "portrait", duration: 8,
        outDir: path.join(__dirname, "outputs"),
        baseName: `flow_${jobId}`, onLog: (m) => log(m)
      });
    } catch (e) { log(`Flow direct API failed: ${e.message}`); }

  } else {
    // Path 3: Browser automation (Playwright) — fallback, often flagged on CI
    log("No GEMINI_API_KEY or CAPTCHA_API_KEY set — using browser automation (may be flagged)");
  }

  if (!rawVideoFile) {
    // Fallback: Flow browser automation (often flagged on datacenter IPs)
    if (!client.cookies) {
      log("❌ Veo failed and no Flow cookies available — cannot generate");
      await supabase.from("videos").update({ status: "error", error: "generation failed (no fallback)" }).eq("id", videoRow.id);
      if (videoRow.calendar_item_id)
        await supabase.from("calendar_items").update({ status: "error" }).eq("id", videoRow.calendar_item_id);
      return false;
    }
    log(process.env.GEMINI_API_KEY ? "Falling back to Flow browser automation…" : "GEMINI_API_KEY not set — using Flow browser automation");
    const flowRes = await runFlow({ client, prompt, jobId, imagePath });
    rawVideoFile = flowRes.rawVideoFile;
    if (!rawVideoFile) {
      log(`❌ Generation failed on all paths`);
      await supabase.from("videos").update({ status: "error", error: "generation failed" }).eq("id", videoRow.id);
      if (videoRow.calendar_item_id)
        await supabase.from("calendar_items").update({ status: "error" }).eq("id", videoRow.calendar_item_id);
      return false;
    }
  }
  await supabase.from("videos").update({ raw_file: rawVideoFile }).eq("id", videoRow.id);

  // composite frame + outro (fetched from Supabase Storage)
  let finalName = rawVideoFile;
  try {
    const framePng = client.frame_path ? await assetsLib.fetchAsset(client.frame_path) : null;
    const outroClip = client.outro_path ? await assetsLib.fetchAsset(client.outro_path) : null;
    if ((client.frame_path && !framePng) || (client.outro_path && !outroClip))
      log("⚠️  frame/outro configured but missing in Supabase Storage — re-upload it in the dashboard Config");
    if (framePng || outroClip) {
      log("🎨 Compositing frame/outro…");
      const finalPath = await videoLib.compose({
        videoIn: path.join(__dirname, "outputs", rawVideoFile),
        framePng, outroClip,
        outDir: path.join(__dirname, "outputs"),
        baseName: path.parse(rawVideoFile).name
      });
      finalName = path.basename(finalPath);
    }
  } catch (e) { log(`Compositing failed: ${e.message}`); }

  await supabase.from("videos").update({ final_file: finalName, status: "composited" }).eq("id", videoRow.id);
  const finalFull = path.join(__dirname, "outputs", finalName);

  // Drive
  if (client.upload_to_drive && client.youtube_tokens) {
    try {
      log("☁️  Uploading to Drive…");
      const link = await googleLib.uploadToDrive({
        tokens: client.youtube_tokens, filePath: finalFull,
        name: `${client.name} - ${topic || finalName}.mp4`,
        folderId: client.drive_folder_id
      });
      await supabase.from("videos").update({ drive_url: link }).eq("id", videoRow.id);
      log(`✅ Drive: ${link}`);
    } catch (e) { log(`Drive upload failed: ${e.message}`); }
  }

  // YouTube
  if (client.upload_to_youtube && client.youtube_tokens) {
    try {
      const meta = await groqLib.generateYouTubeMeta({
        businessName: client.name, businessDetails: client.business_details,
        topic, prompt, defaultTags: client.yt_tags || client.yt_default_tags
      });
      const title = applyTpl(client.yt_title_tpl, { title: meta.title, client: client.name, topic }) || meta.title;
      const hashtags = client.yt_hashtags
        ? client.yt_hashtags.split(",").map(h => h.trim()).filter(Boolean).map(h => h.startsWith("#") ? h : "#" + h).join(" ")
        : (meta.hashtags || "");
      const descBase = applyTpl(client.yt_desc_tpl, { description: meta.description, client: client.name }) || meta.description || "";
      const description = `${descBase}\n\n${hashtags}`.trim();
      const tags = [...new Set([...String(client.yt_tags || "").split(","), ...String(meta.tags || "").split(",")]
        .map(t => t.trim()).filter(Boolean))];

      log("📺 Uploading to YouTube…");
      const yt = await googleLib.uploadToYouTube({
        tokens: client.youtube_tokens, filePath: finalFull,
        title, description, tags, onLog: (m) => log(m)
      });
      await supabase.from("videos").update({
        youtube_url: yt, title, description, hashtags, tags: tags.join(", ")
      }).eq("id", videoRow.id);
      log(`✅ YouTube: ${yt}`);
    } catch (e) { log(`YouTube upload failed: ${e.message}`); }
  }

  await supabase.from("videos").update({ status: "uploaded" }).eq("id", videoRow.id);
  if (videoRow.calendar_item_id)
    await supabase.from("calendar_items").update({ status: "done" }).eq("id", videoRow.calendar_item_id);
  log("🏁 Done");
  return true;
}

// ── 1) queued videos from the dashboard ──────────────────────────────
async function processQueue() {
  const { data: queued } = await supabase.from("videos")
    .select("*").eq("status", "queued").order("created_at");
  if (!queued?.length) { log("Queue empty."); return; }
  log(`${queued.length} queued video(s).`);

  for (const v of queued) {
    if (processed >= MAX_VIDEOS_PER_RUN) { log("Per-run limit reached; rest stays queued."); return; }
    const { data: client } = await supabase.from("clients").select("*").eq("id", v.client_id).single();
    if (!client?.cookies && !process.env.GEMINI_API_KEY) { log(`Skipping ${v.id} — client missing cookies and no GEMINI_API_KEY`); continue; }
    await processVideo({ client, videoRow: v, prompt: v.prompt, topic: v.title });
    processed++;
  }
}

// ── 2) RSS daily auto-generate (single-run port of runRssScheduler) ──
function clientFeeds(client) {
  const cats = String(client.rss_categories || "").split(",").map(s => s.trim()).filter(Boolean);
  const catUrls = feedsLib.feedsForCategories(cats);
  const custom = rssLib.feedUrls(client.rss_feeds);
  return [...new Set([...catUrls, ...custom])].join("\n");
}

// strip tracking params/fragments so the same article always compares equal
function normLink(u) {
  try {
    const url = new URL(u);
    url.search = ""; url.hash = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch { return String(u || "").trim().toLowerCase(); }
}
const normTitle = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

async function runRssOnce() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: clients } = await supabase.from("clients").select("*").eq("mode", "rss");
  for (const client of clients || []) {
    if (client.last_rss_run === today) continue;
    const feeds = clientFeeds(client);
    if ((!client.cookies && !process.env.GEMINI_API_KEY) || !feeds) continue;
    if (processed >= MAX_VIDEOS_PER_RUN) { log("Per-run limit reached; RSS continues next run."); return; }

    try {
      const items = await rssLib.fetchFeeds(feeds, 20);
      // dedupe against BOTH link (normalized) and title of everything already generated
      const { data: existing } = await supabase.from("calendar_items")
        .select("link, topic").eq("client_id", client.id);
      const haveLinks = new Set((existing || []).map(e => normLink(e.link)).filter(Boolean));
      const haveTitles = new Set((existing || []).map(e => normTitle(e.topic)).filter(Boolean));
      const fresh = items
        .filter(i => !haveLinks.has(normLink(i.link)) && !haveTitles.has(normTitle(i.title)))
        .slice(0, client.rss_daily_limit || 3);
      log(`📰 RSS [${client.name}] ${fresh.length} new article(s)`);

      for (const it of fresh) {
        if (processed >= MAX_VIDEOS_PER_RUN) return;
        const { data: ci } = await supabase.from("calendar_items").insert({
          client_id: client.id, topic: it.title, hook: it.summary, link: it.link,
          source: "rss", scheduled_date: today, status: "generating"
        }).select().single();

        const prompt = await groqLib.generateNewsPrompt({
          businessName: client.name, businessDetails: client.business_details,
          title: it.title, summary: it.summary
        });
        await supabase.from("calendar_items").update({ prompt }).eq("id", ci.id);

        const { data: videoRow } = await supabase.from("videos").insert({
          client_id: client.id, calendar_item_id: ci.id, prompt,
          title: it.title, status: "generating"
        }).select().single();

        await processVideo({ client, videoRow, prompt, topic: it.title });
        processed++;
      }
      await supabase.from("clients").update({ last_rss_run: today }).eq("id", client.id);
    } catch (e) { log(`RSS error for ${client.name}: ${e.message}`); }
  }
}

(async () => {
  log(`Run started (max ${MAX_VIDEOS_PER_RUN} videos/run)`);
  await processQueue();
  await runRssOnce();
  log(`Run finished — ${processed} video(s) processed.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });