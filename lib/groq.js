const promptStyles = require("./prompt-styles");

// ── ChatGPT server backend (replaces Groq) ────────────────────────────────
// Instead of the Groq API, generation goes to a self-hosted "PromptForge"
// server that automates chatgpt.com (no OpenAI API). It exposes:
//   POST {CHATGPT_SERVER_URL}/api/generate
//   headers: { "x-gen-token": GEN_TOKEN }
//   body: { prompt, chatLink }         chatLink = optional per-client chat URL
//   -> { result: "<text>" }
// Set CHATGPT_SERVER_URL (your ngrok URL) and GEN_TOKEN in the environment.
// A per-request chatLink can be passed via the special _chatLink message.
const CHATGPT_SERVER_URL = (process.env.CHATGPT_SERVER_URL || "").replace(/\/+$/, "");
const GEN_TOKEN = process.env.GEN_TOKEN || process.env.CHATGPT_GEN_TOKEN || "";

async function callChatGPT(promptText, chatLink) {
  if (!CHATGPT_SERVER_URL) throw new Error("CHATGPT_SERVER_URL not set (your ngrok URL)");
  const res = await fetch(`${CHATGPT_SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gen-token": GEN_TOKEN },
    body: JSON.stringify({ prompt: promptText, chatLink: chatLink || undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `ChatGPT server HTTP ${res.status}`);
  return String(body.result || "").trim();
}

// ── ChatGPT image generation ───────────────────────────────────────────────
// The same PromptForge server that drives chatgpt.com also exposes image
// generation (ChatGPT can create images). Contract:
//   POST {CHATGPT_SERVER_URL}/api/generate-image
//   headers: { "x-gen-token": GEN_TOKEN }
//   body: { prompt, chatLink? }
//   -> one of:
//        { image:  "data:image/png;base64,..." }   (data URL)
//        { image:  "<base64>" }                     (raw base64, png assumed)
//        { imageUrl / url: "https://..." }          (http(s) URL to fetch)
//        { images: [ <any of the above> ] }         (first is used)
// Returns { buffer, ext }. Throws if the server can't produce an image.
async function callChatGPTImage(promptText, chatLink) {
  if (!CHATGPT_SERVER_URL) throw new Error("CHATGPT_SERVER_URL not set (your ngrok URL)");
  const res = await fetch(`${CHATGPT_SERVER_URL}/api/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gen-token": GEN_TOKEN },
    body: JSON.stringify({ prompt: promptText, chatLink: chatLink || undefined })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `ChatGPT image server HTTP ${res.status}`);

  let payload = body.image || body.imageUrl || body.url || body.result || null;
  if (!payload && Array.isArray(body.images) && body.images.length) payload = body.images[0];
  if (!payload) throw new Error("ChatGPT image server returned no image");

  // Case 1: http(s) URL → fetch the bytes.
  if (/^https?:\/\//i.test(payload)) {
    const imgRes = await fetch(payload);
    if (!imgRes.ok) throw new Error(`image download HTTP ${imgRes.status}`);
    const ct = imgRes.headers.get("content-type") || "";
    const ext = /png/i.test(ct) ? ".png" : /webp/i.test(ct) ? ".webp" : /gif/i.test(ct) ? ".gif" : ".jpg";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 1000) throw new Error("downloaded image is empty");
    return { buffer: buf, ext };
  }

  // Case 2: data URL or raw base64.
  let ext = ".png";
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.*)$/is.exec(payload);
  let b64;
  if (m) {
    ext = m[1].toLowerCase() === "jpg" || m[1].toLowerCase() === "jpeg" ? ".jpg"
        : "." + m[1].toLowerCase();
    b64 = m[2];
  } else {
    b64 = payload.replace(/^data:[^,]*,/, ""); // strip any stray data: prefix
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1000) throw new Error("decoded image is empty");
  return { buffer: buf, ext };
}

/**
 * Turn ONE part's Flow scene text into a still reference image via ChatGPT, and
 * write it to disk. Returns the saved file path (or throws).
 *   outPath = full path WITHOUT extension; the real extension is appended.
 * The image prompt reuses the same content-policy guardrails as the video
 * prompts so ChatGPT doesn't refuse.
 */
async function generatePartImage({ partText, businessName, businessDetails, chatLink, outPathNoExt }) {
  const fs = require("fs");
  const imgPrompt = `Create a single photorealistic vertical 9:16 reference IMAGE (not a video) that
establishes the opening frame for this short-video scene. Match the described subject, setting,
lighting and mood exactly so it can seed a video generator.

Brand: ${businessName || "(generic)"}${businessDetails ? `\nBrand brief: ${businessDetails}` : ""}

SCENE TO DEPICT:
${partText}

Content rules (mandatory): no real or identifiable people, no celebrities/public figures, no
brands/logos/trademarks, no text or captions in the image, no violence/weapons/gore, nothing
sexual or suggestive, nothing hateful. Anonymous, generic, brand-safe subjects only.
Output ONE image.`.trim();

  const { buffer, ext } = await callChatGPTImage(imgPrompt, chatLink);
  const finalPath = `${outPathNoExt}${ext}`;
  fs.writeFileSync(finalPath, buffer);
  return finalPath;
}

