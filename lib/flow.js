const path = require("path");

function buildScript({ cookiesPath, imagePath, prompt, aspectRatio, speed, duration, jobId }) {
  const absCookies = JSON.stringify(path.resolve(cookiesPath));
  const absImage   = imagePath ? JSON.stringify(path.resolve(imagePath)) : "null";
  const absOutput  = JSON.stringify(path.resolve(__dirname, "..", "outputs"));
  const safePrompt = prompt.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `
const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

const HOME_URL   = "https://labs.google/fx/tools/flow";
const PROMPT     = \`${safePrompt}\`;
const ASPECT     = ${JSON.stringify(aspectRatio)};
const SPEED      = ${JSON.stringify(speed)};
const DURATION   = ${JSON.stringify(duration)};
const OUTPUT_DIR = ${absOutput};
const JOB_ID     = ${JSON.stringify(jobId)};
const IMAGE_PATH = ${absImage};

async function waitForCompletion(page, maxSeconds = 300, preExistingSrcs = []) {
  console.log("Polling for completion (ignoring " + preExistingSrcs.length + " pre-existing video(s))...");
  const known        = new Set(preExistingSrcs);
  const preVidCount  = preExistingSrcs.length;
  // Never flag failure in the first 45s — Flow takes time to render the new
  // card and the "Failed" text from OLD cards on canvas causes false positives.
  const GRACE_SECS   = 45;
  // Require failure text to appear on 3 consecutive polls before giving up.
  let failStreak     = 0;
  const FAIL_STREAK_NEEDED = 3;

  for (let s = 0; s < maxSeconds; s += 5) {
    await page.waitForTimeout(5000);

    const state = await page.evaluate((knownArr) => {
      const known = new Set(knownArr);
      const body  = document.body.innerText;

      const allVids   = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]'));
      const freshVids = allVids.map(v => v.src).filter(src => !known.has(src));

      // Any spinner / progress bar / percentage = actively generating
      const hasProgress = !!document.querySelector('[class*="progress" i],[class*="Progress"]')
                       || !!document.querySelector('[class*="shimmer" i],[class*="skeleton" i],[class*="spinner" i],[class*="loading" i]')
                       || /\d+%/.test(body);

      // Total video count (including loading placeholders that briefly have a src)
      const totalVidEls = allVids.length;

      return {
        isQueued:    body.includes("Queued"),
        isProgress:  hasProgress,
        isPolicy:    body.includes("violate our policies"),
        hasFailed:   body.includes("Failed") || body.includes("unusual activity"),
        freshCount:  freshVids.length,
        newSrc:      freshVids[0] || null,
        totalVidEls
      };
    }, [...known]);

    const elapsed = s + 5;
    const inGrace = elapsed <= GRACE_SECS;

    // isGenerating = spinner visible OR total video count grew (new card appeared
    // even if its src is not yet a getMediaUrl link)
    const isGenerating = state.isProgress || state.totalVidEls > preVidCount;

    console.log(\`  [\${elapsed}s] queued=\${state.isQueued} progress=\${state.isProgress} vids=\${state.totalVidEls}(pre=\${preVidCount}) fresh=\${state.freshCount} failed=\${state.hasFailed} grace=\${inGrace} streak=\${failStreak}\`);

    if (state.isPolicy) { console.log("-> Policy violation"); return { status: "policy" }; }

    // Count consecutive failure signals, but only outside grace period and
    // only when nothing is actively generating or queued
    if (!inGrace && state.hasFailed && !state.isQueued && !isGenerating && state.freshCount === 0) {
      failStreak++;
      console.log(\`-> Failure signal \${failStreak}/\${FAIL_STREAK_NEEDED}\`);
      if (failStreak >= FAIL_STREAK_NEEDED) {
        console.log("-> Failed (confirmed after " + FAIL_STREAK_NEEDED + " polls)");
        return { status: "failed" };
      }
    } else {
      failStreak = 0; // reset if any positive signal appears
    }

    // Success: a brand-new video src exists and nothing is still rendering
    if (state.newSrc && !state.isQueued && !state.isProgress) {
      console.log("-> Success! new video: " + state.newSrc.slice(0, 60));
      return { status: "success", src: state.newSrc };
    }
  }
  return { status: "timeout" };
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({ viewport: null, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://labs.google" }).catch(() => {});

  const raw = JSON.parse(fs.readFileSync(${absCookies}, "utf8"));
  await context.addCookies(raw.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
    expires: c.expirationDate || -1, httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: c.sameSite === "strict" ? "Strict" : c.sameSite === "none" ? "None" : "Lax"
  })));

  const page = await context.newPage();
  await page.goto(HOME_URL, { waitUntil: "networkidle" });
  console.log("Homepage opened");
  await page.waitForTimeout(3000);

  if (page.url().includes("accounts.google.com")) {
    console.log("Cookies expired!"); await browser.close(); process.exit(1);
  }

  // Carousel retry loop for "Try Omni now"
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
      console.log("Could not find 'Try Omni now' after 60s -- aborting");
      await browser.close(); process.exit(1);
    }
  }
  await page.waitForURL("**/flow/project/**", { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log("Project loaded:", page.url());

  async function ensureCanvas() {
    const m = page.url().match(/(https:\\/\\/labs\\.google\\/fx\\/tools\\/flow\\/project\\/[a-z0-9-]+)/i);
    if (!m) return;
    const clean = m[1];
    if (page.url() !== clean) {
      console.log("Not on canvas (" + page.url() + ") -- navigating to", clean);
      await page.goto(clean, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
    }
  }
  await ensureCanvas();
  console.log("Canvas ready:", page.url());

  // Dismiss modals
  try {
    const agreeBtn = page.locator('button:has-text("I agree")').first();
    await agreeBtn.waitFor({ timeout: 8000 });
    await agreeBtn.click();
    console.log("Clicked 'I agree' on Notice modal");
    await page.waitForTimeout(1000);
  } catch { console.log("No Notice modal"); }

  try {
    const gotIt = page.locator('button:has-text("Got it")').first();
    await gotIt.waitFor({ timeout: 8000 });
    await gotIt.click();
    console.log("Dismissed 'Got it' modal");
    await page.waitForTimeout(1000);
  } catch { console.log("No 'Got it' modal"); }

  // Image attachment via clipboard paste
  if (IMAGE_PATH) {
    console.log("Attaching image via clipboard paste:", IMAGE_PATH);
    try {
      const mimeType   = IMAGE_PATH.match(/\\.png$/i)  ? "image/png"  :
                         IMAGE_PATH.match(/\\.gif$/i)  ? "image/gif"  :
                         IMAGE_PATH.match(/\\.webp$/i) ? "image/webp" : "image/jpeg";
      const fileBuffer = fs.readFileSync(IMAGE_PATH);
      const base64Data = fileBuffer.toString("base64");
      console.log(\`Image mime: \${mimeType}, size: \${(fileBuffer.length/1024).toFixed(1)} KB\`);

      const promptEl = page.locator('[role="textbox"]').first();
      await promptEl.waitFor({ timeout: 10000 });
      await promptEl.click({ force: true });
      await page.waitForTimeout(500);
      console.log("Prompt box focused");

      const clipResult = await page.evaluate(async ({ base64Data, mimeType }) => {
        try {
          const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
          const blob  = new Blob([bytes], { type: mimeType });
          await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
          return { ok: true };
        } catch(e) { return { ok: false, err: e.message }; }
      }, { base64Data, mimeType });

      console.log("Clipboard write:", JSON.stringify(clipResult));

      if (clipResult.ok) {
        // ONE paste only -- clipboard succeeded, do not also do synthetic paste
        await promptEl.click({ force: true });
        await page.waitForTimeout(400);
        await page.keyboard.press("Control+V");
        await page.waitForTimeout(2000);
        const chip = await page.locator('[class*="attachment" i], [class*="chip" i], [role="textbox"] img, img[src^="blob:"], img[src^="data:"]').count();
        console.log("Paste sent -- chip detected: " + chip + (chip > 0 ? " OK" : " (may render late)"));
      } else {
        // Clipboard API failed -- fall back to synthetic DataTransfer paste
        console.log("Clipboard write failed:", clipResult.err, "-- trying synthetic paste");
        await promptEl.click({ force: true });
        await page.waitForTimeout(300);
        const pasted = await page.evaluate(async ({ base64Data, mimeType }) => {
          try {
            const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
            const file = new File([bytes], "ref." + (mimeType.split("/")[1] || "png"), { type: mimeType });
            const dt = new DataTransfer();
            dt.items.add(file);
            const el = document.querySelector('[role="textbox"]') || document.activeElement;
            const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
            el.dispatchEvent(ev);
            return true;
          } catch (e) { return false; }
        }, { base64Data, mimeType });
        await page.waitForTimeout(2500);
        const chip = await page.locator('[class*="attachment" i], [class*="chip" i], [role="textbox"] img, img[src^="blob:"], img[src^="data:"]').count();
        console.log("Synthetic paste " + (pasted ? "sent" : "failed") + " -- chip: " + chip + (chip > 0 ? " OK" : " not detected"));
      }
    } catch(e) {
      console.log("Image paste error:", e.message);
    }
    await page.waitForTimeout(500);
  }

  // Settings
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
    console.log(\`Tab not found: "\${name}" -- available: [\${allTabs.map(t=>t?.trim()).join(", ")}]\`);
    return false;
  }

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
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  await ensureCanvas();
  console.log("Settings done");

  // Type prompt (keyboard.type preserves any pasted image chip)
  const promptBox = page.locator('[role="textbox"]').first();
  await promptBox.waitFor({ timeout: 10000 });
  await promptBox.click({ force: true });
  await page.waitForTimeout(300);
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  await page.keyboard.type(PROMPT, { delay: 8 });
  await page.waitForTimeout(500);
  console.log(\`Prompt typed: \${PROMPT.length} chars\`);

  // Snapshot pre-existing video srcs AND card count before generating
  const { preExistingSrcs, preCardCount } = await page.evaluate(() => {
    const srcs = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]')).map(v => v.src);
    const cards = document.querySelectorAll(
      '[class*="MediaCard" i], [class*="media-card" i], [class*="CardContainer" i], [class*="card-container" i], [class*="asset" i]'
    ).length;
    return { preExistingSrcs: srcs, preCardCount: cards };
  });
  console.log(\`Pre-existing: \${preExistingSrcs.length} videos, \${preCardCount} cards\`);

  // Click send button
  const sendClicked = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    const arrowBtn = allBtns.find(b => {
      const t = b.textContent || "";
      return t.includes("arrow_forward") && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    });
    if (arrowBtn) {
      const r = arrowBtn.getBoundingClientRect();
      arrowBtn.click();
      return { found: true, method: "arrow_forward", x: r.x, y: r.y };
    }
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
  console.log("Generate clicked");

  console.log("Waiting for generation to start...");
  await page.waitForTimeout(4000);

  const result = await waitForCompletion(page, 300, preExistingSrcs);
  if (result.status !== "success") {
    console.log(\`Ended: \${result.status}\`);
    await browser.close(); process.exit(1);
  }
  console.log("Video URL:", result.src);

  // Download
  let downloaded = false;
  const fileName = \`flow_\${JOB_ID}.mp4\`;
  const outPath  = path.join(OUTPUT_DIR, fileName);

  // STRATEGY 1: UI download — hover the new video card, click ⋮, Download -> 720p
  try {
    // Find the <video> element with the new src, scroll it into view, hover it
    const newVid = page.locator(\`video[src*="getMediaUrl"]\`).filter({ has: page.locator(\`[src="\${result.src}"]\`) }).first();
    // Fallback: just use the video whose src matches
    const vidLocator = page.locator(\`video\`).filter({ hasAttribute: ['src', result.src] }).first();

    // Locate by src attribute directly
    const vidEl = page.locator(\`video[src="\${result.src}"]\`);
    const vidCount = await vidEl.count();
    console.log(\`Video element by src: \${vidCount}\`);

    // Hover the video itself to reveal the card overlay buttons
    const targetVid = vidCount > 0 ? vidEl.first() : page.locator('video[src*="getMediaUrl"]').last();
    await targetVid.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const vidBox = await targetVid.boundingBox();
    if (!vidBox) throw new Error("Could not get video bounding box");

    // Hover centre of the video card to reveal the ⋮ button
    await page.mouse.move(vidBox.x + vidBox.width / 2, vidBox.y + vidBox.height / 2);
    await page.waitForTimeout(1000);

    // The ⋮ button appears as a button containing "more_vert" (Material icon text)
    // It is positioned near the top-right of the card. Try several selectors.
    const dotBtn = page.locator('button:has-text("more_vert")').first();
    await dotBtn.waitFor({ timeout: 5000 });
    await dotBtn.click();
    console.log("Clicked ⋮ menu");
    await page.waitForTimeout(800);

    // Click "Download" menu item to open resolution submenu
    const dlItem = page.getByRole('menuitem', { name: /download/i }).first();
    await dlItem.waitFor({ timeout: 5000 });
    await dlItem.hover();
    console.log("Hovered Download");
    await page.waitForTimeout(800);

    // Pick 720p (Original Size label shown next to it in the UI)
    const dlPromise = page.waitForEvent("download", { timeout: 45000 });
    const item720 = page.getByRole('menuitem', { name: /720p/i }).first();
    if (await item720.count() > 0) {
      console.log("Clicking 720p");
      await item720.click();
    } else {
      // Fallback to any "Original Size" or "1080p" option
      const fallbackItem = page.getByRole('menuitem', { name: /original size|1080p/i }).first();
      console.log("720p not found, clicking fallback resolution");
      await fallbackItem.click();
    }

    const dl = await dlPromise;
    await dl.saveAs(outPath);
    console.log(\`Downloaded (UI 720p): \${fileName}\`);
    console.log("__VIDEO__:" + fileName);
    downloaded = true;
  } catch (e) {
    console.log("UI download failed:", e.message, "-- trying DOM fetch fallback");
  }

  // STRATEGY 2: DOM fetch fallback
  if (!downloaded) {
    try {
      const response = await page.request.get(result.src);
      const buffer = await response.body();
      fs.writeFileSync(outPath, buffer);
      console.log(\`Saved (DOM fetch): \${fileName} (\${(buffer.length / 1024 / 1024).toFixed(1)} MB)\`);
      console.log("__VIDEO__:" + fileName);
      downloaded = true;
    } catch (e) {
      console.error("DOM fetch failed:", e.message);
    }
  }

  if (!downloaded) {
    console.log("All download methods failed. Video URL was:", result.src || "(none)");
    try { await page.screenshot({ path: path.join(OUTPUT_DIR, \`download_failed_\${JOB_ID}.png\`) }); } catch {}
  }

  await browser.close();
  console.log("Done.");
})();
`;
}

module.exports = { buildScript };