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

async function waitForCompletion(page, maxSeconds = 600, preExistingSrcs = []) {
  console.log("Polling for completion (ignoring " + preExistingSrcs.length + " pre-existing video(s))...");
  const known = new Set(preExistingSrcs);
  let failStreak = 0;          // consecutive checks that look failed
  for (let s = 0; s < maxSeconds; s += 5) {
    await page.waitForTimeout(5000);
    const state = await page.evaluate((knownArr) => {
      const known = new Set(knownArr);
      const body = document.body.innerText;
      const all = Array.from(document.querySelectorAll('video[src*="getMediaUrl"]'));
      const fresh = all.map(v => v.src).filter(src => !known.has(src));
      // progress indicators: a % anywhere, a progress bar, "Queued", "Generating"
      const pct = (body.match(/(\\d+)%/) || [])[1];
      const isGenerating = !!document.querySelector('[class*="progress"i],[role="progressbar"]')
                           || /Generating|Queued/i.test(body) || pct !== undefined;
      return {
        pct: pct ? Number(pct) : null,
        isQueued:     /Queued/i.test(body),
        isGenerating,
        isPolicy:     body.includes("violate our policies"),
        errText:      body.includes("unusual activity") || /\\bFailed\\b/.test(body),
        newVideo:     fresh.length > 0,
        newSrc:       fresh[0] || null,
        totalVideos:  all.length
      };
    }, [...known]);

    console.log(\`  [\${s+5}s] queued=\${state.isQueued} gen=\${state.isGenerating} pct=\${state.pct ?? "-"} newVideo=\${state.newVideo} total=\${state.totalVideos}\`);

    if (state.isPolicy) { console.log("→ Policy violation"); return { status: "policy" }; }

    // SUCCESS: a brand-new video exists and nothing is still rendering.
    if (state.newSrc && !state.isQueued && !state.isGenerating) {
      console.log("→ Success! (new video)");
      return { status: "success", src: state.newSrc };
    }

    // FAILURE is only real if the error text is present AND nothing is
    // generating AND no new video — for 3 checks in a row (~15s). This avoids
    // bailing on a stale "unusual activity" card while a video is at e.g. 46%.
    if (state.errText && !state.isGenerating && !state.newVideo) {
      failStreak++;
      if (failStreak >= 3) { console.log("→ Failed / unusual activity (persisted)"); return { status: "failed" }; }
    } else {
      failStreak = 0;   // generation is progressing — reset
    }
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
  if (IMAGE_PATH) {
    console.log("Attaching reference image:", IMAGE_PATH);
    const chipSel = '[class*="attachment" i],[class*="chip" i],[class*="thumbnail" i],[role="textbox"] img,img[src^="blob:"],img[src^="data:"]';
    const mimeType = IMAGE_PATH.match(/\\.png$/i) ? "image/png" :
                     IMAGE_PATH.match(/\\.gif$/i) ? "image/gif" :
                     IMAGE_PATH.match(/\\.webp$/i) ? "image/webp" : "image/jpeg";
    let attached = false;

    const chipCount = async () => page.locator(chipSel).count();

    // METHOD 1 (most reliable): a hidden <input type=file> — set it directly.
    try {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(IMAGE_PATH);
        await page.waitForTimeout(2500);
        if (await chipCount() > 0) { attached = true; console.log("✅ Image attached via hidden file input"); }
      }
    } catch(e) { console.log("file-input method:", e.message.split("\\n")[0]); }

    // METHOD 2: "Add Media" → intercept the file chooser → set the file.
    if (!attached) {
      try {
        const addBtn = page.locator('button:has-text("Add Media"), button:has-text("add_2"), button[aria-label*="add" i]').first();
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
          (async () => { try { await addBtn.click({ timeout: 4000 }); } catch {} })()
        ]);
        if (chooser) {
          await chooser.setFiles(IMAGE_PATH);
          await page.waitForTimeout(2500);
          if (await chipCount() > 0) { attached = true; console.log("✅ Image attached via Add Media chooser"); }
        } else {
          // the menu may have a sub-item; click an "Upload" entry then retry chooser
          const up = page.locator('[role="menuitem"]:has-text("Upload"), :text("Upload from computer")').first();
          if (await up.count() > 0) {
            const [c2] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 6000 }).catch(() => null),
              up.click({ timeout: 4000 }).catch(() => {})
            ]);
            if (c2) { await c2.setFiles(IMAGE_PATH); await page.waitForTimeout(2500);
              if (await chipCount() > 0) { attached = true; console.log("✅ Image attached via Upload menu"); } }
          }
        }
      } catch(e) { console.log("add-media method:", e.message.split("\\n")[0]); }
    }

    // METHOD 3: clipboard paste (the manual method) + synthetic paste fallback.
    if (!attached) {
      try {
        const base64Data = fs.readFileSync(IMAGE_PATH).toString("base64");
        const promptEl = page.locator('[role="textbox"]').first();
        await promptEl.click({ force: true });
        await page.waitForTimeout(400);
        const ok = await page.evaluate(async ({ base64Data, mimeType }) => {
          try {
            const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
            await navigator.clipboard.write([new ClipboardItem({ [mimeType]: new Blob([bytes], { type: mimeType }) })]);
            return true;
          } catch { return false; }
        }, { base64Data, mimeType });
        if (ok) { await promptEl.click({ force: true }); await page.keyboard.press("Control+V"); await page.waitForTimeout(2500); }
        if (await chipCount() > 0) { attached = true; console.log("✅ Image attached via clipboard paste"); }

        if (!attached) {
          await promptEl.click({ force: true });
          await page.evaluate(async ({ base64Data, mimeType }) => {
            const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
            const file = new File([bytes], "ref.png", { type: mimeType });
            const dt = new DataTransfer(); dt.items.add(file);
            const el = document.querySelector('[role="textbox"]') || document.activeElement;
            el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
          }, { base64Data, mimeType });
          await page.waitForTimeout(2500);
          if (await chipCount() > 0) { attached = true; console.log("✅ Image attached via synthetic paste"); }
        }
      } catch(e) { console.log("clipboard method:", e.message.split("\\n")[0]); }
    }

    if (!attached) {
      console.log("⚠️  IMAGE NOT ATTACHED by any method — generation may fail. Saving screenshot.");
      try { await page.screenshot({ path: path.join(OUTPUT_DIR, \`no_image_\${JOB_ID}.png\`) }); } catch {}
    }
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

  const result = await waitForCompletion(page, 600, preExistingSrcs);
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

  // STRATEGY 1 (PRIMARY): the real UI download — hover the new video card,
  // open its ⋮ menu, click Download, pick 720p / Original Size.
  try {
    const vid = nameParam
      ? page.locator(\`video[src*="\${nameParam}"]\`).first()
      : page.locator('video[src*="getMediaUrl"]').first();
    await vid.scrollIntoViewIfNeeded().catch(() => {});
    const vbox = await vid.boundingBox();
    if (vbox) { await page.mouse.move(vbox.x + vbox.width/2, vbox.y + vbox.height/2, { steps: 6 }); await page.waitForTimeout(1200); }

    // The ⋮ "more" button on that video's card
    const dot = page.locator('button:has-text("more_vert"), button[aria-label*="more" i], button[aria-label*="option" i]').last();
    await dot.click({ timeout: 5000 });
    await page.waitForTimeout(900);

    const dlPromise = page.waitForEvent("download", { timeout: 60000 });
    // Click "Download" (opens the resolution submenu)
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
    } else { console.log("UI download produced an empty file — falling back"); }
  } catch(e) { console.log("UI menu download failed:", e.message.split("\\n")[0]); }

  // STRATEGY 2 (FALLBACK): authenticated request-context fetch of the media URL.
  if (!downloaded && result.src) {
    try {
      const cookieHeader = (await context.cookies()).map(c => \`\${c.name}=\${c.value}\`).join("; ");
      const resp = await page.request.get(result.src, { headers: { cookie: cookieHeader } });
      const buf  = await resp.body();
      if (resp.ok() && buf.length > 10000) {
        fs.writeFileSync(outPath, buf);
        console.log(\`✅ Saved (request ctx): \${fileName} (\${(buf.length/1024/1024).toFixed(1)} MB)\`);
        console.log("__VIDEO__:" + fileName);
        downloaded = true;
      } else { console.log("request ctx got HTTP " + resp.status() + ", " + buf.length + " bytes"); }
    } catch(e) { console.log("request-context fetch failed:", e.message); }
  }

  if (!downloaded) {
    console.log("❌ All download methods failed. Video URL was:", result.src || "(none)");
    try { await page.screenshot({ path: path.join(OUTPUT_DIR, \`download_failed_\${JOB_ID}.png\`) }); } catch {}
  }

  await browser.close();
  console.log("Done.");
})();
`;
}

module.exports = { buildScript };