// Shim that mimics the tiny slice of the Groq SDK this file used, so the rest of
// the functions below can stay almost identical. It flattens system+user
// messages into one prompt, calls the ChatGPT server, and—when the caller asked
// for JSON—reminds the model to output raw JSON and strips any code fences.
const groq = {
  chat: {
    completions: {
      async create({ messages = [], response_format, _chatLink } = {}) {
        const wantJson = response_format && response_format.type === "json_object";
        const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
        const usr = messages.filter(m => m.role !== "system").map(m => m.content).join("\n\n");
        let prompt = [sys, usr].filter(Boolean).join("\n\n");
        if (wantJson) prompt += "\n\nRespond with RAW JSON only — no markdown, no code fences, no commentary.";
        let text = await callChatGPT(prompt, _chatLink);
        if (wantJson) text = text.replace(/```json|```/gi, "").trim();
        // Return in the same shape the code expects: choices[0].message.content
        return { choices: [{ message: { content: text } }] };
      }
    }
  }
};
const MODEL = "chatgpt";   // kept for compatibility; ignored by the shim

// Base rules for styles that don't bring their own (news, voiceover).
const FLOW_RULES = `
HARD REQUIREMENTS for every prompt you write:
- The video MUST be exactly 10 seconds long.
- It MUST be created for Google Flow "Omni" (text+image to video).
- Vertical 9:16 framing, social-media ready.
- Be cinematic and concrete: describe subject, action, camera movement, lighting and mood.
`.trim();

/**
 * Generate ONE Flow-ready prompt for a single calendar idea, in the client's chosen style.
 * `styleKey` selects a preset from lib/prompt-styles.js. `styleInstruction` (optional)
 * overrides with a fully custom template.
 */
async function generatePrompt({ businessName, businessDetails, topic, hook, styleKey, styleInstruction, promptSample, splitParts, chatLink }) {
  const instruction = styleInstruction || promptStyles.getStyle(styleKey).instruction;

  const sys = `You are a senior short-form video creative director writing prompts for the
Google Flow "Omni" text-to-video model.

CONTENT POLICY — these rules are MANDATORY. Google Flow rejects prompts that
violate them, and repeated rejections can suspend the account. Every prompt you
write MUST follow ALL of these:
- NO real or identifiable people: no celebrities, politicians, athletes, public
  figures, influencers, or named individuals. Use generic, fictional, or
  anonymous characters only (e.g. "a woman", "a presenter", "a person").
- NO real brands, logos, trademarks, or copyrighted characters.
- NO news, politics, current events, real organizations, or real-world incidents.
  Keep everything generic, evergreen, and brand-safe.
- NO violence, gore, weapons, blood, injury, or threatening content.
- NO sexual, suggestive, nude, or revealing content; no romantic/intimate framing.
- NO derogatory, hateful, discriminatory, profane, or toxic language.
- NO minors/children in any sensitive context.
- Write ONLY in plain US English. Keep it positive, professional, and safe.
Describe scenes cinematically (lighting, camera, setting, mood) without any of
the above. If the topic edges toward a restricted area, reframe it abstractly.

╔═══════════════════════════════════════════════════════════════╗
OUTPUT FORMAT IS MANDATORY. You MUST output the prompt as numbered SCENES.
Do NOT write a paragraph. Do NOT write flowing prose. Output EXACTLY this
structure and NOTHING else:

A 10-second cinematic vertical 9:16 video. [one short line: overall look + subject]
Scene 1 (0-2 sec): [one sentence]
Scene 2 (2-4 sec): [one sentence]
Scene 3 (4-6 sec): [one sentence]
Scene 4 (6-8 sec): [one sentence]
Scene 5 (8-10 sec): [one sentence]

RULES:
- You MUST include the literal words "Scene 1", "Scene 2", etc. with their time ranges.
- Exactly 5 scenes. Each scene = ONE short sentence.
- Same subject, setting, lighting and style in every scene (one continuous shot).
- If you output a single paragraph instead of numbered scenes, that is WRONG.
- No captions, no on-screen text, no extra commentary before or after.
╚═══════════════════════════════════════════════════════════════╝

${instruction}${promptSample ? `

IMPORTANT — match the STYLE, structure, length, and formatting of this example
prompt as closely as possible (adapt the content to the new topic, but keep the
same shape, tone, and level of detail):
--- EXAMPLE PROMPT ---
${promptSample}
--- END EXAMPLE ---` : ""}${splitParts ? `

This video is ONE continuous 20-second scene delivered as two 10-second clips
that will be joined back-to-back. Keep EACH part SHORT — 2-3 sentences (about
40-60 words). Same subject, setting, lighting and style in both. PART 2 opens
exactly where PART 1 ends, as if the camera never stopped. No scene lists, no
timestamps, no captions.
- PART 1 should build toward a moment; PART 2 continues and completes it. Think
  "first half" and "second half" of one action, not two ideas.
- Restate the shared visual details (subject description, setting, style) in BOTH
  parts so each clip renders consistently on its own, but keep them identical.
- No on-screen text, no scene labels, no captions.

Format EXACTLY as:
PART 1:
<complete Flow prompt for seconds 0-10 — sets up the continuous scene; end on a clear hand-off moment>
PART 2:
<complete Flow prompt for seconds 10-20 — opens on the SAME frame/state PART 1 ended on, continues the action seamlessly>` : ""}`;

  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || "(none provided)"}
