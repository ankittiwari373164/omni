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

// Shared house-format block (two-part or single) used by generatePrompt and
// enhancePrompt so the structure stays identical everywhere.
function houseFormatBlock(splitParts) {
  const part = (label, range, t) => `${label} (${range}) — <short punchy title>
Scene 1 (${t[0]}): <one vivid sentence — Indian-origin subject, setting, action, camera, lighting>
Scene 2 (${t[1]}): <one vivid sentence, same subject & style>
Scene 3 (${t[2]}): <one vivid sentence, same subject & style>
On-Screen Text: <short catchy line in English, 3-6 words>
Effects: <4-5 comma-separated cinematic effects>
Transition: <one short line describing the transition>
Voiceover (Hindi/Hinglish): "<natural Hinglish narration, about 25-30 words, matches the visuals>"`;
  return splitParts
    ? `${part("PART 1", "0-10 sec", ["0-3 sec", "3-7 sec", "7-10 sec"])}\n\n${part("PART 2", "10-20 sec", ["10-13 sec", "13-17 sec", "17-20 sec"])}`
    : part("PART 1", "0-10 sec", ["0-3 sec", "3-7 sec", "7-10 sec"]);
}

/**
 * 1B: The user already WROTE a prompt (e.g. from an uploaded Excel calendar).
 * Keep their concept, subject and wording — do NOT rewrite or invent new ideas.
 * Only lightly polish and REFORMAT it into the house two-part structure (so
 * splitting + per-part images work), with Hindi/Hinglish voiceover and
 * Indian-origin people. Returns the reformatted prompt.
 */
async function enhancePrompt({ userPrompt, businessName, businessDetails, splitParts, chatLink }) {
  const sys = `You are a video-prompt FORMATTER, not a writer. You are given a prompt the user
ALREADY wrote. Rules:
- KEEP the user's concept, subject, story, scenes and wording as much as possible.
- Do NOT invent new ideas, products, or scenes. Do NOT change the meaning.
- You may lightly polish grammar/clarity and split the action across the required scenes/parts.
- Enforce safety only if needed: anonymous Indian-origin people (no real/named/famous individuals),
  no real brands/logos, no politics/violence/sexual/hateful content.
- Voiceover must be in natural HINDI/HINGLISH (Roman script).
- Output ONLY the structured format below — no preamble, no explanation, no markdown fences.`;

  const user = `Brand: ${businessName || "(unnamed)"}${businessDetails ? `\nBrand info: ${businessDetails}` : ""}

The user's prompt (KEEP its meaning & wording — only reformat + light polish + split):
"""
${userPrompt}
"""

Reformat the SAME content into EXACTLY this structure${splitParts ? " (PART 1 then PART 2, one continuous 20s video)" : ""}, and NOTHING else. You MUST include the literal markers ${splitParts ? '"PART 1" and "PART 2"' : '"PART 1"'}:

${houseFormatBlock(splitParts)}`;

  const res = await groq.chat.completions.create({ _chatLink: chatLink,
    model: MODEL,
    temperature: 0.4,   // low — we're reformatting, not brainstorming
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
// ChatGPT (web UI) often wraps JSON in prose or ```code fences```. Pull the
// first {...} object out and parse it. Returns null if nothing parseable.
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  // Try direct parse first.
  try { return JSON.parse(s); } catch {}
  // Otherwise grab the outermost {...} block and parse that.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    let block = s.slice(start, end + 1);
    try { return JSON.parse(block); } catch {}
    // common web-UI artifacts: smart quotes, trailing commas
    block = block
      .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(block); } catch {}
  }
  return null;
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
  const sys = `You write YouTube Shorts metadata. Output ONE raw JSON object and NOTHING else —
no explanation, no markdown, no code fences.`;
  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || ""}
Video topic: ${topic || ""}
Video description (prompt used): ${prompt || ""}
${defaultTags ? `Always-include tags: ${defaultTags}` : ""}

Return ONLY this JSON object (fill every field, no empty strings):
{"title":"catchy title <=90 chars","description":"2-4 line engaging description","hashtags":"#a #b #c (3-6 hashtags)","tags":"comma,separated,tags (8-15 tags)"}`;

  let content = "";
  try {
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
    content = res.choices[0]?.message?.content || "";
  } catch (e) {
    console.log("[groq] generateYouTubeMeta request failed:", e.message);
  }

  const parsed = parseJsonLoose(content);
  if (parsed && (parsed.title || parsed.description || parsed.tags || parsed.hashtags)) {
    return {
      title: parsed.title || topic || businessName,
      description: parsed.description || "",
      hashtags: parsed.hashtags || "",
      tags: parsed.tags || defaultTags || ""
    };
  }

  // Couldn't parse JSON — say so loudly (don't silently ship empty metadata).
  console.log("[groq] generateYouTubeMeta: could not parse JSON from ChatGPT; raw reply was:\n" + content.slice(0, 300));
  return { title: topic || businessName, description: "", hashtags: "", tags: defaultTags || "" };
}

/**
 * Generate a Flow-ready prompt from a news / RSS item. To stay Veo-safe, the
 * (possibly political/real-world) headline is FIRST distilled to a neutral,
 * evergreen THEME — then that safe theme is fed into the SAME unified house
 * template as the calendar (two-part 0-10 / 10-20, scene numbering, on-screen
 * text, effects, Hindi/Hinglish voiceover, Indian-origin people). Pass
 * splitParts=true (from client.split_parts) to get the 20-second two-part video.
 */
async function generateNewsPrompt({ businessName, businessDetails, title, summary, splitParts, chatLink }) {
  // PASS 1 — distill the headline down to ONE safe, generic, apolitical theme.
  // The raw headline is used ONLY here and never reaches the video prompt.
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

  // PASS 2 — reuse the SAME house template as the calendar, with the safe theme
  // as the topic. This gives RSS videos the identical two-part (0-10 / 10-20)
  // structure, Hinglish voiceover, on-screen text and effects.
  return generatePrompt({
    businessName,
    businessDetails,
    topic: theme,
    hook: "",
    splitParts,          // true → 20-second two-part video (same as calendar)
    chatLink
  });
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

module.exports = { generatePrompt, enhancePrompt, generateImage, splitPromptParts, extractPartImages, sanitizePrompt, generateNewsPrompt, generateCalendar, generateYouTubeMeta, generateVoiceScript, promptStyles };
