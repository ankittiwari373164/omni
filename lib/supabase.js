const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn("⚠️  SUPABASE_URL / SUPABASE_SERVICE_KEY not set — DB calls will fail.");
}

const supabase = createClient(url || "http://localhost", key || "noop", {
  auth: { persistSession: false }
});

module.exports = supabase;
