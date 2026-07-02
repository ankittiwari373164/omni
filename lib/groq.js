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

/**
 * Ask the ChatGPT server to CREATE AN IMAGE for a scene description.
 * Returns a data URL (data:image/...;base64,...) or a raw URL. Used for
 * per-part reference images when generating split videos.
 */
async function generateImage(promptText, chatLink) {
  if (!CHATGPT_SERVER_URL) throw new Error("CHATGPT_SERVER_URL not set (your ngrok URL)");
  // Reuse the SAME /api/generate endpoint that already works for text (over the
  // same ngrok tunnel + token). wantImage:true tells PromptForge to return an
  // image instead of text. This avoids depending on a separate route.
  const res = await fetch(`${CHATGPT_SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gen-token": GEN_TOKEN },
    body: JSON.stringify({ prompt: promptText, chatLink: chatLink || undefined, wantImage: true })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `image server HTTP ${res.status}`);
  return String(body.image || "").trim();
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
  // Unified house format for ALL clients. Only the brand info + calendar topic
  // change per video; the structure (scene numbering & timing, on-screen text,
  // effects, transition, Hindi/Hinglish voiceover, Indian-origin people) stays
  // identical. styleKey/instruction/promptSample are intentionally not injected
  // so every client gets this consistent shape.

  const sys = `You are a senior short-form video creative director for an Indian social-media brand studio.
You write structured, production-ready prompts for an AI text-to-video tool (Google Flow "Omni"/Veo,
which also generates spoken audio).

MANDATORY RULES for every prompt you write:
- People: use ONLY generic, anonymous INDIAN-ORIGIN people (e.g. "a young Indian woman",
  "an Indian family"). NEVER real, named, or famous individuals; no celebrities, politicians,
  athletes, or influencers.
- No real brands, logos, trademarks, or copyrighted characters.
- No politics, news, violence, weapons, blood, medical/graphic, sexual/suggestive, or hateful content.
- Keep it positive, aspirational, brand-safe, and culturally Indian.
- Every VOICEOVER must be in natural HINDI/HINGLISH (Roman script), warm and conversational.
- Visuals must be cinematic and concrete: subject, action, camera movement, lighting, mood; realistic 4K.
- Output ONLY the structured format requested — no preamble, no explanation, no markdown fences.`;

  const brandLine = `Brand: ${businessName || "(unnamed brand)"}${businessDetails ? `\nBrand info: ${businessDetails}` : ""}
Video topic: ${topic || "(brand story)"}${hook ? `\nAngle / hook: ${hook}` : ""}`;

  const partTemplate = (label, range, sceneTimes) => `${label} (${range}) — <short punchy title>
Scene 1 (${sceneTimes[0]}): <one vivid sentence — Indian-origin subject, setting, action, camera, lighting>
Scene 2 (${sceneTimes[1]}): <one vivid sentence, same subject & style>
Scene 3 (${sceneTimes[2]}): <one vivid sentence, same subject & style>
On-Screen Text: <short catchy line in English, 3-6 words>
Effects: <4-5 comma-separated cinematic effects, e.g. slow-motion, soft glow, light particles, gentle push-in>
Transition: <one short line describing the transition>
Voiceover (Hindi/Hinglish): "<natural Hinglish narration, about 25-30 words, matches the visuals>"`;

  const user = splitParts
    ? `${brandLine}

Create a 20-second vertical 9:16 video as TWO continuous 10-second parts (PART 2 continues exactly
where PART 1 ends — same subject, setting, wardrobe, lighting and style). Output EXACTLY this
structure and NOTHING else. You MUST include the literal markers "PART 1" and "PART 2":

${partTemplate("PART 1", "0-10 sec", ["0-3 sec", "3-7 sec", "7-10 sec"])}

${partTemplate("PART 2", "10-20 sec", ["10-13 sec", "13-17 sec", "17-20 sec"])}`
    : `${brandLine}

Create a 10-second vertical 9:16 video. Output EXACTLY this structure and NOTHING else:

${partTemplate("PART 1", "0-10 sec", ["0-3 sec", "3-7 sec", "7-10 sec"])}`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.85,
    max_tokens: splitParts ? 1500 : 800,
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
 * Extract per-part image URLs that ChatGPT embedded in the script using
 * IMAGE_PART1: <url> / IMAGE_PART2: <url> markers. Returns the URLs and the
 * prompt with those marker lines removed (so they don't get typed into Flow).
 */
function extractPartImages(prompt) {
  const images = [];
  const re = /IMAGE[_ ]?PART\s*(\d)\s*:?\s*(https?:\/\/\S+)/gi;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0) images[idx] = m[2].trim();
  }
  // Remove the marker lines from the prompt text.
  const cleaned = prompt.replace(/^.*IMAGE[_ ]?PART\s*\d\s*:?.*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  return { images, cleaned };
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

module.exports = { generatePrompt, generateImage, splitPromptParts, extractPartImages, sanitizePrompt, generateNewsPrompt, generateCalendar, generateYouTubeMeta, generateVoiceScript, promptStyles };