Today's video topic: ${topic}
${hook ? `Angle / hook: ${hook}` : ""}

Write the prompt for this topic. Output ONLY the numbered scenes (Scene 1, Scene 2, …) — no paragraph, no intro, no extra text.`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.8,
    max_tokens: splitParts ? 1000 : 600,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return sanitizePrompt((res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, ""));
}

// Safety net: scrub words/phrases that commonly trip Google Flow's filters
// (news/politics framing, violence, sexual, derogatory) before the prompt is
// ever sent to Flow. Replaces with neutral equivalents or removes them.
function sanitizePrompt(text) {
  if (!text) return text;
  let p = text;
  const replacements = [
    // news / politics / real-world framing -> neutral
    [/\bbreaking news\b/gi, "update"],
    [/\bnews (anchor|reporter|broadcast|channel|studio|desk|headline|bulletin)\b/gi, "presenter"],
    [/\bnews\b/gi, "update"],
    [/\b(headline|breaking)\b/gi, "highlight"],
    [/\b(politic(s|al|ian)|election|government|minister|president|prime minister)\b/gi, "topic"],
    [/\b(protest|riot|war|attack|terroris[mt]|bomb|shooting|gun|weapon|knife|blood|gore|kill(ing)?|murder|violence|violent|fight)\b/gi, "scene"],
    // sexual / suggestive -> neutral
    [/\b(sexy|sexual|nude|naked|erotic|seductive|lingerie|bikini|cleavage|provocative)\b/gi, "elegant"],
    // derogatory/toxic -> neutral
    [/\b(hate|racist|slur|abusive|offensive|vulgar)\b/gi, "neutral"],
  ];
  for (const [re, sub] of replacements) p = p.replace(re, sub);
  // collapse any double spaces created by replacements
  return p.replace(/[ \t]{2,}/g, " ").trim();
}
function splitPromptParts(prompt) {
  const m = prompt.match(/PART\s*1\s*:?(.*?)PART\s*2\s*:?(.*)/is);
  if (m) {
    const p1 = m[1].trim(), p2 = m[2].trim();
    if (p1 && p2) return [p1, p2];
  }
  return [prompt];
}

/**
 * Generate a content calendar: an array of { scheduled_date, topic, hook }.
 */
async function generateCalendar({ businessName, businessDetails, days = 30, startDate, chatLink }) {
  const sys = `You are a social-media content strategist. You produce JSON content calendars
for short vertical videos. Always return STRICT JSON, no commentary, no markdown fences.`;

  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || "(none provided)"}

Create a ${days}-day content calendar of distinct, engaging short-video ideas for this brand.
Return JSON ONLY, shaped exactly like:
{"items":[{"day":1,"topic":"...","hook":"..."}, ...]}
- "topic" = a short concrete idea (max ~8 words).
- "hook" = a one-line scroll-stopping angle.
- ${days} items, days 1..${days}, all unique.`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.9,
    max_tokens: 1500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content || "{}");
  } catch {
    parsed = { items: [] };
  }

  const base = startDate ? new Date(startDate) : new Date();
  return (parsed.items || []).map((it, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);   // consecutive from start date; ignore model's day number to avoid gaps
    return {
      scheduled_date: d.toISOString().slice(0, 10),
      topic: it.topic || `Idea ${i + 1}`,
      hook: it.hook || ""
    };
  });
}

/**
 * Generate YouTube publishing metadata for a finished video.
 */
async function generateYouTubeMeta({ businessName, businessDetails, topic, prompt, defaultTags, chatLink }) {
  const sys = `You write YouTube Shorts metadata. Return STRICT JSON only, no markdown.`;
  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || ""}
Video topic: ${topic || ""}
Video description (prompt used): ${prompt || ""}
${defaultTags ? `Always-include tags: ${defaultTags}` : ""}

