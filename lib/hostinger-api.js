// lib/hostinger-api.js — Hostinger Mail API (create/list/delete mailboxes).
// Built to the documented contract at developers.hostinger.com:
//   GET    /api/mail/v1/orders/{orderId}/mailboxes         (list)
//   POST   /api/mail/v1/orders/{orderId}/mailboxes         (create: {local_part, password})
//   DELETE /api/mail/v1/mailboxes/{mailboxId}              (delete)
//
// Reading the OTP from the created mailbox is done via IMAP (lib/hostinger-mail.js).
//
// Env:
//   HOSTINGER_TOKEN     — API bearer token
//   HOSTINGER_ORDER_ID  — the mail order id for your domain (from List orders)

const BASE = "https://developers.hostinger.com/api/mail/v1";

function headers() {
  const token = process.env.HOSTINGER_TOKEN;
  if (!token) throw new Error("HOSTINGER_TOKEN not set");
  return { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" };
}

async function call(method, pathPart, body) {
  const res = await fetch(BASE + pathPart, {
    method, headers: headers(), body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`hostinger ${method} ${pathPart} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// Random local part obeying the documented rule: starts & ends with a letter/
// digit, only . _ - allowed in between, max 50 chars. We keep it simple: a
// plain alphanumeric random string (always valid).
function randomLocalPart() {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 14; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// Strong random password meeting Hostinger's rule (upper/lower/number/special, 8-50).
function randomPassword() {
  const lower = "abcdefghijkmnpqrstuvwxyz", upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", num = "23456789", spec = "!@#$%*";
  const pick = s => s[Math.floor(Math.random() * s.length)];
  let base = pick(upper) + pick(lower) + pick(num) + pick(spec);
  const all = lower + upper + num + spec;
  for (let i = 0; i < 12; i++) base += pick(all);
  return base;
}

// Create a fresh random-named mailbox on the order's domain.
// Returns { id, address, password }.
async function createMailbox(orderId) {
  orderId = orderId || process.env.HOSTINGER_ORDER_ID;
  if (!orderId) throw new Error("HOSTINGER_ORDER_ID not set (the mail order id for your domain)");
  const local_part = randomLocalPart();
  const password = randomPassword();
  const r = await call("POST", `/orders/${orderId}/mailboxes`, { local_part, password });
  return { id: r.id, address: r.address, password };
}

async function listMailboxes(orderId) {
  orderId = orderId || process.env.HOSTINGER_ORDER_ID;
  const r = await call("GET", `/orders/${orderId}/mailboxes`);
  return r.data || [];
}

async function deleteMailbox(mailboxId) {
  if (!mailboxId) return;
  return call("DELETE", `/mailboxes/${mailboxId}`);
}

module.exports = { createMailbox, listMailboxes, deleteMailbox, randomLocalPart, randomPassword };
