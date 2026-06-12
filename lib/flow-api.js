/**
 * lib/flow-api.js — Direct Google Flow API client.
 *
 * How it works:
 *   1. Opens Flow page in a real Playwright browser with your cookies
 *      (token MUST come from labs.google domain — cannot be generated elsewhere)
 *   2. Waits for reCAPTCHA Enterprise to initialize on the page
 *   3. Calls grecaptcha.enterprise.execute() from within the page context
 *      → token is generated on labs.google, passes domain check ✓
 *   4. Uses that token + cookies to call aisandbox-pa.googleapis.com directly
 *   5. Polls for completion and downloads the video
 *
 * No captcha service needed. The browser generates its own valid token.
 *
 * Required: CAPTCHA_API_KEY / CAPTCHA_SERVICE no longer needed.
 */

const fs   = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const FLOW_SITE_KEY = "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const FLOW_PROJECT_URL = "https://labs.google/fx/tools/flow";
const API_BASE = "https://aisandbox-pa.googleapis.com/v1";

function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

async function getTokenFromBrowser(cookies, onLog) {
  onLog("🌐 Launching browser to generate reCAPTCHA token on labs.google...");
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US"
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await context.addCookies(cookies.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain || ".google.com",
    path: c.path || "/",
    expires: c.expirationDate || -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure
  })));

  const page = await context.newPage();
  page.on("console", msg => {
    if (msg.text().includes("sitekey") || msg.text().includes("6L") || msg.text().includes("body"))
      onLog(`[browser] ${msg.text().slice(0, 200)}`);
  });

  // Intercept API calls to capture OAuth token AND real request body
  let oauthToken = null;
  let capturedRequestBody = null;
  await page.route("**aisandbox-pa.googleapis.com/**", async route => {
    const req = route.request();
    const hdrs = req.headers();
    if (!oauthToken) oauthToken = hdrs["authorization"] || hdrs["Authorization"] || null;
    const body = req.postData();
    if (body && body.length > 10 && !capturedRequestBody) {
      capturedRequestBody = body;
      onLog(`[browser] Captured API body: ${body.slice(0, 300)}`);
    }
    await route.continue();
  });

  try {
    onLog("📄 Loading Flow page...");
    await page.goto(FLOW_PROJECT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    onLog("⏳ Waiting for reCAPTCHA to initialize...");
    await page.waitForFunction(() =>
      typeof window.grecaptcha !== "undefined" &&
      typeof window.grecaptcha.enterprise !== "undefined" &&
      typeof window.grecaptcha.enterprise.execute === "function"
    , { timeout: 30000 });
    onLog("✅ reCAPTCHA initialized on labs.google domain");

    // Generate reCAPTCHA token from within the page context
    const recaptchaToken = await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        grecaptcha.enterprise.ready(async () => {
          try {
            // Find the real sitekey from grecaptcha internal config
            let siteKey = null;
            try {
              const cfg = Object.values(typeof ___grecaptcha_cfg !== "undefined" ? ___grecaptcha_cfg?.clients || {} : {});
              const findKey = (obj, d=0) => {
                if (d > 5) return null;
                if (typeof obj === "string" && obj.startsWith("6L") && obj.length > 30) return obj;
                if (typeof obj === "object" && obj !== null)
                  for (const v of Object.values(obj)) { const f = findKey(v, d+1); if (f) return f; }
                return null;
              };
              if (cfg.length > 0) siteKey = findKey(cfg[0]);
            } catch {}
            if (!siteKey) {
              const s = Array.from(document.querySelectorAll("script[src*=recaptcha]"))
                .map(s => (s.src.match(/render=([^&]+)/) || [])[1])
                .filter(Boolean)[0];
              if (s) siteKey = decodeURIComponent(s);
            }
            if (!siteKey) siteKey = "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
            console.log("Using sitekey:", siteKey);
            const token = await grecaptcha.enterprise.execute(siteKey, { action: "VIDEO_GENERATION" });
            resolve(token);
          } catch(e) { reject(e.message); }
        });
      });
    });
    onLog("🔑 reCAPTCHA token generated on labs.google ✓");

    // Trigger a real click in Flow to capture the OAuth token + request body
    onLog("🖱️  Clicking generate to capture real auth + request body...");
    try {
      await page.waitForTimeout(2000);
      // Wait for the composer to appear
      const composer = await page.waitForSelector(
        '[data-testid*="prompt"], textarea, [contenteditable="true"], [role="textbox"]',
        { timeout: 10000 }
      ).catch(() => null);
      if (composer) {
        await composer.click({ force: true });
        await page.waitForTimeout(300);
        await page.keyboard.type("test video", { delay: 60 });
        await page.waitForTimeout(800);
        // Press Enter or click the send button
        await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(5000); // wait for network request
      }
    } catch(e) { onLog(`[browser] Trigger: ${e.message}`); }

    await browser.close();

    if (!oauthToken) onLog("⚠️  OAuth token not captured from network intercept");
    if (!capturedRequestBody) onLog("⚠️  Request body not captured — will use fallback format");

    return { recaptchaToken, oauthToken, capturedRequestBody };

  } catch(e) {
    await browser.close();
    throw new Error(`Browser session failed: ${e.message}`);
  }
}

async function generateVideo({ cookies, prompt, imagePath = null, aspectRatio = "portrait", duration = 8, outDir, baseName, onLog = () => {} }) {
  // Step 1: Get reCAPTCHA token + OAuth token from within the Flow page
  const { recaptchaToken, oauthToken, capturedRequestBody: realRequestBody } = await getTokenFromBrowser(cookies, onLog);

  const model = process.env.FLOW_MODEL || "omni-flash";
  onLog(`🎬 Calling Flow API directly with ${model} (${aspectRatio}, ${duration}s)...`);

  const cookieHeader = cookiesToHeader(cookies);
  const headers = {
    "Content-Type": "application/json",
    "Cookie": cookieHeader,
    "X-Goog-AuthUser": "0",
    "X-Recaptcha-Token": recaptchaToken,
    "Origin": "https://labs.google",
    "Referer": "https://labs.google/fx/tools/flow",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  };
  if (oauthToken) {
    headers["Authorization"] = oauthToken.startsWith("Bearer ") ? oauthToken : `Bearer ${oauthToken}`;
    onLog("🔐 Using OAuth Bearer token for authentication");
  }

  // If we captured the real request body from Flow, log it so we know the correct format
  if (realRequestBody) {
    onLog(`📋 Real request body: ${realRequestBody.slice(0, 500)}`);
  }

  // Build request body — replace prompt in captured body if available
  let bodyStr;
  if (realRequestBody) {
    try {
      const realBody = JSON.parse(realRequestBody);
      // Replace just the prompt, keep everything else (model name, field names etc.)
      const replacePrompt = (obj) => {
        if (typeof obj === "string" && obj.length > 10 && !obj.startsWith("publishers") && !obj.startsWith("omni")) return prompt;
        if (typeof obj === "object" && obj !== null) {
          return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, replacePrompt(v)]));
        }
        if (Array.isArray(obj)) return obj.map(replacePrompt);
        return obj;
      };
      // More targeted: find and replace the prompt field specifically
      const patchPrompt = (obj) => {
        if (typeof obj !== "object" || obj === null) return obj;
        if (Array.isArray(obj)) return obj.map(patchPrompt);
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === "prompt" || k === "text" || k === "userText") result[k] = prompt;
          else result[k] = patchPrompt(v);
        }
        return result;
      };
      bodyStr = JSON.stringify(patchPrompt(realBody));
      onLog(`📤 Using real body format with updated prompt`);
    } catch(e) { bodyStr = null; }
  }

  // Fallback body if we couldn't capture the real format
  if (!bodyStr) {
    // Try the format Flow actually uses based on the aisandbox endpoint
    bodyStr = JSON.stringify({
      prompt,
      model,
      aspectRatio: aspectRatio === "portrait" ? "9:16" : aspectRatio,
      duration,
      count: 1
    });
  }

  onLog("📡 Sending generation request...");
  const genRaw = await fetch(`${API_BASE}/video:batchAsyncGenerateVideoText`, {
    method: "POST", headers, body: bodyStr
  });
  const genText = await genRaw.text();
  let genRes;
  try { genRes = JSON.parse(genText); }
  catch { throw new Error(`API non-JSON (${genRaw.status}): ${genText.slice(0, 300)}`); }

  if (!genRaw.ok) throw new Error(`API ${genRaw.status}: ${genText.slice(0, 300)}`);

  const opName = genRes.operationName || genRes.name || genRes[0]?.name;
  if (!opName) throw new Error(`No operation name: ${JSON.stringify(genRes).slice(0, 300)}`);
  onLog(`⏳ Generation started (${opName.split("/").pop()}), polling...`);

  // Step 3: Poll for completion
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8000));
    const pollRaw = await fetch(
      `${API_BASE}/operations/${opName.split("/").pop()}`,
      { headers }
    );
    const pollText = await pollRaw.text();
    let poll;
    try { poll = JSON.parse(pollText); } catch { continue; }

    onLog(`   done: ${poll.done || false}`);
    if (!poll.done) continue;

    if (poll.error) throw new Error(`Generation failed: ${JSON.stringify(poll.error)}`);

    const videoUri = poll.response?.predictions?.[0]?.video?.uri
      || poll.response?.generatedSamples?.[0]?.video?.uri
      || poll.response?.videos?.[0]?.uri;
    const videoBase64 = poll.response?.predictions?.[0]?.bytesBase64Encoded;

    if (!videoUri && !videoBase64)
      throw new Error(`No video in response: ${JSON.stringify(poll.response || {}).slice(0, 300)}`);

    onLog("⬇️  Downloading video...");
    let buf;
    if (videoBase64) {
      buf = Buffer.from(videoBase64, "base64");
    } else {
      const dlRes = await fetch(videoUri, { headers });
      if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
      buf = Buffer.from(await dlRes.arrayBuffer());
    }
    if (buf.length < 100 * 1024) throw new Error(`File too small: ${buf.length} bytes`);

    fs.mkdirSync(outDir, { recursive: true });
    const fileName = `${baseName}.mp4`;
    fs.writeFileSync(path.join(outDir, fileName), buf);
    onLog(`✅ Saved: ${fileName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    return fileName;
  }
  throw new Error("Timed out after 12 minutes");
}

module.exports = { generateVideo };