// Per-client prompt styles. Each style guides Groq to produce a Flow/Omni prompt
// in a specific shape. `bakedSpeech: true` means the prompt makes characters speak
// aloud (so we DON'T add a separate TTS voiceover for that style).

const CORE = `Core rules (always apply):
- The video MUST be exactly 10 seconds long.
- It MUST be made for Google Flow "Omni". Vertical 9:16, social-ready.
- Be concrete and cinematic: subject, action, camera movement, lighting, mood.
- Output a single ready-to-paste prompt. No markdown fences, no preamble.`;

const STYLES = {
  default: {
    label: "Default (scene cuts + spoken voiceover)",
    bakedSpeech: true,
    instruction: `${CORE}
Write the prompt as SCENE CUTS with an OFF-SCREEN voiceover (do not show a person speaking to
camera / lip-syncing). Use EXACTLY this shape:

A 10-second cinematic vertical 9:16 video.
Scene 1 (0-2 sec): <establishing shot>
Scene 2 (2-4 sec): <detail / action>
Scene 3 (4-6 sec): <feature or benefit visual>
Scene 4 (6-8 sec): <context / lifestyle visual>
Scene 5 (8-10 sec): <closing shot>
Voiceover (off-screen, spoken clearly): "<~28 words of engaging narration>"
Style: <cinematic descriptors, lighting, mood, pacing>
No on-screen captions or logos (branding is added later). No real public figures.`
  },

  cinematic_ad: {
    label: "Cinematic ad (timed on-screen text)",
    bakedSpeech: false,
    instruction: `${CORE}
Write the prompt in EXACTLY this structure:

Google Omni Prompt:
<one cinematic vertical paragraph: ultra-realistic 4K, drone/camera moves, lighting, realistic environment, premium corporate/ad style>

On-Screen Text:
0-2 Sec
<2 short punchy lines, emojis allowed>
2-5 Sec
<2 short lines>
5-8 Sec
<2 short lines>
8-10 Sec
<2 short lines>

Style: <pacing, mood, trust signals, background music, transitions>

Keep it to ~10 seconds. Do NOT depict real, identifiable public figures.`
  },

  character_explainer: {
    label: "Character explainer (spoken scenes, kids)",
    bakedSpeech: true,
    instruction: `${CORE}
Write a scene-by-scene prompt where a cute cartoon character SPEAKS short lines ALOUD
(this provides the audio — so no separate narration is needed). Use EXACTLY this shape:

Prompt:
<1-2 sentences introducing the character and the bright, friendly setting>
Scene 1 (0-2 sec)
<action> and the character says, "<short spoken line>"
Scene 2 (2-4 sec)
<action> and says, "<short line>"
Scene 3 (4-6 sec)
<action> and says, "<short line>"
Scene 4 (6-8 sec)
<action> and says, "<short line>"
Scene 5 (8-10 sec)
<action> and says, "<short line>"
Style: <Pixar-quality 3D cartoon, kid-friendly, vibrant colors, smooth animation, high energy>`
  },

  product_showcase: {
    label: "Product showcase (e-commerce)",
    bakedSpeech: false,
    instruction: `${CORE}
Write the prompt in this structure:

Google Omni Prompt:
<cinematic vertical product hero shot: rotating or close-up product, studio or lifestyle setting,
soft premium lighting, shallow depth of field, ultra-realistic 4K>

On-Screen Text:
0-3 Sec
<product name + hook>
3-7 Sec
<2 key benefits>
7-10 Sec
<call to action>

Style: <modern, premium, smooth transitions, upbeat background music>
No real public figures.`
  }
};

function getStyle(key) {
  return STYLES[key] || STYLES.default;
}

function list() {
  return Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, bakedSpeech: s.bakedSpeech }));
}

module.exports = { STYLES, getStyle, list, CORE };