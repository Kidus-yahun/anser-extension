/**
 * Anser - Multi-Provider AI MCQ Solver
 * Background Service Worker (Manifest V3)
 * Supports: Gemini, OpenAI, Anthropic, OpenRouter, Groq, Custom OpenAI-Compatible
 */

importScripts("config.js", "textutils.js", "subjects.js", "solver.js");

const DEFAULT_MODEL = "gemini-2.5-flash";

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── Provider Configuration ───────────────────────────────────────────────────

const PROVIDER_ENDPOINTS = {
  gemini: {
    modelsUrl: (apiKey) => `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    chatUrl: (apiKey, model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    authHeader: () => ({}),
  },
  openai: {
    modelsUrl: () => "https://api.openai.com/v1/models",
    chatUrl: () => "https://api.openai.com/v1/chat/completions",
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  },
  anthropic: {
    modelsUrl: () => "https://api.anthropic.com/v1/models",
    chatUrl: () => "https://api.anthropic.com/v1/messages",
    authHeader: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    }),
  },
  openrouter: {
    modelsUrl: () => "https://openrouter.ai/api/v1/models",
    chatUrl: () => "https://openrouter.ai/api/v1/chat/completions",
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  },
  groq: {
    modelsUrl: () => "https://api.groq.com/openai/v1/models",
    chatUrl: () => "https://api.groq.com/openai/v1/chat/completions",
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  },
  custom: {
    modelsUrl: (apiKey, customBaseUrl) => `${customBaseUrl}/models`,
    chatUrl: (apiKey, model, customBaseUrl) => `${customBaseUrl}/chat/completions`,
    authHeader: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  }
};

// ─── Initialize default settings ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["geminiApiKey", "selectedModel", "actionType", "inputMethod", "consensusMode", "stealthMode", "aiProvider", "customBaseUrl"], (data) => {
    chrome.storage.local.set({
      geminiApiKey: data.geminiApiKey || "",
      selectedModel: data.selectedModel || DEFAULT_MODEL,
      actionType: data.actionType || "highlight",
      inputMethod: data.inputMethod || "dom",
      consensusMode: data.consensusMode !== undefined ? data.consensusMode : true,
      stealthMode: data.stealthMode !== undefined ? data.stealthMode : false,
      aiProvider: data.aiProvider || "gemini",
      customBaseUrl: data.customBaseUrl || ""
    });
  });
});

// Listen for global shortcut commands (Alt+Q)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "solve_question") {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !tab.url) return;

      // Skip internal browser pages where content scripts cannot run
      if (/^(?:chrome|edge|about|devtools|chrome-extension):\/\//i.test(tab.url)) {
        return;
      }

      // Try sending message; if content script is missing, dynamically inject it and retry
      chrome.tabs.sendMessage(tab.id, { action: "TRIGGER_SOLVE" }, async () => {
        if (chrome.runtime.lastError) {
          // Content script not yet injected into this tab (e.g. tab opened before extension reloaded)
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["textutils.js", "content.js"]
            });
            await chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ["content.css"]
            });
            // Retry sending trigger to newly injected content script
            chrome.tabs.sendMessage(tab.id, { action: "TRIGGER_SOLVE" }, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch (injectErr) {
            // Cannot script this tab (e.g. restricted site), safely ignore
          }
        }
      });
    } catch (e) {
      // Safely ignore
    }
  }
});

// Handle incoming messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "FETCH_MODELS") {
    handleFetchModels(request.apiKey, request.provider, request.customBaseUrl)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "SOLVE_QUESTION") {
    try {
      handleSolveQuestion(request, sender.tab)
        .then((res) => {
          try { sendResponse(res); } catch (e) {}
        })
        .catch((err) => {
          try { sendResponse({ success: false, error: err?.message || String(err) }); } catch (e) {}
        });
    } catch (err) {
      sendResponse({ success: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (request.action === "LOG_MISS") {
    saveMiss(request.miss).then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "GET_QUESTION_BANK") {
    chrome.storage.local.get(["questionBank"], (data) => {
      const bank = Array.isArray(data.questionBank) ? data.questionBank : [];
      sendResponse({ success: true, count: bank.length, bank: bank });
    });
    return true;
  }

  if (request.action === "CLEAR_QUESTION_BANK") {
    chrome.storage.local.set({ questionBank: [] }, () => {
      sendResponse({ success: true, count: 0, bank: [] });
    });
    return true;
  }

  if (request.action === "DELETE_QUESTION_BANK_ITEM") {
    chrome.storage.local.get(["questionBank"], (data) => {
      let bank = Array.isArray(data.questionBank) ? data.questionBank : [];
      bank = bank.filter((item) => item.id !== request.id);
      chrome.storage.local.set({ questionBank: bank }, () => {
        sendResponse({ success: true, count: bank.length, bank: bank });
      });
    });
    return true;
  }
});

// ─── System Prompt ────────────────────────────────────────────────────────────

const VISION_SYSTEM_INSTRUCTION = `You are an authoritative, world-class multiple-choice quiz solver.
Analyze this quiz screenshot and determine the correct answer with uncompromising accuracy.

Follow this rigorous verification protocol:
1. FAITHFUL CHARACTER TRANSCRIPTION:
   - Transcribe the Amharic question and all 4 options verbatim, glyph-by-glyph.
   - Do NOT substitute unfamiliar words or foreign names with common ones based on topic expectations.
2. CONSTRAINT & NEGATION DETECTION:
   - Detect if the question contains negative phrasing or exceptions (e.g. "አይደለም", "ያልሆነው/ያልሆነችው", "የማይካተተው", "የተሳሳተው", "NOT", "EXCEPT").
   - Respect specified calendar systems (Ethiopian ዓ.ም vs Gregorian G.C./እ.ኤ.አ) and measurement units.
3. DECISIVE FACTUAL VERIFICATION:
   - Validate the fact against verifiable historical, scientific, or geographical truth.
   - Actively guard against deceptive near-miss distractors (close dates, similar names).
   - In 1-2 concise sentences, prove why the selected choice is factually correct.
4. FINAL CONCLUSION:
   - Conclude with the exact 0-based choice index (0 for ሀ/A, 1 for ለ/B, 2 for ሐ/C, 3 for መ/D) and exact option text.

Return ONLY valid JSON without markdown fences:
{
  "question": "<transcribed question in Amharic>",
  "options": ["<opt 0>", "<opt 1>", "<opt 2>", "<opt 3>"],
  "reasoning": "<concise 1-2 sentence proof of correctness>",
  "choice_index": <0, 1, 2, or 3>,
  "choice_text": "<exact text of the chosen correct option>"
}`;

// ─── Provider-Specific API Adapters ───────────────────────────────────────────

/**
 * Build a chat completion request body for OpenAI-compatible APIs
 */
function buildOpenAITextBody(model, systemPrompt, userPrompt) {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 300,
    temperature: 0.0,
    response_format: { type: "json_object" }
  };
}

function buildOpenAIVisionBody(model, base64Data) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_SYSTEM_INSTRUCTION },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Data}`, detail: "high" }
          }
        ]
      }
    ],
    max_tokens: 800,
    temperature: 0.0,
    response_format: { type: "json_object" }
  };
}

