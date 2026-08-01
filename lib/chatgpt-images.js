// lib/chatgpt-images.js (FINAL VERSION - FULL PARTS, NO STYLE LINE)
// ============================================================================
// Creates a FRESH ChatGPT account (via mail.tm temp email), opens a chat, and
// generates per-part images + thumbnail for one video, then returns them.
//
// FINAL: Sends COMPLETE part descriptions to ChatGPT (all scenes preserved)
// WITHOUT the style instruction line - just the raw scene descriptions.
// ============================================================================

const { chromium } = require("playwright");
const hostingerMail = require("./hostinger-mail");
const hostingerApi = require("./hostinger-api");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- EDITABLE SELECTORS (tune these against the live site) ------------------
const SEL = {
  signupUrl: "https://chat.openai.com/auth/login",
  signupButton: 'button:has-text("Sign up"), [data-testid="signup-button"], a:has-text("Sign up")',
  emailInput: 'input[name="email"], input[type="email"], input[id="email-input"]',
  emailContinue: 'button[type="submit"], button:has-text("Continue")',
  passwordInput: 'input[name="password"], input[type="password"]',
  passwordContinue: 'button[type="submit"], button:has-text("Continue")',
  otpInput: 'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]',
  otpContinue: 'button[type="submit"], button:has-text("Continue")',
  nameInput: 'input[name="name"], input[placeholder*="Full name" i], input[autocomplete="name"]',
  ageInput: 'input[name="age"], input[placeholder*="Age" i], input[type="number"]',
  finishButton: 'button:has-text("Finish creating account"), button:has-text("Finish"), button[type="submit"]',
  chatInput: '#prompt-textarea, textarea[data-id], textarea, div#prompt-textarea[contenteditable="true"]',
  sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"], button:has-text("Send"), button[data-testid="send-button-experimental"]',
  generatedImage: 'img[alt*="Generated"], .markdown img, img[src*="oaiusercontent"]',
  attachButton: 'button[aria-label*="Attach"]',
  fileInput: 'input[type="file"]'
};

const OTP_TIMEOUT = 120000;

// ============================================================================
// Extract FULL part description preserving all scene details
// Removes ONLY the PART header and metadata lines
// No added style instructions - just the raw prompt content
// ============================================================================
function extractPartDescription(partText) {
  // Remove the "PART N (X-Y sec) — Title" header line
  let text = String(partText || "")
    .replace(/^PART\s*\d+\s*\([^)]*\)\s*[-–—]?\s*[^\n]*/i, "")
    .trim();

  // Keep ALL content EXCEPT metadata lines (On-Screen Text, Effects, Transition, Voiceover)
  const scenes = text.split("\n")
    .filter(line => {
      const trimmed = line.trim();
      // Skip metadata lines only
      return trimmed &&
             !trimmed.match(/^(On-Screen Text|Effects|Transition|Voiceover|Voice-over)[:\s]/i);
    })
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n");  // Preserve line breaks for readability

  return scenes;
}

