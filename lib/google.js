const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// Combined scopes (legacy single-connect flow — kept for backward compatibility).
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];

// Per-service scopes for the separate Connect buttons.
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];
const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file"
];

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Legacy combined auth URL (Drive + YouTube in one). `state` carries the client id. */
function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state
  });
}

/**
 * Per-service auth URL. `service` is "youtube" or "drive". The state encodes both
 * the client id and the service as "clientId::service" so the callback knows
 * which token field to store.
 */
function getServiceAuthUrl(clientId, service) {
  const scope = service === "drive" ? DRIVE_SCOPES : YOUTUBE_SCOPES;
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope,
    state: `${clientId}::${service}`
  });
}

/** Exchange the ?code from the callback for tokens (+ channel name if available). */
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  let channelName = "";
  try {
    client.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth: client });
    const me = await yt.channels.list({ part: ["snippet"], mine: true });
    channelName = me.data.items?.[0]?.snippet?.title || "";
  } catch { /* youtube scope may be unconsented; ignore */ }
  return { tokens, channelName };
}

function authed(tokens) {
  const client = oauthClient();
  client.setCredentials(tokens);
  return client;
}

/** Accept a raw folder id OR a pasted Drive folder URL and return the id. */
function parseFolderId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/\/folders\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/^([-\w]{20,})$/);
  return m ? m[1] : null;
}

/** Upload a local file to Google Drive (optionally into a folder). Returns a shareable link. */
async function uploadToDrive({ tokens, filePath, name, folderId }) {
  const drive = google.drive({ version: "v3", auth: authed(tokens) });
  const fileMetadata = { name: name || path.basename(filePath) };
  const fid = parseFolderId(folderId);
  if (fid) fileMetadata.parents = [fid];

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: { mimeType: "video/mp4", body: fs.createReadStream(filePath) },
    fields: "id, webViewLink"
  });

  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: "reader", type: "anyone" }
    });
  } catch { /* folder may already be shared / org policy */ }

  return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`;
}

/**
 * Upload a video to YouTube. madeForKids is forced false ("not made for kids").
 */
async function uploadToYouTube({ tokens, filePath, title, description, tags, privacyStatus = "public", onLog = () => {} }) {
  const youtube = google.youtube({ version: "v3", auth: authed(tokens) });
  const fileSize = fs.statSync(filePath).size;
  let lastPct = -1;
  onLog(`📤 Uploading to YouTube (${(fileSize / 1048576).toFixed(1)} MB)…`);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: (title || "Untitled").slice(0, 100),
        description: description || "",
        tags: Array.isArray(tags)
          ? tags
          : String(tags || "").split(",").map(t => t.trim()).filter(Boolean),
        categoryId: "22"
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
        madeForKids: false
      }
    },
    media: { body: fs.createReadStream(filePath) }
  }, {
    onUploadProgress: (evt) => {
      const pct = Math.floor((evt.bytesRead / fileSize) * 100);
      if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; onLog(`   …upload ${pct}%`); }
    }
  });

  onLog("✓ Upload complete — YouTube is processing the video");
  return `https://youtube.com/watch?v=${res.data.id}`;
}

module.exports = { getAuthUrl, getServiceAuthUrl, exchangeCode, uploadToDrive, uploadToYouTube, SCOPES };
