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

// No global cap — each client uses a separate Flow account, so generations
// don't share a quota. A safety ceiling avoids runaway loops only.
const MAX_VIDEOS_PER_RUN = parseInt(process.env.WORKER_MAX_VIDEOS || "1000", 10);
let processed = 0;

const log = (m) => console.log(`[worker] ${m}`);

function applyTpl(tpl, vars) {
  if (!tpl) return null;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// ── core pipeline (mirrors server.js runPipeline, console-only) ──────
// Parse a proxy URL like "http://user:pass@host:port" or "socks5://host:port"
// into the PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD vars that flow.js reads.
// Returns {} when no proxy is given so the global PROXY_SERVER secret (if any) is used.
// Hide credentials when logging a proxy URL.
function maskProxy(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; }
  catch { return String(url).replace(/:[^:@/]+@/, ":***@"); }
}

// Build an ordered, de-duplicated list of proxy URLs to rotate through.
// Sources: the client's own proxy, then PROXY_POOL (comma/newline separated),
// then the single PROXY_SERVER fallback. Bare "host:port" entries get the
// http:// scheme and inherit PROXY_USERNAME / PROXY_PASSWORD.
function buildProxyPool(clientProxy) {
  const user = process.env.PROXY_USERNAME || "";
  const pass = process.env.PROXY_PASSWORD || "";
  const norm = (raw) => {
    let s = String(raw || "").trim();
    if (!s) return null;
    if (!/^\w+:\/\//.test(s)) s = "http://" + s;          // add scheme if missing
    try {
      const u = new URL(s);
      if (!u.username && user) { u.username = user; u.password = pass; } // inherit creds
      return u.toString();
    } catch { return null; }
  };
  const raw = [
    clientProxy,
    ...String(process.env.PROXY_POOL || "").split(/[\n,]+/),
    process.env.PROXY_SERVER,
  ];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const n = norm(r);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function proxyEnvFromUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== "string" || !proxyUrl.trim()) return {};
  try {
    const u = new URL(proxyUrl.trim());
    const env = { PROXY_SERVER: `${u.protocol}//${u.host}` };
    if (u.username) env.PROXY_USERNAME = decodeURIComponent(u.username);
    if (u.password) env.PROXY_PASSWORD = decodeURIComponent(u.password);
    return env;
  } catch {
    // Not a URL — treat the whole value as the server (e.g. "1.2.3.4:8080")
    return { PROXY_SERVER: proxyUrl.trim() };
  }
}