// ============================================================================
// Generate ALL images for one video in a single fresh account/session
// PART-WISE: Generate ONE image per part sequentially, then thumbnail
// Returns { part1.png, part2.png, ..., thumb.png } (dataURLs)
// ============================================================================
async function generateAllImages({ parts, partPrompts, thumbnailPrompt, referenceImagePath, orderId, log = () => {} }) {
  const result = { images: {}, error: null };
  let context, page, userDataDir, createdMailbox = null;
  if (!orderId && !process.env.HOSTINGER_ORDER_ID) {
    result.error = "no Hostinger mail order configured (need orderId for mailbox creation)";
    log("warn", `⚠️ ${result.error} — falling back to reference image`);
    return result;
  }
  try {
    log("info", "🌐 launching Chromium (fresh session) for ChatGPT image session");
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgpt-"));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 800 },
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check"
      ],
      ignoreDefaultArgs: ["--enable-automation"]
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    page = context.pages()[0] || await context.newPage();

    log("info", "📧 creating throwaway mailbox (Hostinger)…");
    createdMailbox = await hostingerApi.createMailbox(orderId);
    const aliasEmail = createdMailbox.address;
    const mailboxPassword = createdMailbox.password;
    const signupStartMs = Date.now();
    log("info", `📧 mailbox: ${aliasEmail}`);
    const password = "Aa1!" + Math.random().toString(36).slice(2, 12);

    await new Promise(r => setTimeout(r, 8000));

    log("info", "📝 entering email on ChatGPT");
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    try { await clickAny(page, 'button:has-text("Sign up for free"), button:has-text("Log in")'); } catch {}
    await fillAny(page, SEL.emailInput, aliasEmail);
    await clickAny(page, SEL.emailContinue);
    try {
      await fillAny(page, SEL.passwordInput, password);
      await clickAny(page, SEL.passwordContinue);
      log("info", "🔐 set account password");
    } catch { log("info", "no password step — expecting an email code/link"); }

    log("info", "⏳ reading OTP from mailbox (IMAP)…");
    const mail = await hostingerMail.readOTP({
      address: aliasEmail, password: mailboxPassword,
      fromContains: "openai", sinceMs: signupStartMs,
      timeoutMs: OTP_TIMEOUT, log
    });
    if (mail.otp) {
      log("info", `🔑 OTP: ${mail.otp}`);
      await fillAny(page, SEL.otpInput, mail.otp);
      await clickAny(page, SEL.otpContinue);
    } else if (mail.link) {
      log("info", `🔗 verification link: ${mail.link}`);
      await page.goto(mail.link, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      throw new Error("no OTP or verification link found in mailbox");
    }

    try {
      await page.waitForTimeout(3000);
      const nameEl = await Promise.race([
        firstVisible(page, SEL.nameInput, 40000).then(e => ({ kind: "name", e })).catch(() => null),
        firstVisible(page, SEL.chatInput, 40000).then(e => ({ kind: "chat", e })).catch(() => null)
      ]);
      if (nameEl && nameEl.kind === "name") {
        const names = ["Aarav Sharma", "Priya Nair", "Rohan Mehta", "Anaya Iyer", "Kabir Reddy", "Diya Kapoor", "Arjun Rao", "Isha Verma"];
        const fullName = names[Math.floor(Math.random() * names.length)];
        await fillAny(page, SEL.nameInput, fullName);

        const year = 1988 + Math.floor(Math.random() * 12);
        const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
        const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");

        let filledAge = false;
        try {
          const dob = page.locator('input[name="birthday"], input[type="date"], input[placeholder*="Birth" i], input[placeholder*="DD" i], input[placeholder*="MM" i]').first();
          if (await dob.isVisible()) {
            const type = await dob.getAttribute("type");
            await dob.click();
            if (type === "date") {
              await dob.fill(`${year}-${month}-${day}`);
            } else {
              await page.keyboard.type(`${month}${day}${year}`, { delay: 80 });
            }
            filledAge = true;
            log("info", `👤 profile: ${fullName}, DOB ${day}/${month}/${year}`);
          }
        } catch {}

        if (!filledAge) {
          try {
            const age = String(24 + Math.floor(Math.random() * 15));
            await fillAny(page, SEL.ageInput, age);
            filledAge = true;
            log("info", `👤 profile: ${fullName}, age ${age}`);
          } catch (e) { log("warn", `age/dob fill failed: ${e.message}`); }
        }
        await page.waitForTimeout(1500);
      } else {
        log("info", "no profile screen appeared — proceeding to chat");
      }
    } catch (e) {
      log("info", `profile step note: ${e.message}`);
    }

    log("info", `📍 after signup, url: ${page.url()}`);

    const redirectDeadline = Date.now() + 60000;
    while (Date.now() < redirectDeadline && /auth\.openai\.com|about-you|email-verification/.test(page.url())) {
      for (const label of ['button:has-text("Continue")', 'button:has-text("Finish creating account")', 'button:has-text("Finish")', 'button:has-text("Next")', 'button[type="submit"]']) {
        try { const b = page.locator(label).first(); if (await b.isVisible()) { await b.click(); log("info", `clicked ${label}`); await page.waitForTimeout(3000); break; } } catch {}
      }
      await page.waitForTimeout(4000);
    }
    log("info", `📍 post-redirect url: ${page.url()}`);

    await page.waitForTimeout(6000);
    log("info", "⏳ waiting for 'You're all set' screen...");

    try {
      const continueBtn = page.locator('button:has-text("Continue")').first();
      if (await continueBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        log("info", `✓ found 'Continue' button, clicking it`);
        await continueBtn.click();
        await page.waitForTimeout(3000);
      } else {
        log("info", `no 'Continue' button found, proceeding to chat check`);
      }
    } catch (e) {
      log("info", `Continue button step: ${e.message}`);
    }

    const chatDeadline = Date.now() + 90000;
    let chatReady = false;
    while (Date.now() < chatDeadline && !chatReady) {
      try {
        const ci = page.locator(SEL.chatInput).first();
        const isVisible = await ci.isVisible().catch(() => false);
        const exists = await ci.evaluate(el => !!el).catch(() => false);
        if (isVisible || exists) { 
          chatReady = true; 
          log("info", "💬 chat input found (visible: " + isVisible + ", exists: " + exists + ")");
          break; 
        }
      } catch {}
      let acted = false;
      for (const label of [
        'button:has-text("Continue")',
        'button:has-text("Okay, let\u2019s go")',
        'button:has-text("Okay")',
        'button:has-text("Got it")',
        'button:has-text("Start")',
        'button:has-text("Next")',
        'button:has-text("Done")',
        '[aria-label="Close"]'
      ]) {
        try {
          const b = page.locator(label).first();
          if (await b.isVisible()) { await b.click(); log("info", `advanced: ${label}`); acted = true; await page.waitForTimeout(2500); break; }
        } catch {}
      }
      if (!acted) await page.waitForTimeout(2000);
    }

    const loggedOut = await page.locator('button:has-text("Log in"), button:has-text("Sign up for free")').first().isVisible().catch(() => false);
    if (loggedOut) throw new Error("account not logged in after signup (still shows Log in / Sign up)");

    if (chatReady) {
      log("info", "💬 chat ready (logged in)");
    } else {
      const tas = await page.$$eval("textarea, div[contenteditable='true'], button", els => els.slice(0, 30).map(e => ({ tag: e.tagName, id: e.id, testid: e.getAttribute("data-testid"), ph: e.getAttribute("placeholder"), text: (e.innerText || "").slice(0, 20) })));
      log("warn", `chat not ready after timeout. elements on page: ${JSON.stringify(tas)}`);
      try {
        const finalCheck = await page.locator('#prompt-textarea').first().evaluate(el => !!el).catch(() => false);
        if (finalCheck) {
          log("info", "💬 chat input #prompt-textarea found on final check");
          chatReady = true;
        }
      } catch (e) {
        log("warn", `final check failed: ${e.message}`);
      }
      if (!chatReady) throw new Error("chat input never appeared");
    }

    // ========================================================================
    // PART-WISE image generation: one image per part, sequentially
    // Send FULL part description (all scenes) to ChatGPT
    // ========================================================================
    for (let i = 0; i < parts; i++) {
      const partNum = i + 1;
      const partPrompt = partPrompts[i];
      if (!partPrompt) {
        log("warn", `🖼️ part ${partNum} has no prompt — skipping`);
        continue;
      }
      log("info", `🖼️ generating part ${partNum}/${parts} image…`);
      
      // Attach reference image ONCE at the very beginning
      if (referenceImagePath && i === 0) {
        try { await attachFile(page, referenceImagePath, log); }
        catch (e) { log("warn", `could not attach reference image: ${e.message}`); }
      }
      
      const img = await generateOneImage(page, partPrompt, log, partNum);
      if (img) {
        result.images[`part${partNum}.png`] = img;
      } else {
        log("warn", `🖼️ part ${partNum} image generation failed`);
      }
    }

    // ========================================================================
    // Generate thumbnail AFTER all parts
    // ========================================================================
    if (thumbnailPrompt) {
      log("info", "🖼️ generating thumbnail…");
      const t = await generateOneImage(page, thumbnailPrompt, log, "thumb");
      if (t) {
        result.images["thumb.png"] = t;
      } else {
        log("warn", "🖼️ thumbnail generation failed");
        result.thumbnailFailed = true;   // signal caller to retry with a new account
      }
    }

    log("success", `✅ generated ${Object.keys(result.images).length} image(s) (${parts} part(s) + thumbnail)`);
  } catch (e) {
    result.error = e.message;
    log("warn", `⚠️ ChatGPT image session failed: ${e.message} — caller will fall back to reference image`);
  } finally {
    try { await context?.close(); } catch {}
    try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    if (createdMailbox && createdMailbox.id) {
      try { await hostingerApi.deleteMailbox(createdMailbox.id); log("info", `🗑️ deleted mailbox ${createdMailbox.address}`); }
      catch (e) { log("warn", `could not delete mailbox ${createdMailbox.address}: ${e.message}`); }
    }
  }
  return result;
}

// --- helpers ---
function splitSel(sel) { return sel.split(",").map(s => s.trim()).filter(Boolean); }

async function firstVisible(page, sel, timeout = 30000) {
  const parts = splitSel(sel);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const p of parts) {
      const el = page.locator(p).first();
      try { if (await el.isVisible()) return el; } catch {}
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`no visible element for any of: ${sel}`);
}

async function clickAny(page, sel) {
  const el = await firstVisible(page, sel);
  await page.waitForTimeout(400 + Math.floor(Math.random() * 700));
  await el.hover().catch(() => {});
  await page.waitForTimeout(150 + Math.floor(Math.random() * 300));
  await el.click();
  await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
}

async function fillAny(page, sel, val) {
  const el = await firstVisible(page, sel);
  try { await el.click({ timeout: 3000 }); }
  catch { await el.focus().catch(() => {}); }
  await el.evaluate(node => node.focus());
  try { await el.fill(""); } catch {}
  try {
    await el.evaluate(node => {
      if (node.contentEditable === 'true') {
        node.textContent = '';
      }
    });
  } catch {}
  // Type character by character, but insert newlines as Shift+Enter so a
  // multi-line prompt (part text has many lines) does NOT get submitted on the
  // first line — plain Enter in ChatGPT's box sends the message immediately.
  const text = String(val);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    } else if (ch === "\r") {
      continue; // ignore carriage returns
    } else {
      await page.keyboard.type(ch, { delay: 15 + Math.floor(Math.random() * 40) });
    }
  }
  await page.waitForTimeout(300 + Math.floor(Math.random() * 400));
}

async function attachFile(page, filePath, log) {
  try {
    const input = page.locator(SEL.fileInput).first();
    await input.setInputFiles(filePath);
    await page.waitForTimeout(3000);
    log("info", "📎 attached reference image");
  } catch (e) { log("warn", `could not attach reference image: ${e.message}`); }
}

async function generateOneImage(page, prompt, log, identifier = "") {
  const before = await page.locator(SEL.generatedImage).count().catch(() => 0);
  const label = identifier ? ` (part ${identifier})` : "";

  await fillAny(page, SEL.chatInput, prompt);
  await clickAny(page, SEL.sendButton);

  const deadline = Date.now() + 240000;
  let appeared = false;
  while (Date.now() < deadline) {
    const now = await page.locator(SEL.generatedImage).count().catch(() => 0);
    if (now > before) { appeared = true; break; }
    await page.waitForTimeout(2000);
  }
  if (!appeared) { log("warn", `⏳ no new image appeared in time${label}`); return null; }

  let src = null;
  const loadDeadline = Date.now() + 60000;
  while (Date.now() < loadDeadline) {
    src = await page.locator(SEL.generatedImage).last().getAttribute("src").catch(() => null);
    if (src && !src.startsWith("blob:") && (src.startsWith("data:") || /oaiusercontent|http/.test(src))) break;
    await page.waitForTimeout(2000);
  }
  if (!src) { log("warn", `no usable image src${label}`); return null; }

  try {
    if (src.startsWith("data:")) return src;
    const resp = await page.request.get(src);
    const buf = await resp.body();
    log("success", `✅ image ready${label}`);
    return "data:image/png;base64," + buf.toString("base64");
  } catch (e) {
    log("warn", `image download failed${label}: ${e.message}`);
    return null;
  }
}

module.exports = { generateAllImages, extractPartDescription, SEL };
