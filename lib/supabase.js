const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");   // provide a WebSocket impl for Node < 22 (Render runs Node 20)

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn("⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB calls will fail.");
}

const supabase = createClient(url || "http://localhost", key || "noop", {
  auth: { persistSession: false },
  // This server only does REST queries (no realtime subscriptions), but the
  // client still initializes a realtime layer that needs a WebSocket ctor on
  // Node < 22. Supply `ws` so it works on any Node version.
  realtime: { transport: ws }
});

module.exports = supabase;