function buildAnthropicTextBody(model, systemPrompt, userPrompt) {
  return {
    model,
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt }
    ],
    max_tokens: 300,
    temperature: 0.0
  };
}

function buildAnthropicVisionBody(model, base64Data) {
  return {
    model,
    system: VISION_SYSTEM_INSTRUCTION,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64Data
            }
          },
          { type: "text", text: "Analyze this quiz screenshot and return the JSON result." }
        ]
      }
    ],
    max_tokens: 800,
    temperature: 0.0
  };
}

function buildGeminiTextBody(systemPrompt, userPrompt) {
  return {
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 250,
      temperature: 0.0
    }
  };
}

function buildGeminiVisionBody(base64Data) {
  return {
    contents: [
      {
        parts: [
          { text: VISION_SYSTEM_INSTRUCTION },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 800,
      temperature: 0.0
    }
  };
}

/**
 * Extract text result from provider-specific API response
 */
function extractResponseText(provider, data) {
  if (provider === "gemini") {
    if (data.error) throw new Error(data.error.message || "Gemini API error");
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((pt) => !pt.thought && pt.text).map((pt) => pt.text).join("");
    if (!text) {
      const why = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "empty reply";
      throw new Error(`No answer returned by Gemini (${why})`);
    }
    return text;
  }
  if (provider === "anthropic") {
    if (data.error) throw new Error(data.error.message || "Anthropic API error");
    const block = data.content?.find((b) => b.type === "text");
    if (!block?.text) throw new Error("No answer returned by Anthropic");
    return block.text;
  }
  // OpenAI-compatible (openai, openrouter, groq, custom)
  if (data.error) throw new Error(data.error.message || "API error");
  const msg = data.choices?.[0]?.message;
  let text = (msg?.content || "").trim();
  if (!text && msg?.reasoning) {
    text = msg.reasoning.trim();
  }
  if (!text) throw new Error("No answer returned by model");
  return text;
}

/**
 * Generic API call to any provider
 */
async function callProviderAPI(provider, apiKey, model, systemPrompt, userPrompt, customBaseUrl, timeoutMs = 8000) {
  const providerConfig = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;
  const url = provider === "gemini"
    ? providerConfig.chatUrl(apiKey, model)
    : providerConfig.chatUrl(apiKey, model, customBaseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...providerConfig.authHeader(apiKey)
  };

  let body;
  if (provider === "gemini") {
    body = buildGeminiTextBody(systemPrompt, userPrompt);
  } else if (provider === "anthropic") {
    body = buildAnthropicTextBody(model, systemPrompt, userPrompt);
  } else {
    body = buildOpenAITextBody(model, systemPrompt, userPrompt);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body)
  });

  const data = await res.json();
  return extractResponseText(provider, data);
}

