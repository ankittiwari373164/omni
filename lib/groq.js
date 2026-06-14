const Groq = require("groq-sdk");
const promptStyles = require("./prompt-styles");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "missing-set-GROQ_API_KEY" });
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

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
async function generatePrompt({ businessName, businessDetails, topic, hook, styleKey, styleInstruction, promptSample, splitParts }) {
  const instruction = styleInstruction || promptStyles.getStyle(styleKey).instruction;

  const sys = `You are a senior short-form video creative director writing prompts for the
Google Flow "Omni" text-to-video model.

${instruction}${promptSample ? `

IMPORTANT — match the STYLE, structure, length, and formatting of this example
prompt as closely as possible (adapt the content to the new topic, but keep the
same shape, tone, and level of detail):
--- EXAMPLE PROMPT ---
${promptSample}
--- END EXAMPLE ---` : ""}${splitParts ? `

This video is ONE continuous 20-second scene delivered as two 10-second clips
that will be concatenated back-to-back. They must feel like a single unbroken
shot, NOT two separate videos. Follow these continuity rules strictly:
- Same subject(s), wardrobe, location, lighting, color grade, time of day, and
  camera style across BOTH parts.
- PART 2 begins EXACTLY where PART 1 ends — same framing and subject position at
  the cut, as if the camera never stopped. Describe the end state of PART 1 and
  open PART 2 from that identical state so the join is seamless.
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

Write the single best prompt for this topic in the required format. Output ONLY the prompt.`;

  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    max_tokens: splitParts ? 1000 : 600,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

// Split a "PART 1:/PART 2:" prompt into parts. If no markers, returns [whole].
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
async function generateCalendar({ businessName, businessDetails, days = 7, startDate }) {
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

  const res = await groq.chat.completions.create({
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
    d.setDate(base.getDate() + (Number(it.day) ? Number(it.day) - 1 : i));
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
async function generateYouTubeMeta({ businessName, businessDetails, topic, prompt, defaultTags }) {
  const sys = `You write YouTube Shorts metadata. Return STRICT JSON only, no markdown.`;
  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || ""}
Video topic: ${topic || ""}
Video description (prompt used): ${prompt || ""}
${defaultTags ? `Always-include tags: ${defaultTags}` : ""}

Return JSON ONLY shaped like:
{"title":"<=90 chars catchy title","description":"2-4 line description","hashtags":"#a #b #c (3-6)","tags":"comma,separated,tags (8-15)"}`;

  const res = await groq.chat.completions.create({
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
async function generateNewsPrompt({ businessName, businessDetails, title, summary }) {
  const sys = `You write prompts for the Google Flow "Omni"/Veo text-to-video model, which can
generate spoken audio. Produce a 10-second vertical (9:16) news explainer as SCENE CUTS of
representative b-roll, narrated by an OFF-SCREEN voiceover (do NOT show a person speaking to
camera or lip-syncing — that causes policy rejections). Hard safety rules to avoid policy
violations: no real or identifiable public figures, no political figures, no logos/brands,
no violence, weapons, disasters, medical or graphic content; keep visuals neutral, generic and
symbolic. Output ONLY the prompt, no markdown.`;

  const user = `Channel: ${businessName}
Channel focus: ${businessDetails || "(news)"}
Headline: ${title}
Summary: ${summary || "(none)"}

Write the prompt in EXACTLY this scene-cut shape:

A 10-second cinematic vertical 9:16 news explainer, broadcast b-roll style.
Scene 1 (0-2 sec): <establishing representative shot for the topic>
Scene 2 (2-4 sec): <relevant detail / object / environment b-roll>
Scene 3 (4-6 sec): <a process, data, or context visual (charts, screens, abstract motion ok)>
Scene 4 (6-8 sec): <impact or everyday-life context visual>
Scene 5 (8-10 sec): <calm closing shot>
Voiceover (off-screen, spoken clearly across the clip): "<a neutral, accurate spoken summary of about 28-32 words>"
Style: clean broadcast b-roll, cinematic lighting, smooth cuts, ultra-realistic 4K, calm authoritative narration. No on-camera narrator, no real people, no logos, no text overlays.`;

  const res = await groq.chat.completions.create({
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
async function generateVoiceScript({ businessName, topic, prompt, seconds = 10 }) {
  const words = Math.round((seconds / 10) * 27);
  const sys = `You write punchy spoken voiceover lines for short vertical videos. Output ONLY the
words to be spoken — no stage directions, no quotes, no emojis, no hashtags, no markdown.`;
  const user = `Brand/channel: ${businessName}
Topic: ${topic || ""}
Scene being shown: ${prompt || ""}

Write a natural, engaging voiceover of about ${words} words (≈${seconds} seconds when read aloud)
that narrates this clip. Plain spoken sentences only.`;

  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    max_tokens: 200,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  return (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

module.exports = { generatePrompt, splitPromptParts, generateNewsPrompt, generateCalendar, generateYouTubeMeta, generateVoiceScript, promptStyles };const Groq = require("groq-sdk");
const promptStyles = require("./prompt-styles");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "missing-set-GROQ_API_KEY" });
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

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
async function generatePrompt({ businessName, businessDetails, topic, hook, styleKey, styleInstruction, promptSample, splitParts }) {
  const instruction = styleInstruction || promptStyles.getStyle(styleKey).instruction;

  const sys = `You are a senior short-form video creative director writing prompts for the
Google Flow "Omni" text-to-video model.

${instruction}${promptSample ? `

IMPORTANT — match the STYLE, structure, length, and formatting of this example
prompt as closely as possible (adapt the content to the new topic, but keep the
same shape, tone, and level of detail):
--- EXAMPLE PROMPT ---
${promptSample}
--- END EXAMPLE ---` : ""}${splitParts ? `

This video is ONE continuous 20-second scene delivered as two 10-second clips
that will be concatenated back-to-back. They must feel like a single unbroken
shot, NOT two separate videos. Follow these continuity rules strictly:
- Same subject(s), wardrobe, location, lighting, color grade, time of day, and
  camera style across BOTH parts.
- PART 2 begins EXACTLY where PART 1 ends — same framing and subject position at
  the cut, as if the camera never stopped. Describe the end state of PART 1 and
  open PART 2 from that identical state so the join is seamless.
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

Write the single best prompt for this topic in the required format. Output ONLY the prompt.`;

  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    max_tokens: splitParts ? 1000 : 600,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

// Split a "PART 1:/PART 2:" prompt into parts. If no markers, returns [whole].
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
async function generateCalendar({ businessName, businessDetails, days = 7, startDate }) {
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

  const res = await groq.chat.completions.create({
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
    d.setDate(base.getDate() + (Number(it.day) ? Number(it.day) - 1 : i));
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
async function generateYouTubeMeta({ businessName, businessDetails, topic, prompt, defaultTags }) {
  const sys = `You write YouTube Shorts metadata. Return STRICT JSON only, no markdown.`;
  const user = `Brand: ${businessName}
Brand brief: ${businessDetails || ""}
Video topic: ${topic || ""}
Video description (prompt used): ${prompt || ""}
${defaultTags ? `Always-include tags: ${defaultTags}` : ""}

Return JSON ONLY shaped like:
{"title":"<=90 chars catchy title","description":"2-4 line description","hashtags":"#a #b #c (3-6)","tags":"comma,separated,tags (8-15)"}`;

  const res = await groq.chat.completions.create({
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
async function generateNewsPrompt({ businessName, businessDetails, title, summary }) {
  const sys = `You write prompts for the Google Flow "Omni"/Veo text-to-video model, which can
generate spoken audio. Produce a 10-second vertical (9:16) news explainer as SCENE CUTS of
representative b-roll, narrated by an OFF-SCREEN voiceover (do NOT show a person speaking to
camera or lip-syncing — that causes policy rejections). Hard safety rules to avoid policy
violations: no real or identifiable public figures, no political figures, no logos/brands,
no violence, weapons, disasters, medical or graphic content; keep visuals neutral, generic and
symbolic. Output ONLY the prompt, no markdown.`;

  const user = `Channel: ${businessName}
Channel focus: ${businessDetails || "(news)"}
Headline: ${title}
Summary: ${summary || "(none)"}

Write the prompt in EXACTLY this scene-cut shape:

A 10-second cinematic vertical 9:16 news explainer, broadcast b-roll style.
Scene 1 (0-2 sec): <establishing representative shot for the topic>
Scene 2 (2-4 sec): <relevant detail / object / environment b-roll>
Scene 3 (4-6 sec): <a process, data, or context visual (charts, screens, abstract motion ok)>
Scene 4 (6-8 sec): <impact or everyday-life context visual>
Scene 5 (8-10 sec): <calm closing shot>
Voiceover (off-screen, spoken clearly across the clip): "<a neutral, accurate spoken summary of about 28-32 words>"
Style: clean broadcast b-roll, cinematic lighting, smooth cuts, ultra-realistic 4K, calm authoritative narration. No on-camera narrator, no real people, no logos, no text overlays.`;

  const res = await groq.chat.completions.create({
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
async function generateVoiceScript({ businessName, topic, prompt, seconds = 10 }) {
  const words = Math.round((seconds / 10) * 27);
  const sys = `You write punchy spoken voiceover lines for short vertical videos. Output ONLY the
words to be spoken — no stage directions, no quotes, no emojis, no hashtags, no markdown.`;
  const user = `Brand/channel: ${businessName}
Topic: ${topic || ""}
Scene being shown: ${prompt || ""}

Write a natural, engaging voiceover of about ${words} words (≈${seconds} seconds when read aloud)
that narrates this clip. Plain spoken sentences only.`;

  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    max_tokens: 200,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  return (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
}

module.exports = { generatePrompt, splitPromptParts, generateNewsPrompt, generateCalendar, generateYouTubeMeta, generateVoiceScript, promptStyles };