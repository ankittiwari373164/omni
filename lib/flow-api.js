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

// Flow reCAPTCHA Enterprise sitekey — set FLOW_RECAPTCHA_KEY env var with the real
// key extracted from your browser's Network tab (see instructions below).
// To find it: open Flow project, F12 → Network → filter "recaptcha" → find the
// grecaptcha.enterprise.execute() call and copy the sitekey parameter.
const FLOW_SITE_KEY_FALLBACK = process.env.FLOW_RECAPTCHA_KEY || "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const FLOW_SITE_URL = "https://labs.google/fx/tools/flow";
const FLOW_API_BASE = "https://aisandbox-pa.googleapis.com/v1";

async function getFlowSiteKey() {
  // Try to find sitekey in a JS bundle (it's injected dynamically, not in HTML)
  try {
    const html = await fetch("https://labs.google/fx/tools/flow", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" }
    }).then(r => r.text());
    const bundles = [...html.matchAll(/src="(\/fx\/_next\/static\/chunks\/[^"]+\.js)"/g)].map(m => m[1]).slice(0, 8);
    for (const b of bundles) {
      try {
        const js = await fetch(`https://labs.google${b}`).then(r => r.text());
        // Look for reCAPTCHA Enterprise sitekey pattern
        const m = js.match(/enterprise[^)]*?['"]?(6[A-Za-z0-9_-]{38,})['"]?/);
        if (m) { console.log(`[flow-api] Found sitekey in bundle: ${m[1]}`); return m[1]; }
      } catch {}
    }
  } catch(e) {}
  console.log(`[flow-api] Using configured sitekey: ${FLOW_SITE_KEY_FALLBACK}`);
  return FLOW_SITE_KEY_FALLBACK;
}