/**
 * Vision API call to any provider
 */
async function callProviderVisionAPI(provider, apiKey, model, base64Data, customBaseUrl, timeoutMs = 12000) {
  const providerConfig = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;

  // Resolve a vision-capable model
  let visionModel = model;
  if (provider === "gemini") {
    // Gemini flash-lite or tuned/text models do not support image input modality.
    // Automatically route image requests to gemini-2.5-flash:
    if (!visionModel || /flash-lite|lite|text|tuned/i.test(visionModel)) {
      visionModel = "gemini-2.5-flash";
    }
  } else if (provider === "openai") {
    if (!/4o|vision/i.test(visionModel)) {
      visionModel = "gpt-4o-mini";
    }
  } else if (provider === "anthropic") {
    if (!/claude-3/i.test(visionModel)) {
      visionModel = "claude-3-5-haiku-20241022";
    }
  } else if (provider === "groq") {
    if (!/vision/i.test(visionModel)) {
      visionModel = "llama-3.2-11b-vision-preview";
    }
  }

  const headers = {
    "Content-Type": "application/json",
    ...providerConfig.authHeader(apiKey)
  };

  const executeCall = async (targetModel) => {
    const url = provider === "gemini"
      ? providerConfig.chatUrl(apiKey, targetModel)
      : providerConfig.chatUrl(apiKey, targetModel, customBaseUrl);

    let body;
    if (provider === "gemini") {
      body = buildGeminiVisionBody(base64Data);
    } else if (provider === "anthropic") {
      body = buildAnthropicVisionBody(targetModel, base64Data);
    } else {
      body = buildOpenAIVisionBody(targetModel, base64Data);
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body)
    });

    return await res.json();
  };

  let data = await executeCall(visionModel);

  // If Gemini reports image input modality not enabled, immediately fall back to gemini-1.5-flash or gemini-2.5-flash
  if (provider === "gemini" && data?.error && /image.*modality.*not enabled/i.test(data.error.message || "")) {
    const fallbackModel = visionModel === "gemini-1.5-flash" ? "gemini-2.5-flash" : "gemini-1.5-flash";
    data = await executeCall(fallbackModel);
  }

  return extractResponseText(provider, data);
}

// ─── Reasoning-capable text call (used by solver.js) ─────────────────────────

const _paramDropCache = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiThinkingConfig(model, level, budgets) {
  if (!level || level === "default") return null;
  if (/gemini-3/i.test(model)) return { thinkingLevel: level === "off" ? "minimal" : level };
  if (/gemini-2\.5/i.test(model)) return { thinkingBudget: level === "off" ? 0 : (budgets && budgets[level]) || 4096 };
  return null;
}

function buildReasoningBody(provider, model, systemPrompt, userPrompt, o, dropped) {
  if (provider === "gemini") {
    const generationConfig = { maxOutputTokens: o.maxOutputTokens };
    if (!dropped.temperature) generationConfig.temperature = o.temperature;
    if (!dropped.thinking) {
      const tc = geminiThinkingConfig(model, o.thinkingLevel, o.thinkingBudgets);
      if (tc) generationConfig.thinkingConfig = tc;
    }
    return {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig
    };
  }
  if (provider === "anthropic") {
    const body = {
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: Math.min(o.maxOutputTokens, 4096)
    };
    if (!dropped.temperature) body.temperature = Math.min(o.temperature, 1);
    return body;
  }
  // OpenAI-compatible (openai, openrouter, groq, custom)
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  body[dropped.maxCompletion ? "max_completion_tokens" : "max_tokens"] = o.maxOutputTokens;
  if (!dropped.temperature) body.temperature = o.temperature;
  return body;
}

