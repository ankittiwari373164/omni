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
  page.on("console", msg => {
    if (msg.text().includes("sitekey") || msg.text().includes("6L"))
      onLog(`[browser] ${msg.text()}`);
  });

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

    // Read the actual sitekey from the page — Flow may use a different key
    // for execute() than the one visible in the HTML/console
    const token = await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        grecaptcha.enterprise.ready(async () => {
          try {
            // Try to find the sitekey Flow actually uses by intercepting
            // the grecaptcha config or reading from the script tag
            let siteKey = null;

            // Method 1: read from grecaptcha's internal config
            try {
              const cfg = Object.values(___grecaptcha_cfg?.clients || {});
              if (cfg.length > 0) {
                const client = cfg[0];
                // Walk the client object to find a key starting with 6L
                const findKey = (obj, depth = 0) => {
                  if (depth > 5) return null;
                  if (typeof obj === "string" && obj.startsWith("6L") && obj.length > 30) return obj;
                  if (typeof obj === "object" && obj !== null) {
                    for (const v of Object.values(obj)) {
                      const found = findKey(v, depth + 1);
                      if (found) return found;
                    }
                  }
                  return null;
                };
                siteKey = findKey(client);
              }
            } catch {}

            // Method 2: read from the script src
            if (!siteKey) {
              const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
              for (const s of scripts) {
                const m = s.src.match(/render=([^&]+)/);
                if (m) { siteKey = decodeURIComponent(m[1]); break; }
              }
            }

            // Method 3: use the known key from our browser intercept
            if (!siteKey) siteKey = "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

            console.log("Using sitekey:", siteKey);
            const token = await grecaptcha.enterprise.execute(siteKey, {
              action: "VIDEO_GENERATION"
            });
            resolve(token);
          } catch(e) { reject(e.message); }
        });
      });
    });

    onLog("🔑 reCAPTCHA token generated on labs.google ✓");

    // Extract OAuth2 access token from the page's JS context
    // Flow stores it in memory — we read it directly
    onLog("🔍 Extracting OAuth access token from page...");
    let oauthToken = null;

    // Method 1: intercept next network request to aisandbox-pa
    oauthToken = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const origFetch = window.fetch;
        window.fetch = function(...args) {
          const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
          if (url.includes("aisandbox-pa") || url.includes("googleapis")) {
            const headers = args[1]?.headers || {};
            const auth = headers["Authorization"] || headers["authorization"] ||
                         (headers instanceof Headers ? headers.get("Authorization") : null);
            if (auth) { resolve(auth); window.fetch = origFetch; }
          }
          return origFetch.apply(this, args);
        };
        // Trigger a tiny fetch to the API to capture the auth header
        setTimeout(() => resolve(null), 5000); // timeout fallback
      });
    }).catch(() => null);

    // Method 2: read from gapi/google auth objects in page context
    if (!oauthToken) {
      oauthToken = await page.evaluate(() => {
        try {
          // Check common locations where Flow might store the token
          const stores = [
            () => window.__NEXT_DATA__?.props?.pageProps?.accessToken,
            () => window.google?.accounts?.oauth2?.getToken?.()?.access_token,
            () => Object.values(window).find(v => typeof v === "string" && v.startsWith("ya29."))
          ];
          for (const getter of stores) {
            try { const v = getter(); if (v) return v; } catch {}
          }
          return null;
        } catch { return null; }
      }).catch(() => null);
    }

    // Intercept Flow's actual API calls to capture the real request body format
    onLog("🔍 Intercepting real API request format from Flow...");
    let capturedRequestBody = null;

    await page.route("**aisandbox-pa.googleapis.com/**", async route => {
      const req = route.request();
      const body = req.postData();
      if (body && body.length > 10) {
        capturedRequestBody = body;
        onLog(`[browser] Captured request body (${body.length} chars)`);
      }
      await route.continue();
    });

    // Trigger a real generation to capture the request format
    // Type a minimal prompt and click generate
    onLog("🖱️  Triggering generation to capture request format...");
    try {
      await page.waitForTimeout(2000);
      const promptBox = page.locator('[placeholder*="create" i], [placeholder*="want" i], [role="textbox"]').last();
      await promptBox.click({ force: true, timeout: 8000 });
      await page.waitForTimeout(500);
      await page.keyboard.type("a person walking", { delay: 80 });
      await page.waitForTimeout(1000);
      // Click send button
      const sendBtn = page.locator('button:has-text("arrow_forward"), button[aria-label*="send" i], button[aria-label*="generate" i]').last();
      await sendBtn.click({ force: true, timeout: 5000 }).catch(() => {
        return page.keyboard.press("Enter");
      });
      // Wait for the network request to fire
      await page.waitForTimeout(4000);
    } catch(e) { onLog(`[browser] Trigger attempt: ${e.message}`); }

    await browser.close();

    if (capturedRequestBody) {
      onLog(`✅ Captured real request body format`);
      return { recaptchaToken: result.token, oauthToken, realRequestBody: capturedRequestBody };
    }

    return { recaptchaToken: result.token, oauthToken, realRequestBody: null };

  } catch(e) {
    await browser.close();
    throw new Error(`Token generation failed: ${e.message}`);
  }
}

async function generateVideo({ cookies, prompt, imagePath = null, aspectRatio = "portrait", duration = 8, outDir, baseName, onLog = () => {} }) {
  // Step 1: Get reCAPTCHA token + OAuth token from within the Flow page
  const { recaptchaToken, oauthToken, realRequestBody } = await getTokenFromBrowser(cookies, onLog);

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