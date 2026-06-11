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

// Normalize a media src to its stable id (the name= param) so cache-busting
// query params don't make the same video look "new".
function mediaId(src) {
  try { const u = new URL(src); return u.searchParams.get("name") || src; } catch { return src; }
}

async function listVideoIds(page) {
  const srcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).map(v => v.src).filter(Boolean));
  return srcs.map(mediaId);
}

async function waitForCompletion(page, maxSeconds = 480, preExisting = []) {
  console.log(\`Polling for completion... (\${preExisting.length} pre-existing video(s) on canvas will be ignored)\`);
  const known = new Set(preExisting);
  for (let s = 0; s < maxSeconds; s += 5) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate(() => {
      const body = document.body.innerText;
      const vids = Array.from(document.querySelectorAll('video')).map(v => v.src).filter(Boolean);
      return {
        isQueued:     body.includes("Queued"),
        isGenerating: !!document.querySelector('[class*="progress"],[class*="Progress"]') || /\\d+%/.test(body),
        isPolicy:     body.includes("violate our policies"),
        videoSrcs:    vids
      };
    });
    const fresh = state.videoSrcs.find(src => !known.has(mediaId(src)));
    console.log(\`  [\${s+5}s] queued=\${state.isQueued} gen=\${state.isGenerating} videos=\${state.videoSrcs.length} new=\${fresh ? "YES" : "no"}\`);
    if (state.isPolicy) { console.log("→ Policy violation"); return { status: "policy" }; }
    if (fresh && !state.isQueued && !state.isGenerating)
      { console.log("→ New video ready!"); return { status: "success", src: fresh }; }
  }
  return { status: "timeout" };
}

(async () => {
  // Must use headless: false — Google Flow UI does not fully render in headless mode
  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({ viewport: null, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });

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
    console.log("❌ Cookies expired!"); await browser.close(); process.exit(1);
  }

  // Keep retrying "Try Omni now" — it lives in a carousel that rotates slides,
  // so the button may not be visible on the first slide. Never fall back to "New project".
  {
    console.log("Looking for 'Try Omni now' button (carousel retry loop)...");
    let launched = false;
    const deadline = Date.now() + 60000; // try for up to 60 seconds
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

  // ── Image: write PNG to clipboard then paste directly into prompt box ──
  // (image paste now happens after the prompt composer is located — see below)

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

  // ── Locate the REAL prompt composer (not the top search box!) ──
  // Prefer placeholder/aria-label matching "create"; else the bottom-most textbox.
  async function getPromptBox() {
    const boxes = page.locator('[role="textbox"], textarea, [contenteditable="true"]');
    const n = await boxes.count();
    let best = null, bestY = -1;
    for (let i = 0; i < n; i++) {
      const el = boxes.nth(i);
      const bb = await el.boundingBox().catch(() => null);
      if (!bb || bb.width < 100) continue;
      const hint = ((await el.getAttribute("placeholder").catch(() => "")) || "") + " " +
                   ((await el.getAttribute("aria-label").catch(() => "")) || "") + " " +
                   ((await el.evaluate(e => e.dataset?.placeholder || e.textContent || "").catch(() => "")) || "");
      if (/what do you want|create|describe|prompt/i.test(hint)) {
        console.log(\`Prompt box matched by hint at y=\${Math.round(bb.y)}\`);
        return el;
      }
      if (bb.y > bestY) { bestY = bb.y; best = el; }
    }
    if (best) console.log(\`Prompt box = bottom-most textbox at y=\${Math.round(bestY)}\`);
    return best;
  }

  const promptBox = await getPromptBox();
  if (!promptBox) { console.log("❌ No prompt box found"); await browser.close(); process.exit(1); }
  await promptBox.click({ force: true });
  await page.waitForTimeout(300);

  // ── Attach reference image into the VERIFIED composer (clipboard paste) ──
  if (IMAGE_PATH) {
    console.log("Attaching image via clipboard paste:", IMAGE_PATH);
    try {
      const mimeType   = IMAGE_PATH.match(/\\.png$/i)  ? "image/png"  :
                         IMAGE_PATH.match(/\\.gif$/i)  ? "image/gif"  :
                         IMAGE_PATH.match(/\\.webp$/i) ? "image/webp" : "image/jpeg";
      const fileBuffer = fs.readFileSync(IMAGE_PATH);
      const base64Data = fileBuffer.toString("base64");
      console.log(\`Image mime: \${mimeType}, size: \${(fileBuffer.length/1024).toFixed(1)} KB\`);

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
        await promptBox.click({ force: true });
        await page.waitForTimeout(400);
        await page.keyboard.press("Control+V");
        await page.waitForTimeout(2500);
        const chip = await page.locator('[class*="attachment" i], [class*="chip" i], [role="textbox"] img').count();
        console.log(chip > 0 ? "✅ Image chip detected in prompt box" : "Paste sent — chip not detected, proceeding anyway");
      } else {
        console.log("Clipboard write failed:", clipResult.err, "— proceeding without image");
      }
    } catch(e) { console.log("Image paste error:", e.message); }
    await promptBox.click({ force: true });
    await page.waitForTimeout(300);
  }

  await page.keyboard.press("End");
  await page.waitForTimeout(200);

  // Type, then VERIFY the text actually landed; retry once, then fill() as last resort
  const readBack = () => promptBox.evaluate(e => e.value ?? e.innerText ?? "").catch(() => "");
  const probe = PROMPT.slice(0, 30);
  await page.keyboard.type(PROMPT, { delay: 8 });
  await page.waitForTimeout(500);
  let typed = await readBack();
  if (!typed.includes(probe)) {
    console.log(\`⚠️  Prompt not in box after typing (box has \${typed.length} chars) — refocusing and retyping\`);
    await promptBox.click({ force: true });
    await page.waitForTimeout(400);
    await page.keyboard.type(PROMPT, { delay: 8 });
    await page.waitForTimeout(500);
    typed = await readBack();
  }
  if (!typed.includes(probe)) {
    console.log("⚠️  Typing failed twice — using fill()");
    await promptBox.fill(PROMPT).catch(e => console.log("fill failed:", e.message));
    await page.waitForTimeout(500);
    typed = await readBack();
  }
  if (!typed.includes(probe)) { console.log("❌ Could not enter prompt text"); await browser.close(); process.exit(1); }
  console.log(\`✅ Prompt verified in composer: \${typed.length} chars\`);

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

  // Snapshot videos already on the canvas BEFORE generating — the reused
  // project shows old generations, and we must not mistake them for the new one.
  const preExisting = await listVideoIds(page);
  console.log(\`Pre-existing videos on canvas: \${preExisting.length}\`);

  console.log("Send button result:", JSON.stringify(sendClicked));
  console.log("Generate clicked ✓");

  // Verify SUBMISSION: composer should clear, or queue/progress should appear.
  // If not, fall back to pressing Enter in the composer (most reliable submit).
  console.log("Waiting for generation to start...");
  const genActivity = () => page.evaluate(() => {
    const body = document.body.innerText;
    return body.includes("Queued") ||
      !!document.querySelector('[class*="progress"],[class*="Progress"]') ||
      /\\d+%/.test(body);
  });
  let started = false;
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    for (let s = 0; s < 15 && !started; s += 3) {
      await page.waitForTimeout(3000);
      const stillTyped = (await readBack()).includes(probe);
      const newVid = (await listVideoIds(page)).some(id => !preExisting.includes(id));
      started = !stillTyped || newVid || (await genActivity());
    }
    if (!started) {
      console.log(\`⚠️  Not submitted (attempt \${attempt + 1}) — pressing Enter in composer\`);
      await promptBox.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
    }
  }
  if (!started) { console.log("❌ Prompt never submitted after 3 attempts"); await browser.close(); process.exit(1); }
  console.log("✅ Submission confirmed — generation in progress");

  const result = await waitForCompletion(page, 480, preExisting);
  if (result.status !== "success") {
    console.log(\`❌ Ended: \${result.status}\`);
    await browser.close(); process.exit(1);
  }
  console.log("New video URL:", result.src);

  // Download the NEW video directly by its URL (the UI's first card can be an
  // old video, so we never trust card order).
  let downloaded = false;
  try {
    const resp = await page.request.get(result.src);
    const buf  = await resp.body();
    if (buf.length < 100 * 1024) throw new Error(\`response too small (\${buf.length} bytes)\`);
    const fileName = \`flow_\${JOB_ID}.mp4\`;
    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), buf);
    console.log(\`✅ Saved: \${fileName} (\${(buf.length/1024/1024).toFixed(1)} MB)\`);
    console.log("__VIDEO__:" + fileName);
    downloaded = true;
  } catch(e) { console.log("Direct fetch failed:", e.message); }

  if (!downloaded) {
    try {
      // Fallback: UI download of the card whose <video> src matches the new id
      const newId = mediaId(result.src);
      const card = page.locator('video').filter({ has: page.locator(\`[src*="\${newId}"]\`) }).first()
        .locator('xpath=ancestor::*[contains(@class,"gouBtR")][1]');
      await card.waitFor({ timeout: 8000 });
      const box = await card.boundingBox();
      await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
      await page.waitForTimeout(1000);
      const dot = card.locator('button').filter({ hasText: 'more_vert' });
      await dot.waitFor({ timeout: 3000 });
      await dot.click();
      await page.waitForTimeout(800);
      const dlItem = page.locator('[data-radix-menu-content]').getByText('Download').first();
      await dlItem.waitFor({ timeout: 3000 });
      await dlItem.hover();
      await page.waitForTimeout(800);
      const dlPromise = page.waitForEvent("download", { timeout: 30000 });
      const item720 = page.locator('[data-radix-menu-content]').getByText('720p').first();
      if (await item720.count() > 0) { await item720.click(); }
      else { await page.locator('[data-radix-menu-content]').getByText('Original Size').first().click(); }
      const dl = await dlPromise;
      const fileName = dl.suggestedFilename() || \`flow_\${JOB_ID}.mp4\`;
      await dl.saveAs(path.join(OUTPUT_DIR, fileName));
      console.log(\`✅ Downloaded: \${fileName}\`);
      console.log("__VIDEO__:" + fileName);
      downloaded = true;
    } catch(e) { console.log("UI download failed:", e.message); }
  }

  if (!downloaded) { await browser.close(); process.exit(1); }

  await browser.close();
  console.log("Done.");
})();
`;
}

module.exports = { buildScript };