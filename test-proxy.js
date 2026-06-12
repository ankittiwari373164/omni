/**
 * test-webshare.js — tests all 10 of your free Webshare proxies at once.
 *
 * For each proxy it reports: exit country, org (ISP vs datacenter), whether it
 * can reach the Google Flow page, and how long it took. At the end it ranks
 * them so you know which to drop into PROXY_SERVER.
 *
 * Run:   node test-webshare.js
 * (needs playwright installed — it already is in this project)
 *
 * NOTE: these are SHARED DATACENTER proxies. Google flags datacenter IPs, so
 * even a "Working" proxy here may still hit "unusual activity" on generate.
 * This script filters out dead/blocked ones and shows their type so you don't
 * waste generation credits on obviously bad ones.
 */
const { chromium } = require("playwright");

const USER = "oxfghvtr";
const PASS = "oy7vupb8d7sh";

// host:port from your Webshare free list
const PROXIES = [
  "38.154.203.95:5863",
  "198.105.121.200:6462",
  "64.137.96.74:6641",
  "209.127.138.10:5784",
  "38.154.185.97:6370",
  "84.247.60.125:6095",
  "142.111.67.146:5611",
  "191.96.254.138:6185",
  "104.239.107.47:5699",
  "23.229.19.94:8689",
];

const DC = /amazon|google|microsoft|azure|ovh|hetzner|digitalocean|linode|vultr|datacamp|m247|choopa|leaseweb|cloud|host|server|colo|datacenter/i;

async function testOne(hostport) {
  const [host, port] = hostport.split(":");
  const result = { hostport, ok: false, country: "?", org: "?", type: "?", flow: "?", ms: 0 };
  const t0 = Date.now();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: `http://${host}:${port}`, username: USER, password: PASS },
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(25000);

    await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" });
    const info = JSON.parse(await page.locator("pre, body").first().innerText());
    result.ok = !!info.ip;
    result.country = info.country || "?";
    result.org = (info.org || "?").slice(0, 38);
    result.type = DC.test(info.org || "") ? "datacenter" : "ISP/resi";

    try {
      const r = await page.goto("https://labs.google/fx/tools/flow", { waitUntil: "domcontentloaded", timeout: 30000 });
      result.flow = r ? (r.status() < 400 ? "reachable" : `HTTP ${r.status()}`) : "?";
    } catch { result.flow = "unreachable"; }
  } catch (e) {
    result.flow = "DEAD: " + e.message.split("\n")[0].slice(0, 40);
  } finally {
    if (browser) await browser.close();
    result.ms = Date.now() - t0;
  }
  return result;
}

(async () => {
  console.log("Testing 10 Webshare proxies (this takes ~2-3 min)...\n");
  const results = [];
  for (const p of PROXIES) {
    process.stdout.write(`  ${p.padEnd(22)} ... `);
    const r = await testOne(p);
    results.push(r);
    console.log(`${r.ok ? "✅" : "❌"} ${r.country.padEnd(3)} ${r.type.padEnd(10)} flow:${r.flow} (${r.ms}ms)`);
  }

  console.log("\n──────────── SUMMARY ────────────");
  const usable = results.filter(r => r.ok && /reachable/.test(r.flow));
  if (!usable.length) {
    console.log("None reached Flow cleanly. These free shared IPs may be saturated/blocked.");
    console.log("Try again later, or use Webshare's free residential GB / a cheap residential plan.");
  } else {
    // prefer fastest reachable; country doesn't matter (Flow works in US too)
    usable.sort((a, b) => a.ms - b.ms);
    console.log("Best to try first (fastest that reached Flow):\n");
    usable.slice(0, 3).forEach(r => {
      console.log(`  ${r.hostport}   [${r.country} ${r.type} ${r.ms}ms]`);
    });
    const best = usable[0];
    const [h, p] = best.hostport.split(":");
    console.log("\nSet these as GitHub repo secrets:");
    console.log(`  PROXY_SERVER   = http://${h}:${p}`);
    console.log(`  PROXY_USERNAME = ${USER}`);
    console.log(`  PROXY_PASSWORD = ${PASS}`);
    console.log("\nThen run the workflow with vpn_provider: none, skip_image: true.");
  }
  console.log("\nReminder: all of these are DATACENTER IPs. If generate still says");
  console.log("'unusual activity', free datacenter won't get past Google — switch to residential.");
})();