// ── Captcha solving ──────────────────────────────────────────────────
async function solveRecaptcha(cookies, siteKey) {
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
          websiteKey: siteKey,
          minScore: 0.9,
          pageAction: "VIDEO_GENERATION"
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
        task: { type: "ReCaptchaV3TaskProxyLess", websiteURL: FLOW_SITE_URL, websiteKey: siteKey, pageAction: "VIDEO_GENERATION", minScore: 0.9 }
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
        googlekey: siteKey, pageurl: FLOW_SITE_URL,
        action: "VIDEO_GENERATION", min_score: 0.9, json: 1
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
    // FREE — 100 solves/day via t.me/CaptchaSolvBot
    // Try different pageActions — Flow may use a specific one
    const pageActions = ["VIDEO_GENERATION"];  // confirmed from browser intercept
    for (const pageAction of pageActions) {
      console.log(`[flow-api] Trying pageAction: ${pageAction}...`);
      const body = JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "RecaptchaV3EnterpriseTaskProxyless",
          websiteURL: FLOW_SITE_URL,
          websiteKey: siteKey,
          pageAction,
          minScore: 0.7   // lower threshold — 0.9 may be too strict
        }
      });

      const raw = await fetch("https://v1.captchasolv.com/solve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
          "Accept": "application/json"
        },
        body
      });

      const text = await raw.text();
      let res;
      try { res = JSON.parse(text); }
      catch { throw new Error(`CaptchaSolv returned non-JSON (HTTP ${raw.status}): ${text.slice(0, 200)}`); }

      if (res.errorId && res.errorId !== 0) {
        console.log(`[flow-api] pageAction "${pageAction}" failed (errorId: ${res.errorId}): ${res.errorDescription} | full: ${JSON.stringify(res).slice(0,200)}`);
        continue; // try next pageAction
      }

      const token = res.solution?.token || res.solution?.gRecaptchaResponse || res.token || res.gRecaptchaResponse;
      if (token) {
        console.log(`[flow-api] reCAPTCHA solved ✓ (pageAction: ${pageAction})`);
        return token;
      }
    }
    throw new Error("CaptchaSolv: all pageActions failed");

  } else if (service === "nextcaptcha") {
    // Free trial credits on signup — nextcaptcha.com
    const create = await fetch("https://api.nextcaptcha.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "RecaptchaV3EnterpriseTaskProxylessM1",
          websiteURL: FLOW_SITE_URL,
          websiteKey: siteKey,
          pageAction: "VIDEO_GENERATION",
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
  onLog("🔑 Fetching Flow reCAPTCHA site key...");
  const siteKey = await getFlowSiteKey();
  onLog("🎬 Flow API: solving reCAPTCHA...");
  const captchaToken = await solveRecaptcha(cookies, siteKey);

  const model = process.env.FLOW_MODEL || "omni-flash";
  onLog(`🎬 Flow API: generating with ${model} (${aspectRatio}, ${duration}s)...`);

  // Real endpoint discovered from browser Network tab
  const cookieHeader = cookiesToHeader(cookies);
  const headers = {
    "Content-Type": "application/json",
    "Cookie": cookieHeader,
    "X-Goog-AuthUser": "0",
    "X-Recaptcha-Token": captchaToken,
    "Origin": "https://labs.google",
    "Referer": "https://labs.google/fx/tools/flow",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  };

  // batchAsyncGenerateVideoText — the real generation endpoint
  const genBody = {
    requests: [{
      model: `publishers/google/models/${model}`,
      instances: [{ prompt }],
      parameters: {
        aspectRatio: aspectRatio === "portrait" ? "9:16" : aspectRatio,
        durationSeconds: duration,
        sampleCount: 1
      }
    }]
  };

  const genRaw = await fetch(`${FLOW_API_BASE}/video:batchAsyncGenerateVideoText`, {
    method: "POST", headers, body: JSON.stringify(genBody)
  });
  const genText = await genRaw.text();
  let genRes;
  try { genRes = JSON.parse(genText); }
  catch { throw new Error(`Generation API non-JSON (${genRaw.status}): ${genText.slice(0, 300)}`); }

  if (!genRaw.ok) throw new Error(`Generation API ${genRaw.status}: ${genText.slice(0, 300)}`);

  // Get operation name for polling
  const opName = genRes.operationName || genRes.name || genRes[0]?.name;
  if (!opName) throw new Error(`No operation name in response: ${JSON.stringify(genRes).slice(0, 300)}`);
  onLog(`⏳ Generation started (op: ${opName}), polling...`);

  // Poll the operation
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8000));
    const pollRaw = await fetch(`${FLOW_API_BASE}/operations/${opName.split('/').pop()}`, { headers });
    const pollText = await pollRaw.text();
    let poll;
    try { poll = JSON.parse(pollText); } catch { continue; }

    onLog(`   done: ${poll.done || false}`);
    if (poll.done) {
      if (poll.error) throw new Error(`Generation failed: ${JSON.stringify(poll.error)}`);

      const videoUri = poll.response?.predictions?.[0]?.bytesBase64Encoded
        ? null
        : poll.response?.predictions?.[0]?.video?.uri
          || poll.response?.generatedSamples?.[0]?.video?.uri
          || poll.response?.videos?.[0]?.uri;

      const videoBase64 = poll.response?.predictions?.[0]?.bytesBase64Encoded;

      if (!videoUri && !videoBase64)
        throw new Error(`No video in response: ${JSON.stringify(poll.response).slice(0, 300)}`);

      onLog("⬇️  Downloading video...");
      let buf;
      if (videoBase64) {
        buf = Buffer.from(videoBase64, "base64");
      } else {
        const dlRes = await fetch(videoUri, { headers });
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
        buf = Buffer.from(await dlRes.arrayBuffer());
      }
      if (buf.length < 100 * 1024) throw new Error(`Downloaded file too small (${buf.length} bytes)`);

      fs.mkdirSync(outDir, { recursive: true });
      const fileName = `${baseName}.mp4`;
      fs.writeFileSync(path.join(outDir, fileName), buf);
      onLog(`✅ Saved: ${fileName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return fileName;
    }
  }
  throw new Error("Flow API generation timed out after 12 minutes");
}

module.exports = { generateVideo };