Return JSON ONLY shaped like:
{"title":"<=90 chars catchy title","description":"2-4 line description","hashtags":"#a #b #c (3-6)","tags":"comma,separated,tags (8-15)"}`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.8,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  try {
    return JSON.parse(res.choices[0]?.message?.content || "{}");
  } catch {
    return { title: topic || businessName, description: "", hashtags: "", tags: defaultTags || "" };
  }
}

/**
 * Generate ONE Flow-ready prompt from a news / RSS item, in scene-cut format
 * with an OFF-SCREEN voiceover (the model speaks the narration). Built to avoid
 * Veo policy violations: no on-camera anchor lip-syncing, no real public figures,
 * no graphic/sensitive content — representative b-roll only.
 */
async function generateNewsPrompt({ businessName, businessDetails, title, summary, chatLink }) {
  // PASS 1 — distill the headline down to ONE safe, generic, apolitical theme.
  // The raw (possibly political) headline is used ONLY here and never reaches
  // the video prompt, so no names/politics/events can leak through.
  let theme = "everyday life";
  try {
    const t = await groq.chat.completions.create({ _chatLink: chatLink,
      model: MODEL, temperature: 0.3, max_tokens: 30,
      messages: [
        { role: "system", content: `Extract the single broad, universal, brand-safe THEME behind a headline,
in 2-5 words. STRICT: no names of people, companies, agencies, places, parties, or events; no
politics, war, crime, disasters, or controversy. Generalize to a neutral evergreen concept
(e.g. "digital privacy", "advances in technology", "changing seasons", "personal finance",
"healthy living", "space exploration"). Output ONLY the theme phrase, nothing else.` },
        { role: "user", content: `Headline: ${title}\nSummary: ${summary || "(none)"}\n\nTheme:` }
      ]
    });
    const got = (t.choices[0]?.message?.content || "").trim().replace(/^["'.]+|["'.]+$/g, "");
    if (got) theme = sanitizePrompt(got).slice(0, 60);
  } catch {}

  // PASS 2 — generate the video prompt from the SAFE THEME ONLY (no headline).
  const sys = `You write prompts for the Google Flow "Omni"/Veo text-to-video model (it generates
spoken audio). Produce a 10-second vertical (9:16) cinematic explainer as SCENE CUTS of generic
b-roll with an OFF-SCREEN voiceover (never show a person speaking to camera / lip-syncing).
MANDATORY: completely generic and brand-safe — no real or named people, no public/political
figures, no brands/logos, no politics, war, crime, weapons, violence, disasters, medical/graphic,
sexual, or derogatory content. Anonymous people only. Plain US English. Never use the word "news".`;

  const user = `Brand: ${businessName}
Brand focus: ${businessDetails || "(general)"}
Theme to depict (generic, already safe): ${theme}

Write the prompt about this THEME generically, in EXACTLY this scene-cut shape:

A 10-second cinematic vertical 9:16 explainer, clean b-roll style.
Scene 1 (0-2 sec): <establishing symbolic shot for the theme>
Scene 2 (2-4 sec): <relevant generic detail / object / environment b-roll>
Scene 3 (4-6 sec): <a process, data, or context visual (abstract charts, screens, motion ok)>
Scene 4 (6-8 sec): <everyday-life context visual, anonymous people only>
Scene 5 (8-10 sec): <calm closing shot>
Voiceover (off-screen, spoken clearly across the clip): "<a neutral, generic reflection on the theme, about 28-32 words, NO names of any people/orgs/places/events>"
Style: clean cinematic b-roll, soft lighting, smooth cuts, ultra-realistic 4K, calm narration. No on-camera narrator, no real people, no logos, no text overlays.`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.6,
    max_tokens: 500,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

/**
 * Generate a short SPOKEN voiceover script (the words to be narrated) sized to
 * the clip length. ~24-30 words ≈ 10 seconds.
 */
async function generateVoiceScript({ businessName, topic, prompt, seconds = 10, chatLink }) {
  const words = Math.round((seconds / 10) * 27);
  const sys = `You write punchy spoken voiceover lines for short vertical videos. Output ONLY the
words to be spoken — no stage directions, no quotes, no emojis, no hashtags, no markdown.`;
  const user = `Brand/channel: ${businessName}
Topic: ${topic || ""}
Scene being shown: ${prompt || ""}

Write a natural, engaging voiceover of about ${words} words (≈${seconds} seconds when read aloud)
that narrates this clip. Plain spoken sentences only.`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.8,
    max_tokens: 200,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  return sanitizePrompt((res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, ""));
}

module.exports = { generatePrompt, splitPromptParts, sanitizePrompt, generateNewsPrompt, generateCalendar, generateYouTubeMeta, generateVoiceScript, callChatGPTImage, generatePartImage, promptStyles };
