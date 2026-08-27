// ============================================================================
// lib/groq.js — DEPRECATED (use persistent ChatGPT profile instead)
// ============================================================================
// All text generation functions now throw errors directing to use the
// persistent ChatGPT profile in server.js:
// - generatePromptViaProfile() for prompts
// - generateImagesViaProfile() for images
// - Manual calendar topics (no auto-generation)
// ============================================================================

// Stub Groq SDK shim
const groq = {
  chat: {
    completions: {
      async create() {
        throw new Error("Groq not available — use persistent ChatGPT profile");
      }
    }
  }
};

// ============================================================================
// ALL THESE FUNCTIONS ARE DEPRECATED — THEY THROW ERRORS
// ============================================================================

async function generatePrompt() {
  throw new Error("generatePrompt via Groq is not available — use persistent ChatGPT profile (generatePromptViaProfile) instead");
}

async function generateNewsPrompt() {
  throw new Error("generateNewsPrompt via Groq is not available — use persistent ChatGPT profile instead");
}

async function generateCalendar() {
  throw new Error("generateCalendar via Groq is not available — add topics manually to the calendar in the dashboard");
}

function enhancePrompt(prompt) {
  throw new Error("enhancePrompt via Groq is not available");
}

function generateImage() {
  throw new Error("generateImage via Groq is not available — use persistent ChatGPT profile (generateImagesViaProfile) instead");
}

function splitPromptParts(prompt) {
  return (prompt || "").split(/PART\s+\d+/i).filter(Boolean);
}

function extractPartImages(prompt) {
  return [];
}

function sanitizePrompt(prompt) {
  return (prompt || "").trim();
}

function generateYouTubeMeta(title) {
  return { title: title || "", description: "", tags: [] };
}

function generateVoiceScript(prompt) {
  return prompt || "";
}

const promptStyles = {};

module.exports = { 
  generatePrompt, 
  enhancePrompt, 
  splitPromptParts, 
  extractPartImages, 
  sanitizePrompt, 
  generateNewsPrompt, 
  generateCalendar, 
  generateYouTubeMeta, 
  generateVoiceScript, 
  promptStyles 
};