/**
 * Free-text model call with: per-call timeout, exponential backoff on 429/503,
 * and automatic fallback when a model rejects temperature / thinking / max_tokens.
 */
async function callModelText(provider, apiKey, model, systemPrompt, userPrompt, customBaseUrl, opts) {
  const cfg = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;
  const url = provider === "gemini" ? cfg.chatUrl(apiKey, model) : cfg.chatUrl(apiKey, model, customBaseUrl);
  const headers = { "Content-Type": "application/json", ...cfg.authHeader(apiKey) };
  // Remember which parameters this model rejected so parallel votes don't each rediscover it
  const cacheKey = `${provider}|${model}`;
  const dropped = (_paramDropCache[cacheKey] = _paramDropCache[cacheKey] ||
    { temperature: false, thinking: false, maxCompletion: false });
  let backoffs = 0;

  for (;;) {
    const body = buildReasoningBody(provider, model, systemPrompt, userPrompt, opts, dropped);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs || 45000)
      });
    } catch (e) {
      throw new Error(e.name === "TimeoutError" ? "Model call timed out" : `Network error: ${e.message}`);
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }

    if (res.status === 429 || res.status === 503) {
      const msg = data?.error?.message || "";
      if (/quota/i.test(msg) || /resource_exhausted/i.test(data?.error?.status || "")) {
        const err = new Error("Google Gemini daily free quota exceeded (429). Please create a new free API key at aistudio.google.com or switch to Groq.");
        err.fatal = true;
        throw err;
      }
      if (backoffs >= (opts.maxRetries429 ?? 2)) throw new Error(`Rate limited / overloaded (HTTP ${res.status}). Try again in a moment.`);
      await sleep(600 * 2 ** backoffs);
      backoffs++;
      continue;
    }

    if (!res.ok) {
      const msg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
      if (res.status === 400) {
        if (!dropped.thinking && /thinking/i.test(msg)) { dropped.thinking = true; continue; }
        if (!dropped.temperature && /temperature/i.test(msg)) { dropped.temperature = true; continue; }
        if (!dropped.maxCompletion && /max_completion_tokens/i.test(msg)) { dropped.maxCompletion = true; continue; }
      }
      const err = new Error(msg);
      if ([400, 401, 403, 404].includes(res.status)) err.fatal = true;
      throw err;
    }
    return extractResponseText(provider, data);
  }
}

// ─── Fetch Models ─────────────────────────────────────────────────────────────

async function handleFetchModels(apiKey, provider, customBaseUrl) {
  provider = provider || "gemini";

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { success: false, error: "Please enter your API Key." };
  }

  const cleanKey = apiKey.trim();

  if (provider === "gemini") {
    return fetchGeminiModels(cleanKey);
  } else if (provider === "anthropic") {
    return fetchAnthropicModels(cleanKey);
  } else if (provider === "openrouter") {
    return fetchOpenRouterModels(cleanKey);
  } else {
    // openai, groq, custom — all OpenAI-compatible
    const providerConfig = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;
    return fetchOpenAICompatibleModels(cleanKey, providerConfig.modelsUrl(cleanKey, customBaseUrl), providerConfig.authHeader(cleanKey));
  }
}

async function fetchGeminiModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();

  if (data.error) {
    return { success: false, error: data.error.message || "Failed to fetch models" };
  }
  if (!data.models) {
    return { success: false, error: "No models found for this API key" };
  }

  const validModels = data.models
    .filter((m) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => ({
      id: m.name.replace("models/", ""),
      displayName: `⚡ ${m.displayName || m.name.replace("models/", "")}`,
      description: m.description || ""
    }));

  validModels.sort((a, b) => {
    const aFlash = a.id.toLowerCase().includes("flash");
    const bFlash = b.id.toLowerCase().includes("flash");
    if (aFlash && !bFlash) return -1;
    if (!aFlash && bFlash) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return { success: true, models: validModels };
}

async function fetchAnthropicModels(apiKey) {
  // Anthropic's /v1/models endpoint may not be available for all keys;
  // return a curated list of known models
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      }
    });
    const data = await res.json();
    if (data.data && Array.isArray(data.data)) {
      const models = data.data.map((m) => ({
        id: m.id,
        displayName: `🧠 ${m.display_name || m.id}`
      }));
      if (models.length > 0) return { success: true, models };
    }
  } catch (e) {
    // Fallback to curated list
  }

  return {
    success: true,
    models: [
      { id: "claude-sonnet-4-20250514", displayName: "🧠 Claude Sonnet 4" },
      { id: "claude-3-5-sonnet-20241022", displayName: "🧠 Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-20241022", displayName: "⚡ Claude 3.5 Haiku" },
      { id: "claude-3-haiku-20240307", displayName: "⚡ Claude 3 Haiku" },
      { id: "claude-3-opus-20240229", displayName: "🧠 Claude 3 Opus" }
    ]
  };
}

