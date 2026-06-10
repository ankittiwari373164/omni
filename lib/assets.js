/**
 * lib/assets.js — client assets (frame / outro / reference image) in Supabase Storage.
 *
 * Local disk is just a cache. Source of truth is the "assets" storage bucket,
 * so the free Render instance (ephemeral disk) and the GitHub Actions worker
 * (fresh runner) always fetch the latest files from Supabase.
 */
const fs = require("fs");
const path = require("path");
const supabase = require("./supabase");

const BUCKET = "assets";
const localDir = path.join(__dirname, "..", "assets");

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  try {
    const { data } = await supabase.storage.getBucket(BUCKET);
    if (!data) await supabase.storage.createBucket(BUCKET, { public: false });
  } catch {
    try { await supabase.storage.createBucket(BUCKET, { public: false }); } catch {}
  }
  bucketReady = true;
}

const mimeFor = (name) => ({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime"
}[path.extname(name).toLowerCase()] || "application/octet-stream");

/** Upload a local file to the bucket (upsert). */
async function uploadAsset(localPath, name) {
  await ensureBucket();
  const buf = fs.readFileSync(localPath);
  const { error } = await supabase.storage.from(BUCKET)
    .upload(name, buf, { contentType: mimeFor(name), upsert: true });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  return name;
}

/**
 * Ensure an asset exists locally; download from the bucket if missing.
 * Returns the absolute local path, or null if it can't be found anywhere.
 */
async function fetchAsset(name) {
  if (!name) return null;
  const local = path.join(localDir, name);
  if (fs.existsSync(local)) return local;

  await ensureBucket();
  const { data, error } = await supabase.storage.from(BUCKET).download(name);
  if (error || !data) {
    console.warn(`⚠️  asset "${name}" not found in Supabase Storage (${error?.message || "no data"})`);
    return null;
  }
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(local, Buffer.from(await data.arrayBuffer()));
  return local;
}

module.exports = { uploadAsset, fetchAsset, BUCKET };