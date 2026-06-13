// lib/assets-sync.js — share client assets (reference image, frame, outro)
// between the Render dashboard and the local generator via Supabase Storage.
//
// Upload side (wherever a file is uploaded): uploadAsset() pushes the file to
// the "assets" bucket so it's available everywhere (and survives Render redeploys).
// Generate side (local PC): ensureLocalAssets() downloads any asset referenced
// by the client that isn't already on local disk, into the local assets/ folder.

const fs = require("fs");
const path = require("path");
const supabase = require("./supabase");

const BUCKET = "assets";
let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  try {
    // create the bucket if it doesn't exist (service key can do this)
    await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
    bucketReady = true;
  } catch { /* ignore — may already exist */ }
}

// Upload a local file to Storage under its filename. Safe to call after saving
// to local disk. Returns true on success.
async function uploadAsset(localPath, storageName) {
  if (!localPath || !fs.existsSync(localPath)) return false;
  try {
    await ensureBucket();
    const body = fs.readFileSync(localPath);
    const { error } = await supabase.storage.from(BUCKET).upload(storageName, body, {
      upsert: true,
      contentType: guessType(storageName)
    });
    if (error) { console.log("asset upload failed:", error.message); return false; }
    return true;
  } catch (e) { console.log("asset upload error:", e.message); return false; }
}

// For a client, make sure every referenced asset exists locally; download any
// missing ones from Storage. assetsDir is the local assets/ folder.
async function ensureLocalAssets(client, assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const names = [client.reference_image_path, client.frame_path, client.outro_path].filter(Boolean);
  for (const name of names) {
    const local = path.join(assetsDir, name);
    if (fs.existsSync(local)) continue;            // already here, skip
    try {
      await ensureBucket();
      const { data, error } = await supabase.storage.from(BUCKET).download(name);
      if (error || !data) { console.log(`asset not in storage: ${name} (${error?.message || "missing"})`); continue; }
      const buf = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(local, buf);
      console.log(`⬇️  synced asset from storage: ${name} (${(buf.length/1024).toFixed(0)} KB)`);
    } catch (e) { console.log(`asset sync error for ${name}:`, e.message); }
  }
}

function guessType(name) {
  const e = path.extname(name).toLowerCase();
  return e === ".png" ? "image/png" : e === ".jpg" || e === ".jpeg" ? "image/jpeg"
    : e === ".webp" ? "image/webp" : e === ".mp4" ? "video/mp4"
    : e === ".gif" ? "image/gif" : "application/octet-stream";
}

module.exports = { uploadAsset, ensureLocalAssets };