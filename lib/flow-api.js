/**
 * lib/flow-api.js — Direct Google Flow API using existing browser navigation.
 *
 * Uses flow.js navigation (which already works perfectly) to:
 * 1. Load Flow, dismiss modals, find prompt box ← already proven to work
 * 2. Generate reCAPTCHA token from within labs.google domain
 * 3. Intercept the real API request to capture OAuth token + request body
 * 4. Make subsequent requests directly with captured credentials
 */

const fs   = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const FLOW_SITE_KEY = "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const HOME_URL = "https://labs.google/fx/tools/flow";
const API_BASE = "https://aisandbox-pa.googleapis.com/v1";

function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const human = (page, min=600, max=1800) => page.waitForTimeout(rand(min, max));

async function generateVideo({ cookies, prompt, imagePath = null, aspectRatio = "portrait", duration = 8, outDir, baseName, onLog = () => {} }) {
  onLog("🌐 Launching browser on labs.google...");

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US", timezoneId: "Asia/Kolkata",
    permissions: ["clipboard-read", "clipboard-write"],
    acceptDownloads: true
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    delete Object.getPrototypeOf(navigator).webdriver;
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  });

  await context.addCookies(cookies.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain || ".google.com",
    path: c.path || "/",
    expires: c.expirationDate || -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure
  })));

  const page = await context.newPage();

  // Intercept API calls — captures OAuth token AND real request body
  let oauthToken = null;
  let capturedBody = null;
  let capturedOpName = null;

  await page.route("**aisandbox-pa.googleapis.com/**", async route => {
    const req = route.request();
    const hdrs = req.headers();
    if (!oauthToken) {
      oauthToken = hdrs["authorization"] || hdrs["Authorization"] || null;
      if (oauthToken) onLog(`✅ OAuth token captured`);
    }
    const body = req.postData();
    if (body && body.length > 10 && !capturedBody) {
      capturedBody = body;
      onLog(`✅ API request body captured: ${body.slice(0, 200)}`);
    }
    // Let the request go through and capture the response operation name
    const resp = await route.fetch();
    const respText = await resp.text();
    try {
      const respJson = JSON.parse(respText);
      const op = respJson.operationName || respJson.name || respJson[0]?.name;
      if (op && !capturedOpName) {
        capturedOpName = op;
        onLog(`✅ Operation started: ${op.split("/").pop()}`);
      }
    } catch {}
    await route.fulfill({ response: resp, body: respText });
  });

  try {
    // ── STEP 1: Navigate exactly like flow.js does (proven to work) ──
    onLog("📄 Loading Flow homepage...");
    const NAV_TIMEOUT = 90000;
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(45000);
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForLoadState("load", { timeout: NAV_TIMEOUT }).catch(() => {});
    onLog("Homepage opened");
    await human(page, 2500, 5000);

    // Click "Try Omni now" — same carousel retry logic as flow.js
    onLog("Looking for 'Try Omni now' button...");
    let projectLoaded = false;
    for (let attempt = 0; attempt < 20 && !projectLoaded; attempt++) {
      try {
        const btn = page.locator('button:has-text("Try Omni now"), a:has-text("Try Omni now")').first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          await page.waitForURL(/\/project\//, { timeout: 15000 });
          projectLoaded = true;
          onLog(`Project loaded: ${page.url()}`);
        }
      } catch {}
      if (!projectLoaded) await page.waitForTimeout(3000);
    }
    if (!projectLoaded) throw new Error("Could not load Flow project after 60s");

    // Dismiss modals
    await human(page, 1000, 2000);
    try {
      const notice = page.locator('button:has-text("Got it"), button:has-text("Dismiss"), button:has-text("Close")').first();
      if (await notice.isVisible({ timeout: 3000 })) { await notice.click(); onLog("Dismissed modal"); }
    } catch {}

    // ── STEP 2: Configure settings ──
    const menuBtns = await page.locator("button").all();
    let settingsBtn = null;
    for (const btn of menuBtns) {
      const txt = await btn.textContent().catch(() => "");
      if (txt.includes("Video") && txt.includes("crop")) { settingsBtn = btn; break; }
    }
    if (settingsBtn) {
      await settingsBtn.click();
      await human(page, 800, 1500);
      // Select 9:16 and 1x
      const ratio = page.locator('button:has-text("9:16"), [data-value="9:16"]').first();
      if (await ratio.isVisible({ timeout: 3000 })) await ratio.click();
      await human(page, 300, 600);
      const speed = page.locator('button:has-text("1x")').first();
      if (await speed.isVisible({ timeout: 3000 })) await speed.click();
      await human(page, 300, 600);
      // Close settings
      await page.keyboard.press("Escape");
      onLog("Settings configured");
    }

    // ── STEP 3: Get reCAPTCHA token from within the page ──
    await page.waitForFunction(() =>
      typeof window.grecaptcha !== "undefined" &&
      typeof window.grecaptcha.enterprise !== "undefined"
    , { timeout: 30000 }).catch(() => onLog("⚠️ reCAPTCHA not found"));

    const recaptchaToken = await page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        grecaptcha.enterprise.ready(async () => {
          try {
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
            if (!siteKey) siteKey = "6LdsFiUsAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
            const token = await grecaptcha.enterprise.execute(siteKey, { action: "VIDEO_GENERATION" });
            resolve(token);
          } catch(e) { reject(e.message); }
        });
      });
    }).catch(e => { onLog(`⚠️ reCAPTCHA token failed: ${e}`); return null; });

    if (recaptchaToken) onLog("🔑 reCAPTCHA token generated ✓");

    // ── STEP 4: Type prompt and submit — replicates flow.js exactly ──
    onLog("Finding prompt box...");
    const promptBox = await page.locator('[role="textbox"], textarea, [contenteditable="true"]')
      .filter({ hasText: "" })
      .last();

    // Better: wait for the composer area
    const composer = await page.waitForSelector(
      'textarea, [role="textbox"], [placeholder*="create" i], [placeholder*="want" i]',
      { timeout: 15000 }
    ).catch(() => null);

    if (!composer) throw new Error("Prompt box not found");

    await composer.click({ force: true });
    await human(page, 400, 800);
    await page.keyboard.press("End");
    await human(page, 200, 500);

    // Type with human-like delays
    for (const char of prompt) {
      await page.keyboard.type(char, { delay: rand(60, 150) });
      if (/[., ]/.test(char) && Math.random() < 0.2) await page.waitForTimeout(rand(200, 600));
    }
    await human(page, 1500, 3000);

    onLog("Prompt typed — clicking generate...");

    // Take a screenshot to see the page state
    try {
      const snapPath = path.join(outDir, `debug_before_generate_${baseName}.png`);
      fs.mkdirSync(outDir, { recursive: true });
      await page.screenshot({ path: snapPath, fullPage: false });
      onLog(`📸 Screenshot: ${path.basename(snapPath)}`);
    } catch {}

    // Pre-existing videos before we generate
    const preExisting = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video")).map(v => v.src).filter(Boolean)
    );

    // Use the exact same send button strategy as flow.js — proven to work
    const sendClicked = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll("button"));

      // Strategy 1: arrow_forward button (the → send button)
      const arrowBtn = allBtns.find(b => {
        const t = b.textContent || "";
        return t.includes("arrow_forward") && !b.disabled && b.getAttribute("aria-disabled") !== "true";
      });
      if (arrowBtn) {
        const r = arrowBtn.getBoundingClientRect();
        arrowBtn.click();
        return { found: true, method: "arrow_forward", x: Math.round(r.x), y: Math.round(r.y) };
      }

      // Strategy 2: rightmost enabled button in the bottom bar
      const bottomBtns = allBtns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.y > window.innerHeight * 0.7 && r.width > 0 && !b.disabled;
      }).sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
      if (bottomBtns.length > 0) {
        const r = bottomBtns[0].getBoundingClientRect();
        bottomBtns[0].click();
        return { found: true, method: "bottom-right", x: Math.round(r.x), y: Math.round(r.y) };
      }

      return { found: false };
    });
    onLog(`Send button: ${JSON.stringify(sendClicked)}`);

    if (!sendClicked.found) {
      // Fallback: press Enter in the composer
      await composer.click({ force: true });
      await page.keyboard.press("Enter");
      onLog("Fallback: pressed Enter");
    }

    await human(page, 1000, 2000);

    // ── STEP 5: Wait for the API intercept to capture operation ──
    onLog("Waiting for generation API call (up to 3 min)...");
    const deadline = Date.now() + 3 * 60 * 1000;
    let ticks = 0;
    while (!capturedOpName && Date.now() < deadline) {
      await page.waitForTimeout(3000);
      ticks++;
      if (ticks % 3 === 0) {
        // Check page for activity AND errors
        const pageState = await page.evaluate(() => {
          const body = document.body.innerText;
          return {
            queued: body.includes("Queued"),
            generating: body.includes("Generating") || /\d+%/.test(body),
            failed: body.includes("unusual activity") || body.includes("Failed") || body.includes("Help Center"),
            hasVideo: !!document.querySelector("video[src]"),
            snippet: body.slice(0, 300).replace(/\n+/g, " | ")
          };
        });
        onLog(`   [${Math.round((deadline - Date.now())/1000)}s left] oauth=${!!oauthToken} queued=${pageState.queued} gen=${pageState.generating} failed=${pageState.failed} video=${pageState.hasVideo}`);
        if (pageState.failed) {
          onLog(`⚠️  Page error: ${pageState.snippet}`);
          throw new Error("Flow blocked the generation: " + (pageState.snippet.includes("unusual activity") ? "unusual activity" : "generation failed"));
        }
        if (pageState.hasVideo && !capturedOpName) {
          onLog("Video appeared on page but API not intercepted — trying to get URL from page");
          const videoSrc = await page.evaluate(() => document.querySelector("video[src]")?.src);
          if (videoSrc) {
            onLog(`Found video URL: ${videoSrc}`);
            // Download directly
            const resp = await page.request.get(videoSrc);
            const buf = Buffer.from(await resp.body());
            if (buf.length > 100 * 1024) {
              fs.mkdirSync(outDir, { recursive: true });
              const fileName = `${baseName}.mp4`;
              fs.writeFileSync(path.join(outDir, fileName), buf);
              onLog(`✅ Saved from page: ${fileName} (${(buf.length/1024/1024).toFixed(1)} MB)`);
              await browser.close();
              return fileName;
            }
          }
        }
      }
    }

    if (!capturedOpName && capturedBody) {
      // We got the request body but missed the response — make the call ourselves
      onLog("Making direct API call with captured auth...");
      const directHeaders = {
        "Content-Type": "application/json",
        "Cookie": cookiesToHeader(cookies),
        "X-Goog-AuthUser": "0",
        "Origin": "https://labs.google",
        "Referer": "https://labs.google/fx/tools/flow",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      };
      if (oauthToken) directHeaders["Authorization"] = oauthToken.startsWith("Bearer ") ? oauthToken : `Bearer ${oauthToken}`;
      if (recaptchaToken) directHeaders["X-Recaptcha-Token"] = recaptchaToken;
      const r = await fetch(`${API_BASE}/video:batchAsyncGenerateVideoText`, {
        method: "POST", headers: directHeaders, body: capturedBody
      });
      const t = await r.text();
      onLog(`Direct call response (${r.status}): ${t.slice(0, 300)}`);
      try {
        const j = JSON.parse(t);
        capturedOpName = j.operationName || j.name || j[0]?.name;
        if (capturedOpName) onLog(`Operation: ${capturedOpName}`);
      } catch {}
    }

    if (!capturedOpName) throw new Error("Generation request not captured — generate may not have fired");

    await browser.close();

    // ── STEP 6: Poll the operation directly ──
    onLog(`⏳ Polling operation ${capturedOpName.split("/").pop()}...`);

    const authHeader = oauthToken || `${cookiesToHeader(cookies)}`;
    const pollHeaders = {
      "Content-Type": "application/json",
      "Cookie": cookiesToHeader(cookies),
      "X-Goog-AuthUser": "0",
      "Origin": "https://labs.google",
      "Referer": "https://labs.google/fx/tools/flow",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    };
    if (oauthToken) pollHeaders["Authorization"] = oauthToken.startsWith("Bearer ") ? oauthToken : `Bearer ${oauthToken}`;
    if (recaptchaToken) pollHeaders["X-Recaptcha-Token"] = recaptchaToken;

    const pollDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < pollDeadline) {
      await new Promise(r => setTimeout(r, 8000));
      const opId = capturedOpName.split("/").pop();
      const pollRaw = await fetch(`${API_BASE}/operations/${opId}`, { headers: pollHeaders });
      const pollText = await pollRaw.text();
      let poll;
      try { poll = JSON.parse(pollText); } catch { onLog(`Poll parse error: ${pollText.slice(0,100)}`); continue; }

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
        const dlRes = await fetch(videoUri, { headers: pollHeaders });
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
    throw new Error("Timed out waiting for operation to complete");

  } catch(e) {
    await browser.close();
    throw e;
  }
}

module.exports = { generateVideo };