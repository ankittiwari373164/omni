const path = require("path");

function buildScript({ cookiesPath, profileDir, imagePath, prompt, aspectRatio, speed, duration, jobId }) {
  const absCookies = cookiesPath ? JSON.stringify(path.resolve(cookiesPath)) : "null";
  const absProfile = profileDir ? JSON.stringify(path.resolve(profileDir)) : "null";
  const absImage   = imagePath ? JSON.stringify(path.resolve(imagePath)) : "null";
  const absOutput  = JSON.stringify(path.resolve(__dirname, "..", "outputs"));
  const safePrompt = prompt.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `
const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const HOME_URL    = "https://labs.google/fx/tools/flow";
const PROJECT_URL = process.env.FLOW_PROJECT_URL || "";  // open a clean project directly if set
const PROMPT     = \`${safePrompt}\`;
const ASPECT     = ${JSON.stringify(aspectRatio)};
const SPEED      = ${JSON.stringify(speed)};
const DURATION   = ${JSON.stringify(duration)};
const OUTPUT_DIR = ${absOutput};
const JOB_ID     = ${JSON.stringify(jobId)};
const IMAGE_PATH = ${absImage};
const PROFILE_DIR = ${absProfile};
const COOKIES_PATH = ${absCookies};

async function waitForCompletion(page, maxSeconds = 300, preExistingSrcs = []) {
  const preCount = preExistingSrcs.length;
  console.log("Polling for completion (pre-existing videos: " + preCount + ")...");
  const known = new Set(preExistingSrcs);
  let sawProgress = false;     // did we ever observe active generation?
  let noProgressStreak = 0;
  for (let s = 0; s < maxSeconds; s += 5) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate((knownArr) => {
      const known = new Set(knownArr);
      const body = document.body.innerText;
      const all = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]'));
      // NEW videos = srcs not present before we generated
      const freshSrcs = all.map(v => v.src).filter(src => !known.has(src));
      const pctMatch = body.match(/(\\d+)%/);
      const pct = pctMatch ? Number(pctMatch[1]) : null;
      const isGenerating = pct !== null
        || !!document.querySelector('[class*="progress"i],[role="progressbar"],[class*="shimmer"i],[class*="skeleton"i]')
        || /Generating|Queued/i.test(body);
      return {
        pct,
        isGenerating,
        isPolicy: body.includes("violate our policies"),
        freshCount: freshSrcs.length,
        newSrc: freshSrcs[0] || null,
        total: all.length
      };
    }, [...known]);

    if (state.isGenerating) sawProgress = true;
    console.log(\`  [\${s+5}s] gen=\${state.isGenerating} pct=\${state.pct ?? "-"} fresh=\${state.freshCount} total=\${state.total}(pre=\${preCount})\`);

    if (state.isPolicy) { console.log("→ Policy violation"); return { status: "policy" }; }

    // SUCCESS: a brand-new video src exists (or total grew past pre-count) and
    // nothing is rendering anymore.
    if ((state.newSrc || state.total > preCount) && !state.isGenerating) {
      // small settle wait so the src is final
      await page.waitForTimeout(2500);
      const finalSrc = await page.evaluate((knownArr) => {
        const known = new Set(knownArr);
        const all = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]'));
        const fresh = all.map(v => v.src).filter(src => !known.has(src));
        return fresh[0] || (all[0] ? all[0].src : null);
      }, [...known]);
      if (finalSrc) { console.log("→ Success! new video"); return { status: "success", src: finalSrc }; }
    }

    // FAILURE: only if we NEVER saw progress, no new video appeared, and the
    // page has had no activity for a sustained period (~30s of polls). We do
    // NOT trust "Failed"/"unusual activity" text alone — old cards trigger it.
    if (!state.isGenerating && state.freshCount === 0 && state.total <= preCount) {
      noProgressStreak++;
    } else {
      noProgressStreak = 0;
    }
    // If after 90s nothing ever started generating and nothing new appeared, give up.
    if (s >= 90 && !sawProgress && noProgressStreak >= 6) {
      console.log("→ Failed: generation never started (no new video in 90s)");
      return { status: "failed" };
    }
  }
  // Timeout: if a new video exists anyway, count it as success.
  const lastSrc = await page.evaluate((knownArr) => {
    const known = new Set(knownArr);
    const all = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]'));
    const fresh = all.map(v => v.src).filter(src => !known.has(src));
    return fresh[0] || null;
  }, [...known]).catch(() => null);
  if (lastSrc) { console.log("→ Success (found at timeout)"); return { status: "success", src: lastSrc }; }
  return { status: "timeout" };
}

(async () => {
  // Must use headless: false — Google Flow UI does not fully render in headless mode
  let browser, context;
  if (PROFILE_DIR) {
    // PERSISTENT PROFILE: a real on-disk Chrome profile for THIS client's
    // Google account. Logged in once by hand; stays logged in forever and
    // self-refreshes its session like a normal browser. No cookie expiry.
    console.log("Using persistent profile:", PROFILE_DIR);
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: null,
      acceptDownloads: true,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
      permissions: ["clipboard-read", "clipboard-write"]
    });
    browser = context.browser();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://labs.google" }).catch(() => {});
  } else {
    // FALLBACK: cookie injection (short-lived; expires in ~1 day).
    browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
    });
    context = await browser.newContext({ viewport: null, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://labs.google" }).catch(() => {});
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
    await context.addCookies(raw.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      expires: c.expirationDate || -1, httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: c.sameSite === "strict" ? "Strict" : c.sameSite === "none" ? "None" : "Lax"
    })));
  }

  const page = context.pages()[0] || await context.newPage();

  if (PROJECT_URL) {
    // Open a specific CLEAN project directly — avoids the cluttered default
    // project (20+ old videos + stale 'Failed' cards) that breaks new-video detection.
    console.log("Opening clean project directly:", PROJECT_URL);
    await page.goto(PROJECT_URL, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(3000);
    if (page.url().includes("accounts.google.com")) {
      console.log("❌ Cookies expired!"); await browser.close(); process.exit(1);
    }
  } else {
    await page.goto(HOME_URL, { waitUntil: "networkidle" });
    console.log("Homepage opened");
    await page.waitForTimeout(3000);

    if (page.url().includes("accounts.google.com")) {
      console.log("❌ Cookies expired!"); await browser.close(); process.exit(1);
    }

    // Keep retrying "Try Omni now" — it lives in a carousel that rotates slides,
    // so the button may not be visible on the first slide.
    {
      console.log("Looking for 'Try Omni now' button (carousel retry loop)...");
      let launched = false;
      const deadline = Date.now() + 60000;
      while (!launched && Date.now() < deadline) {
        try {
          if (page.url().includes("/flow/project/")) { launched = true; break; }
          const btn = page.locator('button:has-text("Try Omni now"), a:has-text("Try Omni now")').first();
          if (await btn.count() > 0) {
            await btn.click();
            console.log("Clicked 'Try Omni now'");
            launched = true;
          } else {
            console.log("'Try Omni now' not visible yet, waiting for carousel...");
            await page.waitForTimeout(2000);
          }
        } catch(e) {
          console.log("Retry error:", e.message);
          await page.waitForTimeout(2000);
        }
      }
      if (!launched) {
        console.log("Could not find 'Try Omni now' after 60s — aborting");
        await browser.close(); process.exit(1);
      }
    }
    await page.waitForURL("**/flow/project/**", { timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  console.log("Project loaded:", page.url());

  // ── FIX 0: Make sure we're on the project CANVAS, not the "Explore Tools"
  // page or the onboarding flow. Strip /tools and any query params and reload
  // the clean project URL so the prompt box + Generate button are present. ──
  async function ensureCanvas() {
    const m = page.url().match(/(https:\\/\\/labs\\.google\\/fx\\/tools\\/flow\\/project\\/[a-z0-9-]+)/i);
    if (!m) return;
    const clean = m[1];
    if (page.url() !== clean) {
      console.log("Not on canvas (" + page.url() + ") — navigating to", clean);
      await page.goto(clean, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
    }
  }
  await ensureCanvas();
  console.log("Canvas ready:", page.url());

  // ── FIX 1: Dismiss "I agree" Notice modal (appears before "Got it") ──
  try {
    const agreeBtn = page.locator('button:has-text("I agree")').first();
    await agreeBtn.waitFor({ timeout: 8000 });
    await agreeBtn.click();
    console.log("Clicked 'I agree' on Notice modal");
    await page.waitForTimeout(1000);
  } catch { console.log("No Notice modal"); }

  // Dismiss secondary "Got it" modal if present
  try {
    const gotIt = page.locator('button:has-text("Got it")').first();
    await gotIt.waitFor({ timeout: 8000 });
    await gotIt.click();
    console.log("Dismissed 'Got it' modal");
    await page.waitForTimeout(1000);
  } catch { console.log("No 'Got it' modal"); }

  // ── Image: write PNG to clipboard then paste ONCE into prompt box ──
  if (IMAGE_PATH) {
    console.log("Pasting reference image:", IMAGE_PATH);
    const mimeType = IMAGE_PATH.match(/\\.png$/i) ? "image/png" :
                     IMAGE_PATH.match(/\\.gif$/i) ? "image/gif" :
                     IMAGE_PATH.match(/\\.webp$/i) ? "image/webp" : "image/jpeg";
    try {
      const base64Data = fs.readFileSync(IMAGE_PATH).toString("base64");
      const promptEl = page.locator('[role="textbox"]').first();
      await promptEl.click({ force: true });
      await page.waitForTimeout(400);
      await page.evaluate(async ({ base64Data, mimeType }) => {
        const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: new Blob([bytes], { type: mimeType }) })]);
      }, { base64Data, mimeType });
      await promptEl.click({ force: true });
      await page.keyboard.press("Control+V");
      await page.waitForTimeout(2500);
      console.log("Image pasted (Ctrl+V)");
    } catch(e) { console.log("Image paste error:", e.message.split("\\n")[0]); }
    await page.waitForTimeout(500);
  }

  // Settings — open menu then select tabs
  async function selectTab(name) {
    const tabs = page.locator('[role="tab"]');
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      const txt = await tabs.nth(i).textContent();
      if (txt?.includes(name)) {
        const sel = await tabs.nth(i).getAttribute("aria-selected");
        if (sel !== "true") { await tabs.nth(i).click(); await page.waitForTimeout(400); console.log(\`Selected: \${name}\`); }
        else { console.log(\`Already selected: \${name}\`); }
        return true;
      }
    }
    const allTabs = [];
    for (let i = 0; i < n; i++) allTabs.push(await tabs.nth(i).textContent());
    console.log(\`Tab not found: "\${name}" — available: [\${allTabs.map(t=>t?.trim()).join(", ")}]\`);
    return false;
  }

  // Find and click the Video settings button
  const allMenuBtns = page.locator('button[aria-haspopup="menu"]');
  const menuCount = await allMenuBtns.count();
  console.log(\`Found \${menuCount} menu buttons\`);
  for (let i = 0; i < menuCount; i++) {
    const txt = await allMenuBtns.nth(i).textContent();
    console.log(\`  Menu btn [\${i}]: "\${txt?.trim()}"\`);
    if (txt?.includes("Video")) {
      await allMenuBtns.nth(i).click();
      console.log(\`Opened settings via button [\${i}]\`);
      await page.waitForTimeout(1000);
      break;
    }
  }

  await selectTab("Video");
  await selectTab(ASPECT);
  await selectTab(SPEED);
  await selectTab(DURATION);
  // Close the settings popup WITHOUT clicking the left sidebar (a fixed-coord
  // click there can hit "Tools"/"Uploads" and navigate away from the canvas).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  await ensureCanvas();
  console.log("Settings done");

  // ── Prompt: click the box, move to end, then TYPE (not fill) so image chip is preserved ──
  const promptBox = page.locator('[role="textbox"]').first();
  await promptBox.waitFor({ timeout: 10000 });
  await promptBox.click({ force: true });
  await page.waitForTimeout(300);

  // Move cursor to end of any existing content (the pasted image chip)
  await page.keyboard.press("End");
  await page.waitForTimeout(200);

  // Use keyboard.type() — unlike fill(), this appends keystrokes and won't wipe the image attachment
  await page.keyboard.type(PROMPT, { delay: 8 });
  await page.waitForTimeout(500);
  console.log(\`Prompt typed: \${PROMPT.length} chars\`);

  // Snapshot videos already on the canvas BEFORE generating, so we can tell the
  // newly-created one apart from old clips (and not download a stale video).
  const preExistingSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video[src*="getMediaUrl"]')).map(v => v.src)
  );
  console.log(\`Pre-existing videos on canvas: \${preExistingSrcs.length}\`);

  // Find and click the → send button
  const sendClicked = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button'));

    // Strategy 1: find button containing arrow_forward text (Material icon name)
    const arrowBtn = allBtns.find(b => {
      const t = b.textContent || "";
      return t.includes("arrow_forward") && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    });
    if (arrowBtn) {
      const r = arrowBtn.getBoundingClientRect();
      arrowBtn.click();
      return { found: true, method: "arrow_forward", x: r.x, y: r.y };
    }

    // Strategy 2: rightmost enabled button in the bottom bar
    const bottomBarBtns = allBtns
      .map(b => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.y > window.innerHeight - 120 && r.width > 0 && r.height > 0)
      .filter(({ b }) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')
      .filter(({ b }) => {
        const t = (b.textContent || "").toLowerCase();
        return !t.includes("clear") && !t.includes("close") && !t.includes("agent") && !t.includes("add") && !t.includes("+");
      })
      .sort((a, b) => b.r.x - a.r.x);

    if (bottomBarBtns.length > 0) {
      const { b, r } = bottomBarBtns[0];
      b.click();
      return { found: true, method: "rightmost_bottom", x: Math.round(r.x), y: Math.round(r.y), text: b.textContent?.trim().slice(0, 30) };
    }

    return { found: false };
  });

  console.log("Send button result:", JSON.stringify(sendClicked));
  if (!sendClicked.found) {
    console.log("Fallback: clicking fixed coordinates (957, 670)");
    await page.mouse.click(957, 670);
  }
  console.log("Generate clicked ✓");

  // Wait for generation to actually start before polling
  console.log("Waiting for generation to start...");
  await page.waitForTimeout(4000);

  const result = await waitForCompletion(page, 300, preExistingSrcs);
  if (result.status !== "success") {
    console.log(\`❌ Ended: \${result.status}\`);
    await browser.close(); process.exit(1);
  }
  console.log("Video URL:", result.src);

  // ── Download — UI menu (matches manual: hover → ⋮ → Download → 720p) ──
  let downloaded = false;
  const fileName = \`flow_\${JOB_ID}.mp4\`;
  const outPath  = path.join(OUTPUT_DIR, fileName);

  // Identify the NEW video element by the name in its src, so we act on the
  // freshly generated clip — not an older one on the canvas.
  let nameParam = "";
  try { nameParam = new URL(result.src).searchParams.get("name") || ""; } catch {}

  // STRATEGY 1 (PRIMARY): the real UI download — hover the NEW video's card,
  // open ITS ⋮ menu (not some other card's), click Download, pick 720p.
  try {
    // Find the target video element, with fallbacks:
    //  1) exact name match  2) any getMediaUrl video  3) the newest by DOM order
    let vid = nameParam ? page.locator(\`video[src*="\${nameParam}"]\`).first() : null;
    if (!vid || await vid.count() === 0) vid = page.locator('video[src*="getMediaUrl"]').first();
    await vid.scrollIntoViewIfNeeded().catch(() => {});
    let vbox = await vid.boundingBox().catch(() => null);

    // Fallback: if no bounding box, use the FIRST media card in the grid
    // (newest generation always appears top-left).
    if (!vbox) {
      console.log("name-matched video had no box — falling back to newest card");
      const firstVid = page.locator('video[src*="getMediaUrl"]').first();
      await firstVid.scrollIntoViewIfNeeded().catch(() => {});
      vbox = await firstVid.boundingBox().catch(() => null);
    }
    if (!vbox) throw new Error("no video bounding box (UI not laid out)");

    // Hover the CENTER of the video to reveal its card's action buttons.
    await page.mouse.move(vbox.x + vbox.width/2, vbox.y + vbox.height/2, { steps: 6 });
    await page.waitForTimeout(1200);

    // Find the ⋮ button that belongs to THIS video's card by geometry.
    const dotBox = await page.evaluate((vb) => {
      const btns = Array.from(document.querySelectorAll('button'));
      const within = btns.filter(b => {
        const t = (b.textContent || "") + (b.getAttribute("aria-label") || "");
        if (!/more_vert|more|option/i.test(t)) return false;
        const r = b.getBoundingClientRect();
        const cx = r.x + r.width/2, cy = r.y + r.height/2;
        return cx >= vb.x - 10 && cx <= vb.x + vb.width + 10 &&
               cy >= vb.y - 10 && cy <= vb.y + vb.height + 60;
      });
      if (!within.length) return null;
      within.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.x - ra.x) || (ra.y - rb.y);
      });
      const r = within[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    }, vbox);

    if (!dotBox) throw new Error("could not find ⋮ button on the video's card");
    await page.mouse.move(dotBox.x, dotBox.y, { steps: 4 });
    await page.mouse.click(dotBox.x, dotBox.y);
    console.log(\`Opened ⋮ on video card at (\${dotBox.x}, \${dotBox.y})\`);
    await page.waitForTimeout(900);

    const dlPromise = page.waitForEvent("download", { timeout: 60000 });
    const dlItem = page.locator('[role="menuitem"]:has-text("Download"), :text("Download")').first();
    await dlItem.hover().catch(() => {});
    await dlItem.click({ timeout: 5000 });
    await page.waitForTimeout(900);
    // Pick 720p (Original Size). Avoid Animated GIF / Upscaled (paid).
    const res = page.locator(':text("720p"), :text("Original Size")').first();
    if (await res.count() > 0) await res.click({ timeout: 5000 }).catch(() => {});
    const dl = await dlPromise;
    await dl.saveAs(outPath);
    const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    if (sz > 10000) {
      console.log(\`✅ Downloaded (UI 720p): \${fileName} (\${(sz/1024/1024).toFixed(1)} MB)\`);
      console.log("__VIDEO__:" + fileName);
      downloaded = true;
    } else { console.log("UI download produced an empty file"); }
  } catch(e) { console.log("UI menu download failed:", e.message.split("\\n")[0]); }

  // FALLBACK: if the UI download didn't work, fetch the video by URL using the
  // page's authenticated session (so a UI miss never loses the video).
  if (!downloaded && result.src) {
    try {
      console.log("Falling back to URL download...");
      const cookieHeader = (await context.cookies()).map(c => \`\${c.name}=\${c.value}\`).join("; ");
      const resp = await page.request.get(result.src, { headers: { cookie: cookieHeader } });
      const buf  = await resp.body();
      if (resp.ok() && buf.length > 10000) {
        fs.writeFileSync(outPath, buf);
        console.log(\`✅ Saved (URL fallback): \${fileName} (\${(buf.length/1024/1024).toFixed(1)} MB)\`);
        console.log("__VIDEO__:" + fileName);
        downloaded = true;
      } else { console.log("URL fallback got HTTP " + resp.status() + ", " + buf.length + " bytes"); }
    } catch(e) { console.log("URL fallback failed:", e.message.split("\\n")[0]); }
  }

  if (!downloaded) {
    console.log("❌ Download failed. Video URL was:", result.src || "(none)");
    try { await page.screenshot({ path: path.join(OUTPUT_DIR, \`download_failed_\${JOB_ID}.png\`) }); } catch {}
  }

  await browser.close();
  console.log("Done.");
})();
`;
}

module.exports = { buildScript };