async function fetchOpenRouterModels(apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const data = await res.json();

  if (data.error) {
    return { success: false, error: data.error.message || "Failed to fetch models" };
  }

  const models = (data.data || [])
    .filter((m) => m.id)
    .slice(0, 100) // Limit for UI
    .map((m) => ({
      id: m.id,
      displayName: m.name || m.id
    }));

  if (models.length === 0) {
    return { success: false, error: "No models found" };
  }

  return { success: true, models };
}

async function fetchOpenAICompatibleModels(apiKey, url, headers) {
  const res = await fetch(url, { headers: { ...headers, "Content-Type": "application/json" } });
  const data = await res.json();

  if (data.error) {
    return { success: false, error: data.error.message || "Failed to fetch models" };
  }

  const models = (data.data || [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id,
      displayName: m.id
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) {
    return { success: false, error: "No models found for this API key" };
  }

  return { success: true, models };
}

// ─── Solve Question ───────────────────────────────────────────────────────────

async function handleSolveQuestion(request, senderTab) {
  const config = await chrome.storage.local.get([
    "geminiApiKey",
    "selectedModel",
    "actionType",
    "inputMethod",
    "consensusMode",
    "aiProvider",
    "customBaseUrl"
  ]);

  const apiKey = (config.geminiApiKey || "").trim();
  if (!apiKey) {
    throw new Error("API Key is missing. Click the Anser extension icon and enter your API Key.");
  }
  const provider = config.aiProvider || "gemini";
  const model = config.selectedModel || DEFAULT_MODEL;
  const actionType = config.actionType || "highlight";
  const inputMethod = request.preferredInputMethod || config.inputMethod || "dom";
  const consensusMode = config.consensusMode !== false; // = voting enabled
  const customBaseUrl = (config.customBaseUrl || "").trim();

  const t0 = Date.now();

  if (inputMethod === "vision") {
    // ── Vision Mode ──────────────────────────────────────────────────────────
    const windowId = senderTab?.windowId || null;
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 90
    });

    let base64Data = screenshotDataUrl.replace(/^data:image\/jpeg;base64,/, "");

    // High-resolution tight crop if cropArea is provided
    if (request.cropArea && request.cropArea.width > 50 && request.cropArea.height > 50) {
      try {
        const resBlob = await fetch(screenshotDataUrl);
        const blob = await resBlob.blob();
        const fullBitmap = await createImageBitmap(blob);

        const scaleX = request.cropArea.viewportWidth
          ? fullBitmap.width / request.cropArea.viewportWidth
          : (request.cropArea.dpr || 1);
        const scaleY = request.cropArea.viewportHeight
          ? fullBitmap.height / request.cropArea.viewportHeight
          : scaleX;

        const rawLeft = request.cropArea.left !== undefined ? request.cropArea.left : (request.cropArea.x / scaleX);
        const rawTop = request.cropArea.top !== undefined ? request.cropArea.top : (request.cropArea.y / scaleY);
        const rawW = request.cropArea.width !== undefined
          ? (request.cropArea.viewportWidth ? request.cropArea.width : request.cropArea.width / scaleX)
          : fullBitmap.width / scaleX;
        const rawH = request.cropArea.height !== undefined
          ? (request.cropArea.viewportHeight ? request.cropArea.height : request.cropArea.height / scaleY)
          : fullBitmap.height / scaleY;

        const x = Math.max(0, Math.min(Math.round(rawLeft * scaleX), fullBitmap.width - 20));
        const y = Math.max(0, Math.min(Math.round(rawTop * scaleY), fullBitmap.height - 20));
        const w = Math.min(Math.round(rawW * scaleX), fullBitmap.width - x);
        const h = Math.min(Math.round(rawH * scaleY), fullBitmap.height - y);

        if (w > 50 && h > 50) {
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(fullBitmap, x, y, w, h, 0, 0, w, h);
          const croppedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
          const arrayBuf = await croppedBlob.arrayBuffer();
          base64Data = arrayBufferToBase64(arrayBuf);
        }
      } catch (cropErr) {
        console.warn("High-DPI crop fallback to full screenshot:", cropErr);
      }
    }

    const rawText = await callProviderVisionAPI(provider, apiKey, model, base64Data, customBaseUrl);
    const latencyMs = Date.now() - t0;

    const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanJson);

    await saveToQuestionBank({
      question: parsed.question || request.question || "Visual Quiz Question",
      choices: parsed.options || [],
      answer_index: typeof parsed.choice_index === "number" ? parsed.choice_index : 0,
      answer_text: parsed.choice_text || "",
      reasoning: parsed.reasoning || "",
      method: `Vision (${provider}/${model})`,
      pageUrl: request.pageUrl,
      pageTitle: request.pageTitle
    });

    return {
      success: true,
      result: parsed,
      latencyMs,
      actionType,
      methodUsed: "vision",
      modelUsed: model
    };
  } else {
    // ── DOM Text Mode ────────────────────────────────────────────────────────
    const { question, choices } = request;
    if (!question || !choices || choices.length === 0) {
      throw new Error("Missing question text or choices");
    }

    // Accuracy engine: English reasoning + N votes + verification (all providers)
    const result = await solveMCQ({
      question,
      choices,
      hasImage: !!request.hasImage,
      provider,
      apiKey,
      model,
      customBaseUrl,
      votesOverride: consensusMode ? undefined : 1
    });
    const latencyMs = Date.now() - t0;
    const methodLabel = `${provider}/${model} · ${result.subject} · ${result.consensus}`;

    await saveToQuestionBank({
      question: question,
      choices: result.choices,
      answer_index: result.choice_index,
      answer_text: result.choice_text,
      reasoning: result.reasoning,
      method: methodLabel,
      pageUrl: request.pageUrl,
      pageTitle: request.pageTitle
    });

    return {
      success: true,
      result,
      latencyMs,
      actionType,
      methodUsed: "dom",
      modelUsed: model
    };
  }
}

