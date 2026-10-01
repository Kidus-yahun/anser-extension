/**
 * Anser - Multi-Provider AI MCQ Solver
 * Background Service Worker (Manifest V3)
 * Supports: Gemini, OpenAI, Anthropic, OpenRouter, Groq, Custom OpenAI-Compatible
 */

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

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
chrome.commands.onCommand.addListener((command) => {
  if (command === "solve_question") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "TRIGGER_SOLVE" });
      }
    });
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
    handleSolveQuestion(request, sender.tab)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
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

const COGNITIVE_SYSTEM_INSTRUCTION = `You are an authoritative, world-class multiple-choice exam solver with zero error tolerance.
Your task is to determine the single correct choice with absolute factual precision.

EXECUTE THIS 4-STEP REASONING PROTOCOL BEFORE SELECTING:
1. CONSTRAINT & POLARITY AUDIT:
   - Identify if the question is NEGATIVE or EXCLUSIVE (e.g., "NOT", "EXCEPT", "አይደለም", "ያልሆነው/ያልሆነችው", "የማይካተተው", "የተሳሳተው", "ከ... ውጪ").
   - Check specified calendar systems: Ethiopian Calendar (ዓ.ም) is ~7-8 years behind Gregorian Calendar (G.C./እ.ኤ.አ).
   - Check measurement units or directional constraints.
2. CORE ENTITY & PREDICATE ISOLATION:
   - Isolate the EXACT subject entity and the precise attribute queried (e.g., "former country name" vs "capital city", "birthplace" vs "burial place").
3. DISTRACTOR ELIMINATION:
   - Actively identify and reject plausible "trap" distractors (e.g., associated capitals, neighboring bodies of water, similar-sounding names, adjacent dates).
4. DECISIVE VERIFICATION:
   - State the definitive proof of truth in 1 concise sentence (max 25 words).
   - Output the exact 0-based index and verbatim choice text.

Return ONLY a valid JSON object matching this schema without markdown fences:
{
  "reasoning": "<1 concise factual proof sentence>",
  "choice_index": <0-based integer index of correct option>,
  "choice_text": "<exact verbatim text of the correct option>"
}`;

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

function buildCognitiveDOMPrompt(question, choices) {
  return `[QUESTION]
${question}

[CHOICES]
${choices.map((c, i) => `${i}) ${c}`).join("\n")}

Apply the 4-step protocol and return the verified JSON:`;
}

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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No answer returned by Gemini");
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
  const text = data.choices?.[0]?.message?.content;
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
async function callProviderVisionAPI(provider, apiKey, model, base64Data, customBaseUrl, timeoutMs = 10000) {
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
    body = buildGeminiVisionBody(base64Data);
  } else if (provider === "anthropic") {
    body = buildAnthropicVisionBody(model, base64Data);
  } else {
    // OpenAI-compatible vision (openai, openrouter, groq, custom)
    body = buildOpenAIVisionBody(model, base64Data);
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

// ─── Single Model Query (used for consensus) ─────────────────────────────────

async function querySingleModel(modelName, apiKey, userPrompt, timeoutMs = 6000) {
  const t0 = Date.now();
  // Consensus mode only uses Gemini models
  const rawText = await callProviderAPI("gemini", apiKey, modelName, COGNITIVE_SYSTEM_INSTRUCTION, userPrompt, "", timeoutMs);
  const elapsed = Date.now() - t0;
  const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleanJson);
  return { model: modelName, elapsed, parsed };
}

/**
 * 3-Model Parallel Consensus Solver (Gemini only)
 */
async function solveDOMWithConsensus(question, choices, apiKey, primaryModel) {
  const promptText = buildCognitiveDOMPrompt(question, choices);

  const candidatePool = [
    primaryModel || "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash-lite"
  ];
  const uniqueModels = Array.from(new Set(candidatePool));
  if (uniqueModels.length < 3) {
    if (!uniqueModels.includes("gemini-3.5-flash")) uniqueModels.push("gemini-3.5-flash");
  }

  const settled = await Promise.allSettled(
    uniqueModels.slice(0, 3).map((m) => querySingleModel(m, apiKey, promptText, 5500))
  );

  const successful = settled
    .filter((s) => s.status === "fulfilled" && s.value?.parsed && typeof s.value.parsed.choice_index === "number")
    .map((s) => s.value);

  if (successful.length === 0) {
    const errors = settled.map((s) => s.reason?.message || "Failed").join("; ");
    throw new Error(`All parallel consensus models failed: ${errors}`);
  }

  const voteCounts = new Map();
  successful.forEach((s) => {
    const idx = s.parsed.choice_index;
    if (!voteCounts.has(idx)) {
      voteCounts.set(idx, { count: 0, sample: s });
    }
    voteCounts.get(idx).count++;
  });

  let winningIdx = -1;
  let maxVotes = 0;
  let winningSample = null;

  for (const [idx, data] of voteCounts.entries()) {
    if (data.count > maxVotes) {
      maxVotes = data.count;
      winningIdx = idx;
      winningSample = data.sample;
    }
  }

  const primaryResult = successful.find((s) => s.model === uniqueModels[0]);
  if (primaryResult && maxVotes === 1 && successful.length > 1) {
    winningSample = primaryResult;
    winningIdx = primaryResult.parsed.choice_index;
  }

  const consensusLabel = `${maxVotes}/${successful.length} consensus`;

  return {
    choice_index: winningIdx,
    choice_text: winningSample.parsed.choice_text,
    reasoning: winningSample.parsed.reasoning,
    consensus: consensusLabel,
    votes: maxVotes,
    totalVoters: successful.length,
    voters: successful.map((s) => `${s.model} (${s.elapsed}ms)`)
  };
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
  const consensusMode = config.consensusMode !== false && provider === "gemini";
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

    if (consensusMode) {
      // 3-Model Parallel Consensus (Gemini only)
      const consensusResult = await solveDOMWithConsensus(question, choices, apiKey, model);
      const latencyMs = Date.now() - t0;

      await saveToQuestionBank({
        question: question,
        choices: choices,
        answer_index: consensusResult.choice_index,
        answer_text: consensusResult.choice_text,
        reasoning: consensusResult.reasoning,
        method: `3-Model Consensus (${consensusResult.consensus})`,
        pageUrl: request.pageUrl,
        pageTitle: request.pageTitle
      });

      return {
        success: true,
        result: consensusResult,
        latencyMs,
        actionType,
        methodUsed: "dom_consensus",
        modelUsed: `3-Model Consensus (${consensusResult.consensus})`
      };
    }

    // Single model call via provider adapter
    const userPrompt = buildCognitiveDOMPrompt(question, choices);
    const rawText = await callProviderAPI(provider, apiKey, model, COGNITIVE_SYSTEM_INSTRUCTION, userPrompt, customBaseUrl);
    const latencyMs = Date.now() - t0;

    const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanJson);

    await saveToQuestionBank({
      question: question,
      choices: choices,
      answer_index: parsed.choice_index,
      answer_text: parsed.choice_text,
      reasoning: parsed.reasoning,
      method: `${provider}/${model}`,
      pageUrl: request.pageUrl,
      pageTitle: request.pageTitle
    });

    return {
      success: true,
      result: parsed,
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
