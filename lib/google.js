const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// Full scope set (used by the combined "Connect Google" flow if you keep it).
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];

// Per-service scopes for the SEPARATE Connect YouTube / Connect Drive buttons.
const SERVICE_SCOPES = {
  youtube: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly"
  ],
  drive: [
    "https://www.googleapis.com/auth/drive.file"
  ]
};

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/** Combined Drive+YouTube consent URL. `state` carries the client id. */
function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state
  });
}

/**
 * Consent URL for ONE service (youtube or drive). `state` should encode both the
 * client id and the service so the callback knows where to store the tokens,
 * e.g. state = `${clientId}::youtube`.
 */
function getServiceAuthUrl(state, service) {
  const scope = SERVICE_SCOPES[service] || SCOPES;
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope,
    state
  });
}

/**
 * Exchange the ?code from the callback for tokens (+ channel name if available).
 * `prevTokens` (optional) is whatever was stored before: Google only returns a
 * refresh_token on the FIRST consent, so on a re-connect we merge the old
 * refresh_token forward — otherwise we'd save an access-token-only credential
 * that dies in ~1h and then fails with invalid_grant.
 */
async function exchangeCode(code, prevTokens) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token && prevTokens && prevTokens.refresh_token) {
    tokens.refresh_token = prevTokens.refresh_token;
  }
  let channelName = "";
  try {
    client.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth: client });
    const me = await yt.channels.list({ part: ["snippet"], mine: true });
    channelName = me.data.items?.[0]?.snippet?.title || "";
  } catch { /* youtube scope may be unconsented (e.g. Drive-only); ignore */ }
  return { tokens, channelName };
}

/** True when an error is Google's "refresh token dead — user must reconnect". */
function isInvalidGrant(err) {
  const msg = (err && (err.message || err.toString())) || "";
  const data = err && err.response && err.response.data;
  const code = data && (data.error || data.error_description);
  return /invalid_grant/i.test(msg) || /invalid_grant/i.test(String(code || ""));
}

/**
 * Build an authenticated OAuth2 client. googleapis auto-refreshes the access
 * token using the refresh_token; when it does, it emits a "tokens" event with
 * the fresh access_token (and sometimes a new refresh_token). We forward that
 * to `onTokens` so the caller can persist it — keeping the stored credential
 * alive instead of letting a stale access token rot into invalid_grant.
 */
function authed(tokens, onTokens) {
  const client = oauthClient();
  client.setCredentials(tokens);
  if (typeof onTokens === "function") {
    client.on("tokens", (fresh) => {
      // Merge: a refresh event usually omits refresh_token; keep the old one.
      const merged = { ...tokens, ...fresh };
      if (!merged.refresh_token && tokens.refresh_token) merged.refresh_token = tokens.refresh_token;
      try { onTokens(merged); } catch {}
    });
  }
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
async function uploadToDrive({ tokens, filePath, name, folderId, onTokens }) {
  if (!tokens || !tokens.refresh_token) {
    const e = new Error("Drive not connected (no refresh token) — reconnect Google Drive for this client.");
    e.code = "REAUTH"; throw e;
  }
  const drive = google.drive({ version: "v3", auth: authed(tokens, onTokens) });
  const fileMetadata = { name: name || path.basename(filePath) };
  const fid = parseFolderId(folderId);
  if (fid) fileMetadata.parents = [fid];

  try {
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
  } catch (err) {
    if (isInvalidGrant(err)) {
      const e = new Error("Google Drive access expired (invalid_grant) — reconnect Drive for this client.");
      e.code = "REAUTH"; throw e;
    }
    throw err;
  }
}

/** Upload a video to YouTube (public by default). madeForKids forced false. */
async function uploadToYouTube({ tokens, filePath, title, description, tags, privacyStatus = "public", onLog = () => {}, onTokens }) {
  if (!tokens || !tokens.refresh_token) {
    const e = new Error("YouTube not connected (no refresh token) — reconnect YouTube for this client.");
    e.code = "REAUTH"; throw e;
  }
  const youtube = google.youtube({ version: "v3", auth: authed(tokens, onTokens) });
  const fileSize = fs.statSync(filePath).size;
  let lastPct = -1;
  onLog(`📤 Uploading to YouTube (${(fileSize / 1048576).toFixed(1)} MB)…`);

  try {
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
  } catch (err) {
    if (isInvalidGrant(err)) {
      const e = new Error("YouTube access expired (invalid_grant) — reconnect YouTube for this client.");
      e.code = "REAUTH"; throw e;
    }
    throw err;
  }
}

module.exports = { getAuthUrl, getServiceAuthUrl, exchangeCode, isInvalidGrant, uploadToDrive, uploadToYouTube, SCOPES, SERVICE_SCOPES };
