/**
 * lib/flow-api.js — Direct Google Flow API client (no browser).
 *
 * Replicates exactly what UseAPI.net does:
 *   1. Solve reCAPTCHA Enterprise v3 via a captcha service
 *   2. POST directly to Flow's internal tRPC/API endpoint
 *   3. Poll for completion and download the video
 *
 * Required env vars:
 *   CAPTCHA_SERVICE  = "anticaptcha" | "capsolver" | "2captcha" | "solvecaptcha"
 *   CAPTCHA_API_KEY  = your key from the captcha service
 *
 * Optional:
 *   FLOW_MODEL       = "omni-flash" (default) | "veo-3.1-fast" | "veo-3.1-lite"
 */

const fs   = require("fs");
const path = require("path");

// Flow's reCAPTCHA Enterprise site key (from the JS bundle)
const FLOW_SITE_KEY   = "6LfP0ZYaAAAAADB1C3bipmCHkjLyRfS6oE2bDgXh";
const FLOW_SITE_URL   = "https://labs.google/fx/tools/flow";
const FLOW_API_BASE   = "https://labs.google/fx/api/trpc";

// ── Captcha solving ──────────────────────────────────────────────────
async function solveRecaptcha(cookies) {
  const service = (process.env.CAPTCHA_SERVICE || "").toLowerCase();
  const apiKey  = process.env.CAPTCHA_API_KEY || "";
  if (!apiKey) throw new Error("CAPTCHA_API_KEY not set");

  console.log(`[flow-api] Solving reCAPTCHA via ${service}...`);

  if (service === "anticaptcha") {
    // Create task
    const create = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "RecaptchaV3TaskProxyless",
          websiteURL: FLOW_SITE_URL,
          websiteKey: FLOW_SITE_KEY,
          minScore: 0.9,
          pageAction: "generate"
        }
      })
    }).then(r => r.json());
    if (create.errorId) throw new Error(`AntiCaptcha create error: ${create.errorDescription}`);
    const taskId = create.taskId;

    // Poll for result
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId })
      }).then(r => r.json());
      if (res.status === "ready") { console.log("[flow-api] reCAPTCHA solved ✓"); return res.solution.gRecaptchaResponse; }
      if (res.errorId) throw new Error(`AntiCaptcha poll error: ${res.errorDescription}`);
    }
    throw new Error("AntiCaptcha timeout");

  } else if (service === "capsolver") {
    const create = await fetch("https://api.capsolver.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: { type: "ReCaptchaV3TaskProxyLess", websiteURL: FLOW_SITE_URL, websiteKey: FLOW_SITE_KEY, pageAction: "generate", minScore: 0.9 }
      })
    }).then(r => r.json());
    if (create.errorCode) throw new Error(`CapSolver error: ${create.errorDescription}`);
    const taskId = create.taskId;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId })
      }).then(r => r.json());
      if (res.status === "ready") { console.log("[flow-api] reCAPTCHA solved ✓"); return res.solution.gRecaptchaResponse; }
      if (res.errorCode) throw new Error(`CapSolver poll error: ${res.errorDescription}`);
    }
    throw new Error("CapSolver timeout");

  } else if (service === "2captcha" || service === "solvecaptcha") {
    const base = service === "solvecaptcha" ? "https://api.solvecaptcha.com" : "https://2captcha.com";
    const submit = await fetch(`${base}/in.php`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: apiKey, method: "userrecaptcha", version: "v3",
        googlekey: FLOW_SITE_KEY, pageurl: FLOW_SITE_URL,
        action: "generate", min_score: 0.9, json: 1
      })
    }).then(r => r.json());
    if (submit.status !== 1) throw new Error(`${service} submit error: ${submit.request}`);
    const captchaId = submit.request;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${base}/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`).then(r => r.json());
      if (res.status === 1) { console.log("[flow-api] reCAPTCHA solved ✓"); return res.request; }
      if (res.request !== "CAPCHA_NOT_READY") throw new Error(`${service} poll error: ${res.request}`);
    }
      throw new Error(`${service} timeout`);

  } else if (service === "captchasolv") {
    // FREE — 100 solves/day, no credit card. Get key via t.me/CaptchaSolvBot
    const create = await fetch("https://api.captchasolv.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "RecaptchaV3EnterpriseTaskProxyless",
          websiteURL: FLOW_SITE_URL,
          websiteKey: FLOW_SITE_KEY,
          pageAction: "generate",
          minScore: 0.9
        }
      })
    }).then(r => r.json());
    if (create.errorId) throw new Error(`CaptchaSolv create error: ${create.errorDescription}`);
    const taskId = create.taskId;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch("https://api.captchasolv.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId })
      }).then(r => r.json());
      if (res.status === "ready") { console.log("[flow-api] reCAPTCHA solved ✓"); return res.solution.token || res.solution.gRecaptchaResponse; }
      if (res.errorId) throw new Error(`CaptchaSolv poll error: ${res.errorDescription}`);
    }
    throw new Error("CaptchaSolv timeout");

  } else if (service === "nextcaptcha") {
    // Free trial credits on signup — nextcaptcha.com
    const create = await fetch("https://api.nextcaptcha.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "RecaptchaV3EnterpriseTaskProxylessM1",
          websiteURL: FLOW_SITE_URL,
          websiteKey: FLOW_SITE_KEY,
          pageAction: "generate",
          minScore: 0.9
        }
      })
    }).then(r => r.json());
    if (create.errorId) throw new Error(`NextCaptcha error: ${create.errorDescription}`);
    const taskId = create.taskId;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch("https://api.nextcaptcha.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId })
      }).then(r => r.json());
      if (res.status === "ready") { console.log("[flow-api] reCAPTCHA solved ✓"); return res.solution.gRecaptchaResponse; }
      if (res.errorId) throw new Error(`NextCaptcha poll error: ${res.errorDescription}`);
    }
    throw new Error("NextCaptcha timeout");
  }

  throw new Error(`Unknown CAPTCHA_SERVICE: "${service}". Use: captchasolv (FREE 100/day), nextcaptcha, anticaptcha, capsolver, 2captcha, solvecaptcha`);
}

// ── Cookie helper ────────────────────────────────────────────────────
function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

// ── Flow API request ─────────────────────────────────────────────────
async function flowRequest(endpoint, body, cookies, captchaToken) {
  const cookieHeader = cookiesToHeader(cookies);
  // Extract __Secure-1PSID for auth
  const sid = cookies.find(c => c.name === "__Secure-1PSID")?.value || "";

  const headers = {
    "Content-Type": "application/json",
    "Cookie": cookieHeader,
    "Authorization": `SAPISIDHASH ${await generateSapisidHash(sid)}`,
    "X-Goog-Authuser": "0",
    "X-Recaptcha-Token": captchaToken,
    "Origin": "https://labs.google",
    "Referer": "https://labs.google/fx/tools/flow",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  };

  const res = await fetch(`${FLOW_API_BASE}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Flow API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// SAPISIDHASH generation (required by Google APIs)
