/**
 * login-once.js — set up a persistent Chrome profile for ONE client's Google
 * account so it stays logged into Google Flow forever (no daily cookie expiry).
 *
 * Run ONCE per client:
 *     node login-once.js <clientId>
 *
 *  - <clientId> is the client's id from Supabase (same id used everywhere).
 *  - A Chrome window opens. Sign in to THAT client's Google account and open
 *    Google Flow so you can see the canvas. (Use "Sign in" normally — this is a
 *    real persistent profile, so Google allows login here.)
 *  - When you can see Flow working, come back to the terminal and press Enter.
 *  - The profile is saved to profiles/<clientId> and reused for all future
 *    generations for that client. It self-refreshes like a normal browser.
 *
 * Re-run only if a profile ever gets signed out (rare).
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const clientId = process.argv[2];
if (!clientId) {
  console.error("Usage: node login-once.js <clientId>");
  process.exit(1);
}

const profileDir = path.join(__dirname, "profiles", clientId);
fs.mkdirSync(profileDir, { recursive: true });

function waitEnter(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(msg, () => { rl.close(); res(); }));
}

(async () => {
  console.log("Opening persistent profile at:", profileDir);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false, channel: "chrome", viewport: null,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"]
    });
  } catch (e) {
    console.log("Real Chrome not found, using bundled Chromium");
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false, viewport: null,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"]
    });
  }
  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://labs.google/fx/tools/flow");

  console.log("\n=======================================================");
  console.log(" 1. Sign in to THIS client's Google account in the window.");
  console.log(" 2. Open Google Flow and confirm you can see the canvas.");
  console.log(" 3. Then press Enter here to save the profile.");
  console.log("=======================================================\n");
  await waitEnter("Press Enter once you're fully logged into Flow... ");

  await context.close();   // persistent profile is saved on disk automatically
  console.log(`✅ Profile saved for client ${clientId}. Generation will now use it — no cookie expiry.`);
  process.exit(0);
})();
