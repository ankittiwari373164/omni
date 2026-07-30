// lib/image-store.js — persists generated part-images + thumbnail so a video
// RETRY reuses them instead of burning another ChatGPT-account cycle.
//
// Dual storage (recommended): local disk for fast reuse on the same machine,
// AND Supabase Storage as the durable copy that survives a worker reboot /
// disk clear. Keyed by calendar item id so every retry finds the same set.
//
// Layout:  gen-images/<calItemId>/part1.png, part2.png, part3.png, thumb.png

const fs = require("fs");
const path = require("path");
const supabase = require("./supabase");

const BUCKET = "gen-images";
const LOCAL_DIR = path.join(__dirname, "..", "gen-images");
let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  try { await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {}); bucketReady = true; }
  catch { /* may already exist */ }
}

function localPathFor(calItemId, name) {
  return path.join(LOCAL_DIR, String(calItemId), name);
}
function storageKey(calItemId, name) {
  return `${calItemId}/${name}`;
}

// Save a base64/dataURL or Buffer image under part name (e.g. "part1.png").
async function saveImage(calItemId, name, data) {
  let buf;
  if (Buffer.isBuffer(data)) buf = data;
  else if (typeof data === "string") {
    const b64 = data.includes(",") ? data.split(",")[1] : data;
    buf = Buffer.from(b64, "base64");
  } else throw new Error("saveImage: unsupported data type");

  const lp = localPathFor(calItemId, name);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(lp, buf);

  try {
    await ensureBucket();
    await supabase.storage.from(BUCKET).upload(storageKey(calItemId, name), buf, {
      contentType: "image/png", upsert: true
    });
  } catch (e) { console.log(`image-store: cloud upload failed for ${name}: ${e.message}`); }

  return lp;
}

// Return the local path for a saved image, downloading from Storage first if
// it's not on this machine's disk (e.g. after a reboot). null if it doesn't
// exist anywhere — caller then knows it must (re)generate.
async function getImage(calItemId, name) {
  const lp = localPathFor(calItemId, name);
  if (fs.existsSync(lp) && fs.statSync(lp).size > 1000) return lp;
  try {
    await ensureBucket();
    const { data, error } = await supabase.storage.from(BUCKET).download(storageKey(calItemId, name));
    if (error || !data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length < 1000) return null;
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, buf);
    return lp;
  } catch { return null; }
}

// Do we already have a full saved set for this item? (for retry short-circuit)
async function hasImages(calItemId, names) {
  for (const n of names) if (!(await getImage(calItemId, n))) return false;
  return true;
}

module.exports = { saveImage, getImage, hasImages, localPathFor };
