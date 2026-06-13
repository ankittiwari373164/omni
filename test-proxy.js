/**
 * test-dataimpulse.js — verify your DataImpulse residential proxy works
 * BEFORE wiring it into the worker or spending a generation.
 *
 * Your sticky India proxy is pre-loaded below.
 * Run:  node test-dataimpulse.js
 *
 * What you want to see:
 *   ✅ India          → country targeting works
 *   🟢 residential/ISP → real residential IP (the whole point — Google trusts this)
 *   Flow page 🟢 reachable
 */
const { chromium } = require("playwright");

// ── Your DataImpulse sticky residential proxy (India) ──
const PROXY = {
  server:   "http://gw.dataimpulse.com:10000",
  username: "6553fd52db05df73a04f__cr.in",
  password: "e3060527ca5fbdbc",
};

const DC = /amazon|google|microsoft|azure|ovh|hetzner|digitalocean|linode|vultr|datacamp|m247|choopa|leaseweb|cloud|datacenter/i;

(async () => {
  console.log("Testing DataImpulse residential proxy:", PROXY.server);
  console.log("(sticky session — should hold one Indian IP)\n");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: PROXY,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);

    // 1) Exit IP / country / org
    let info = {};
    try {
      await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" });
      info = JSON.parse(await page.locator("pre, body").first().innerText());
    } catch (e) { console.log("❌ Could not reach ipinfo through proxy:", e.message); }

    if (info.ip) {
      console.log(`   IP:      ${info.ip}`);
      console.log(`   City:    ${info.city || "?"}, ${info.region || "?"}`);
      console.log(`   Country: ${info.country}  ${info.country === "IN" ? "✅ India" : "⚠️  NOT India (" + info.country + ")"}`);
      console.log(`   Org:     ${info.org || "?"}`);
      const dc = DC.test(info.org || "");
      console.log(`   Type:    ${dc ? "⚠️  looks like DATACENTER" : "🟢 residential/ISP — Google trusts this"}`);
    }

    // 2) Sticky check — fetch IP a second time, should be the SAME
    try {
      await page.waitForTimeout(1500);
      await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" });
      const info2 = JSON.parse(await page.locator("pre, body").first().innerText());
      console.log(`   Sticky:  2nd IP = ${info2.ip} ${info2.ip === info.ip ? "🟢 same (sticky working)" : "⚠️  changed (not sticky)"}`);
    } catch {}

    // 3) Can it reach Flow?
    try {
      const r = await page.goto("https://labs.google/fx/tools/flow", { waitUntil: "domcontentloaded", timeout: 40000 });
      console.log(`   Flow:    HTTP ${r ? r.status() : "?"} ${r && r.status() < 400 ? "🟢 reachable" : "⚠️"}`);
    } catch (e) { console.log("   Flow:    ⚠️ could not load:", e.message); }

    console.log("\n────────────────────────────");
    if (info.country === "IN" && !DC.test(info.org || "")) {
      console.log("✅ PASS — Indian residential IP. Set this as PROXY_SERVER and run the worker.");
    } else if (info.ip) {
      console.log("⚠️  Working, but check the country/type flags above.");
    } else {
      console.log("❌ Proxy didn't connect — re-check credentials/port from the DataImpulse dashboard.");
    }
  } catch (e) {
    console.log("❌ Proxy failed to connect:", e.message);
    console.log("   Check the username/password/port match the dashboard exactly.");
  } finally {
    if (browser) await browser.close();
  }
})();