function runFlow({ client, prompt, jobId, imagePath, proxyUrl }) {
  return new Promise((resolve) => {
    const cookiesPath = path.join(__dirname, "uploads", `cookies_${uuidv4()}.json`);
    fs.writeFileSync(cookiesPath, JSON.stringify(client.cookies));

    const scriptPath = path.join(__dirname, "uploads", `script_${jobId}.js`);
    fs.writeFileSync(scriptPath, buildScript({
      cookiesPath, imagePath,
      prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
      aspectRatio: "9:16", speed: "1x", duration: "10s", jobId
    }));

    // Per-client proxy overrides any global PROXY_SERVER inherited from process.env.
    const proxyEnv = proxyEnvFromUrl(proxyUrl);
    if (proxyEnv.PROXY_SERVER) log(`🌐 Routing ${client.name} through proxy ${proxyEnv.PROXY_SERVER}`);

    const proc = spawn("node", [scriptPath], {
      cwd: __dirname,
      env: { ...process.env, ...proxyEnv, NODE_ENV: "production", NODE_PATH: path.join(__dirname, "node_modules") }
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

  // Reference image is OPTIONAL — only used if the client has one configured.
  let imagePath = null;
  if (client.reference_image_path) {
    imagePath = await assetsLib.fetchAsset(client.reference_image_path).catch(() => null);
    if (imagePath) log("📎 Using client reference image");
    else log("⚠️  reference image configured but not found in storage — generating without it");
  } else {
    log("ℹ️  No reference image for this client — generating text-only");
  }

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
    log(`🔑 Using direct Flow API with captcha solving (${process.env.CAPTCHA_SERVICE || "anticaptcha"})`);

    // Build a proxy pool to rotate through on "unusual activity" blocks.
    // Order of preference: this client's own proxy, then PROXY_POOL entries,
    // then the single PROXY_SERVER fallback. host:port entries inherit the
    // global PROXY_USERNAME / PROXY_PASSWORD; full URLs are used as-is.
    const pool = buildProxyPool(client.proxy);
    if (pool.length) log(`🔁 Proxy pool: ${pool.length} IP(s) to try`);
    // Always have at least one attempt (null = no proxy / inherit env).
    const attempts = pool.length ? pool : [null];

    for (let i = 0; i < attempts.length; i++) {
      const px = attempts[i];
      try {
        if (px) log(`➡️  Attempt ${i + 1}/${attempts.length} via ${maskProxy(px)}`);
        rawVideoFile = await flowApiLib.generateVideo({
          cookies: client.cookies,
          prompt: String(prompt).replace(/\s*\n+\s*/g, " ").trim(),
          imagePath, aspectRatio: "portrait", duration: 8,
          proxy: px,
          outDir: path.join(__dirname, "outputs"),
          baseName: `flow_${jobId}`, onLog: (m) => log(m)
        });
        if (rawVideoFile) break;                 // success — stop rotating
      } catch (e) {
        const blocked = /unusual activity|blocked|403|429|permission denied|resource exhausted/i.test(e.message);
        log(`Flow attempt ${i + 1} failed: ${e.message}`);
        if (blocked && i < attempts.length - 1) { log("🔄 Rotating to next proxy…"); continue; }
        if (i >= attempts.length - 1) log("No more proxies to try.");
      }
    }

  } else {
    // Path 3: Browser automation (Playwright) — fallback, often flagged on CI
    log("No GEMINI_API_KEY or CAPTCHA_API_KEY set — using browser automation (may be flagged)");
  }

  if (!rawVideoFile) {
    // Block browser fallback when CAPTCHA_API_KEY is set — Chromium not installed
    if (process.env.CAPTCHA_API_KEY) {
      log("❌ Direct Flow API failed — check the error above. Browser fallback skipped (Chromium not installed in this workflow).");
      await supabase.from("videos").update({ status: "error", error: "flow-api failed" }).eq("id", videoRow.id);
      if (videoRow.calendar_item_id)
        await supabase.from("calendar_items").update({ status: "error" }).eq("id", videoRow.calendar_item_id);
      return false;
    }
    // Fallback: Flow browser automation (only when no captcha key)
    if (!client.cookies) {
      log("❌ No cookies and no captcha key — cannot generate");
      await supabase.from("videos").update({ status: "error", error: "generation failed (no fallback)" }).eq("id", videoRow.id);
      if (videoRow.calendar_item_id)
        await supabase.from("calendar_items").update({ status: "error" }).eq("id", videoRow.calendar_item_id);
      return false;
    }
    log(process.env.GEMINI_API_KEY ? "Falling back to Flow browser automation…" : "GEMINI_API_KEY not set — using Flow browser automation");

    // Rotate through the proxy pool: a slow/dead/flagged IP on one attempt
    // falls through to the next instead of failing the whole job.
    const pool = buildProxyPool(client.proxy);
    const attempts = pool.length ? pool : [null];
    if (pool.length) log(`🔁 Proxy pool: ${pool.length} IP(s) to try`);
    for (let i = 0; i < attempts.length; i++) {
      const px = attempts[i];
      if (px) log(`➡️  Attempt ${i + 1}/${attempts.length} via ${maskProxy(px)}`);
      const flowRes = await runFlow({ client, prompt, jobId, imagePath, proxyUrl: px });
      rawVideoFile = flowRes.rawVideoFile;
      if (rawVideoFile) break;
      if (i < attempts.length - 1) log("🔄 Rotating to next proxy…");
    }
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

// ── 1.5) calendar-due auto-generate ─────────────────────────────────
// Generates any calendar item scheduled for today (or earlier) that is
// still pending. This lets the dashboard calendar drive generation:
// schedule a topic for a date, and the worker makes it on that day.
async function processCalendarDue() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: due } = await supabase.from("calendar_items")
    .select("*")
    .lte("scheduled_date", today)
    .in("status", ["pending", "scheduled", "planned"])
    .order("scheduled_date");

  if (!due?.length) { log("No calendar items due."); return; }
  log(`📅 ${due.length} calendar item(s) due.`);

  for (const ci of due) {
    if (processed >= MAX_VIDEOS_PER_RUN) { log("Safety ceiling reached; rest stays for next run."); return; }
    const { data: client } = await supabase.from("clients").select("*").eq("id", ci.client_id).single();
    if (!client) { log(`Skipping calendar item ${ci.id} — client not found`); continue; }
    if (!client.cookies && !process.env.GEMINI_API_KEY && !process.env.CAPTCHA_API_KEY) {
      log(`Skipping ${client.name} calendar item — no auth configured`); continue;
    }

    // Build a prompt if the calendar item doesn't already have one
    let prompt = ci.prompt;
    if (!prompt) {
      prompt = await groqLib.generateNewsPrompt({
        businessName: client.name, businessDetails: client.business_details,
        title: ci.topic, summary: ci.hook || ""
      }).catch(() => ci.topic);
      await supabase.from("calendar_items").update({ prompt }).eq("id", ci.id);
    }

    await supabase.from("calendar_items").update({ status: "generating" }).eq("id", ci.id);

    const { data: videoRow } = await supabase.from("videos").insert({
      client_id: client.id, calendar_item_id: ci.id, prompt,
      title: ci.topic, status: "generating"
    }).select().single();

    await processVideo({ client, videoRow, prompt, topic: ci.topic });
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
        .filter(i => !haveLinks.has(normLink(i.link)) && !haveTitles.has(normTitle(i.title)));
      // No per-day cap — different account per client. Optional ceiling via rss_daily_limit if set >0.
      const capped = (client.rss_daily_limit && client.rss_daily_limit > 0)
        ? fresh.slice(0, client.rss_daily_limit)
        : fresh;
      log(`📰 RSS [${client.name}] ${capped.length} new article(s) from categories: ${client.rss_categories || "custom feeds"}`);

      for (const it of capped) {
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
  log(`Run started (ceiling ${MAX_VIDEOS_PER_RUN} videos/run)`);
  await processQueue();        // 1) dashboard-queued videos
  await processCalendarDue();  // 1.5) calendar items due today
  await runRssOnce();          // 2) daily RSS by category
  log(`Run finished — ${processed} video(s) processed.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });