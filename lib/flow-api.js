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
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    permissions: ["clipboard-read", "clipboard-write"]
  });

  // Remove automation tells
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  // Load cookies so we're logged in
  await context.addCookies(cookies.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain || ".google.com",
    path: c.path || "/",
    expires: c.expirationDate || -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure
  })));

  const page = await context.newPage();

  try {
    // Load Flow — reCAPTCHA Enterprise initializes automatically
    onLog("📄 Loading Flow page...");
    await page.goto(FLOW_PROJECT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Wait for reCAPTCHA Enterprise script to load and initialize
    onLog("⏳ Waiting for reCAPTCHA to initialize...");
    await page.waitForFunction(() => {
      return typeof window.grecaptcha !== "undefined" &&
             typeof window.grecaptcha.enterprise !== "undefined" &&
             typeof window.grecaptcha.enterprise.execute === "function";
    }, { timeout: 30000 });

    onLog("✅ reCAPTCHA initialized on labs.google domain");

    // Generate token from within the page — domain check passes because
    // we're literally executing on labs.google
    const token = await page.evaluate(async (siteKey) => {
      return new Promise((resolve, reject) => {
        grecaptcha.enterprise.ready(async () => {
          try {
            const token = await grecaptcha.enterprise.execute(siteKey, {
              action: "VIDEO_GENERATION"
            });
            resolve(token);
          } catch(e) { reject(e.message); }
        });
      });
    }, FLOW_SITE_KEY);

    onLog("🔑 reCAPTCHA token generated on labs.google ✓");
    await browser.close();
    return token;

  } catch(e) {
    await browser.close();
    throw new Error(`Token generation failed: ${e.message}`);
  }
}

async function generateVideo({ cookies, prompt, imagePath = null, aspectRatio = "portrait", duration = 8, outDir, baseName, onLog = () => {} }) {
  // Step 1: Get a valid token from within the Flow page
  const captchaToken = await getTokenFromBrowser(cookies, onLog);

  const model = process.env.FLOW_MODEL || "omni-flash";
  onLog(`🎬 Calling Flow API directly with ${model} (${aspectRatio}, ${duration}s)...`);

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

  // Step 2: Call the real generation endpoint
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

  onLog("📡 Sending generation request...");
  const genRaw = await fetch(`${API_BASE}/video:batchAsyncGenerateVideoText`, {
    method: "POST", headers, body: JSON.stringify(genBody)
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