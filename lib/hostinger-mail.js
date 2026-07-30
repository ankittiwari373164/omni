// lib/hostinger-mail.js — read the OTP from a Hostinger mailbox via IMAP
// (the same protocol mail.hostinger.com webmail uses). Mailbox creation and
// deletion go through the Hostinger API (lib/hostinger-api.js); reading the
// inbox is done here over IMAP because hosting APIs generally don't expose
// message contents.
//
// Requires:  npm install imapflow
//
// IMAP settings for Hostinger email:
//   host: imap.hostinger.com   port: 993   secure: true
//   user: the full mailbox address   pass: the mailbox password

let ImapFlow;
try { ({ ImapFlow } = require("imapflow")); }
catch { /* not installed yet — readOTP will throw a clear message */ }

async function readOTP({ address, password, fromContains = "openai", sinceMs, timeoutMs = 120000, intervalMs = 5000, log = () => {} }) {
  if (!ImapFlow) throw new Error("imapflow not installed — run: npm install imapflow");

  // Give OpenAI a few seconds to actually send THIS signup's email before the
  // first poll, so we don't race and match a just-slightly-older message.
  await new Promise(r => setTimeout(r, 6000));

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const client = new ImapFlow({
      host: process.env.HOSTINGER_IMAP_HOST || "imap.hostinger.com",
      port: 993, secure: true,
      auth: { user: address, pass: password },
      logger: false
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Only UNSEEN messages, newest first. With a shared inbox receiving
        // many signups, this prevents grabbing a stale code from an earlier
        // attempt. We also require the message to be newer than this signup.
        const uids = await client.search({ seen: false }, { uid: true }) || [];
        const recent = uids.slice(-10).reverse();
        for (const uid of recent) {
          const msg = await client.fetchOne(uid, { source: true, envelope: true, flags: true }, { uid: true });
          if (!msg) continue;
          const from = (msg.envelope?.from || []).map(f => f.address || "").join(",").toLowerCase();
          if (fromContains && !from.includes(fromContains.toLowerCase())) continue;
          const when = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : Date.now();
          if (sinceMs && when < sinceMs - 60000) continue;   // older than this signup → skip
          const subject = (msg.envelope?.subject || "");
          const raw = msg.source.toString("utf8");
          // Prefer the actual "verification code" email specifically.
          const isCodeEmail = /verification code|verify|confirm/i.test(subject) || /verification code to continue/i.test(raw);
          const otp = (raw.match(/Enter this temporary verification code[^]*?(\d{6})/i) || raw.match(/\b(\d{6})\b/) || [])[1];
          const link = (raw.match(/https?:\/\/[^\s"'<>]+/g) || []).find(l =>
            /openai|chatgpt/i.test(l) &&
            /verif|confirm|activate|auth|login|code/i.test(l) &&
            !/\.(woff2?|ttf|otf|css|js|png|jpe?g|gif|svg|ico)(\?|$)/i.test(l) &&
            !/cdn\.openai\.com/i.test(l)
          );
          if (otp || link) {
            // mark it seen so a later poll/attempt can't reuse this same code
            try { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch {}
            log("info", `📬 OTP email found (from ${from}, subj "${subject}")`);
            await lock.release(); await client.logout();
            return { otp, link };
          }
        }
      } finally { try { lock.release(); } catch {} }
      await client.logout();
    } catch (e) {
      try { await client.close(); } catch {}
      log("warn", `IMAP poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Hostinger IMAP: timed out waiting for OTP email");
}

module.exports = { readOTP };
