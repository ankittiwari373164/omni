// lib/schedulerCalendar.js
// Flow Studio no longer generates/stores its own calendar. Instead it
// fetches/writes through the scheduler app (MetaFlow), which owns the
// shared `calendar_items` table in Supabase for both this program
// ("omni") and the chatgpt-main program.
//
// Requires SCHEDULER_URL in .env, e.g. https://your-scheduler.vercel.app

const BASE = (process.env.SCHEDULER_URL || "").replace(/\/$/, "");
const PROGRAM = "omni";

function assertConfigured() {
  if (!BASE) throw new Error("SCHEDULER_URL env var is not set — cannot reach the scheduler's calendar API");
}

async function req(path, opts = {}) {
  assertConfigured();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `scheduler request failed (${res.status})`);
  return data;
}

// List a client's calendar items (mirrors old `calendar_items` rows shape).
async function list(clientId) {
  return req(`/api/calendar?program=${PROGRAM}&clientId=${encodeURIComponent(clientId)}`);
}

// Generate a fresh calendar via the scheduler (Groq call happens there).
async function generate({ clientId, clientName, businessDetails, days, startDate, chatLink }) {
  return req(`/api/calendar/generate`, {
    method: "POST",
    body: JSON.stringify({ program: PROGRAM, clientId, clientName, businessDetails, days, startDate, chatLink })
  });
}

// Update one item (e.g. after generating its Flow prompt, or marking done).
async function update(itemId, patch) {
  return req(`/api/calendar/${itemId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

async function get(itemId) {
  return req(`/api/calendar/${itemId}`);
}

async function remove(itemId) {
  return req(`/api/calendar/${itemId}`, { method: "DELETE" });
}

// Add one manual item (used by the xlsx-import / RSS flows).
async function add(item) {
  return req(`/api/calendar`, { method: "POST", body: JSON.stringify({ program: PROGRAM, ...item }) });
}

module.exports = { list, generate, update, get, remove, add };