async function generateSapisidHash(sapisid) {
  const timeMs = Date.now();
  const timeSec = Math.floor(timeMs / 1000);
  const data = `${timeSec} ${sapisid} https://labs.google`;
  const encoder = new TextEncoder();
  const hashBuffer = await require("crypto").createHash("sha1").update(data).digest("hex");
  return `${timeSec}_${hashBuffer}`;
}

// ── Main generation function ─────────────────────────────────────────
async function generateVideo({ cookies, prompt, imagePath = null, aspectRatio = "portrait", duration = 8, outDir, baseName, onLog = () => {} }) {
  onLog("🎬 Flow API: solving reCAPTCHA...");
  const captchaToken = await solveRecaptcha(cookies);

  // Build the generation request body (matches Flow's internal tRPC schema)
  const model = process.env.FLOW_MODEL || "omni-flash";
  onLog(`🎬 Flow API: generating with ${model} (${aspectRatio}, ${duration}s)...`);

  const requestBody = {
    prompt,
    model,
    aspectRatio,
    duration,
    count: 1,
    clientPlatform: "CLIENT_PLATFORM_WEB"
  };

  // If we have a reference image, upload it first
  if (imagePath && fs.existsSync(imagePath)) {
    onLog("📎 Uploading reference image...");
    const imgData = fs.readFileSync(imagePath).toString("base64");
    const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

    const uploadRes = await flowRequest("media.uploadAsset", {
      data: imgData, mimeType, filename: path.basename(imagePath)
    }, cookies, captchaToken);

    if (uploadRes?.result?.data?.mediaGenerationId) {
      requestBody.referenceImage_1 = uploadRes.result.data.mediaGenerationId;
      onLog("✅ Reference image uploaded");
    }
  }

  // Trigger generation
  const genRes = await flowRequest("media.generateVideo", requestBody, cookies, captchaToken);

  if (!genRes?.result?.data?.jobId) {
    throw new Error(`Unexpected generation response: ${JSON.stringify(genRes).slice(0, 300)}`);
  }

  const jobId = genRes.result.data.jobId;
  onLog(`⏳ Generation started (job: ${jobId}), polling...`);

  // Poll for completion (typically 60-180s)
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8000));
    const poll = await flowRequest("media.getJob", { jobId }, cookies, captchaToken).catch(e => null);
    const status = poll?.result?.data?.status;
    onLog(`   status: ${status || "pending"}`);

    if (status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
      const videoUrl = poll.result.data.videoUrl;
      if (!videoUrl) throw new Error("Job succeeded but no videoUrl in response");

      onLog("⬇️  Downloading video...");
      const dlRes = await fetch(videoUrl);
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      const buf = Buffer.from(await dlRes.arrayBuffer());

      fs.mkdirSync(outDir, { recursive: true });
      const fileName = `${baseName}.mp4`;
      fs.writeFileSync(path.join(outDir, fileName), buf);
      onLog(`✅ Saved: ${fileName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return fileName;
    }

    if (status === "MEDIA_GENERATION_STATUS_FAILED") {
      throw new Error(`Flow generation failed: ${JSON.stringify(poll?.result?.data?.error || {})}`);
    }
  }
  throw new Error("Flow API generation timed out after 12 minutes");
}

module.exports = { generateVideo };