// ─── Question Bank ────────────────────────────────────────────────────────────

async function saveToQuestionBank(entry) {
  try {
    if (!entry || !entry.question) return;

    const data = await chrome.storage.local.get(["questionBank"]);
    let bank = Array.isArray(data.questionBank) ? data.questionBank : [];

    const normQ = entry.question.trim().toLowerCase().replace(/\s+/g, " ");

    const existingIdx = bank.findIndex(
      (item) => item.question && item.question.trim().toLowerCase().replace(/\s+/g, " ") === normQ
    );

    const newRecord = {
      id: existingIdx >= 0 ? bank[existingIdx].id : `qb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      question: entry.question.trim(),
      choices: Array.isArray(entry.choices) ? entry.choices : [],
      answer_index: typeof entry.answer_index === "number" ? entry.answer_index : 0,
      answer_text: entry.answer_text || "",
      reasoning: entry.reasoning || "",
      method: entry.method || "Fast DOM",
      pageUrl: entry.pageUrl || "",
      pageTitle: entry.pageTitle || ""
    };

    if (existingIdx >= 0) {
      bank.splice(existingIdx, 1);
    }
    bank.unshift(newRecord);

    if (bank.length > 1000) {
      bank = bank.slice(0, 1000);
    }

    await chrome.storage.local.set({ questionBank: bank });
    console.log(`[Anser Bank]: Saved "${newRecord.question.substring(0, 35)}..." (Total: ${bank.length})`);
  } catch (err) {
    console.error("[Anser Bank Error]: Failed to save question to bank:", err);
  }
}

// ─── Miss Log (questions the model got wrong) ────────────────────────────────

async function saveMiss(miss) {
  if (!miss || !miss.question) return { success: false, error: "Empty miss" };
  const { missLog } = await chrome.storage.local.get(["missLog"]);
  const log = Array.isArray(missLog) ? missLog : [];
  const entry = {
    question: miss.question,
    options: miss.options || [],
    model_answer: miss.model_answer,
    correct_answer: miss.correct_answer,
    subject: miss.subject || "General",
    timestamp: new Date().toISOString()
  };
  // Replace an older entry for the same question
  const idx = log.findIndex((m) => m.question === entry.question);
  if (idx >= 0) log.splice(idx, 1);
  log.unshift(entry);
  await chrome.storage.local.set({ missLog: log.slice(0, 500) });
  return { success: true, count: Math.min(log.length, 500) };
}
