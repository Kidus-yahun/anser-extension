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

// ─── Global State & Config ────────────────────────────────────────────────────

let subjectsMap = {};
let configData = {
  consensusCount: 3,
  consensusMax: 5,
  consensusTemperature: 0.5,
  concurrencyLimit: 3,
  maxRetries: 2,
  thinkingBudget: 1024
};

async function loadSettings() {
  try {
    const subRes = await fetch(chrome.runtime.getURL('subjects.json'));
    if (subRes.ok) subjectsMap = await subRes.json();
  } catch (e) {
    console.warn("Failed to load subjects.json", e);
  }
  try {
    const confRes = await fetch(chrome.runtime.getURL('config.json'));
    if (confRes.ok) configData = await confRes.json();
  } catch (e) {
    console.warn("Failed to load config.json", e);
  }
}
loadSettings();

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

chrome.commands.onCommand.addListener((command) => {
  if (command === "solve_question") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "TRIGGER_SOLVE" });
      }
    });
  }
});

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

  if (request.action === "LOG_MISS") {
    chrome.storage.local.get(["missLog"], (data) => {
      let log = Array.isArray(data.missLog) ? data.missLog : [];
      log.unshift({
        questionId: request.questionId,
        correctAnswer: request.correctAnswer,
        question: request.question,
        options: request.options,
        model_answer: request.model_answer,
        subject: request.subject,
        timestamp: new Date().toISOString()
      });
      chrome.storage.local.set({ missLog: log }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
  
  if (request.action === "GET_MISS_LOG") {
    chrome.storage.local.get(["missLog"], (data) => {
      sendResponse({ success: true, log: data.missLog || [] });
    });
    return true;
  }
  
  if (request.action === "EXPORT_MISS_LOG") {
    chrome.storage.local.get(["missLog"], (data) => {
      sendResponse({ success: true, data: JSON.stringify(data.missLog || []) });
    });
    return true;
  }
  
  if (request.action === "CLEAR_MISS_LOG") {
    chrome.storage.local.set({ missLog: [] }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// ─── Prompts and Input Cleaning ───────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are an elite, world-class multiple-choice exam solver with zero error tolerance.
Execute this 3-step internal protocol before answering:
1. POLARITY & TRAP CHECK: Identify negative words ('ያልሆነው', 'የማይካተተው', 'የተሳሳተው', 'አይደለም', 'NOT', 'EXCEPT'). If present, select the FALSE or EXCLUDED option.
2. TRANSLATE & FACT-CHECK: Translate the Amharic question and choices into English internally. Verify scientific, mathematical, historical, or geographical truth.
3. MAP LETTER: Map your verified choice to the exact original option letter (A, B, C, D, or E). Keep original option order.

State your 1-sentence factual proof (under 20 words).
End with the final line EXACTLY: 'ANSWER: X' (where X is A, B, C, D, or E). Do not output JSON.`;

const VISION_SYSTEM_INSTRUCTION = `You are an authoritative, world-class multiple-choice quiz solver.
Analyze this quiz screenshot and determine the correct answer with uncompromising accuracy.

Follow this rigorous verification protocol:
1. FAITHFUL CHARACTER TRANSCRIPTION:
   - Transcribe the Amharic question and all 4 options verbatim, glyph-by-glyph.
2. CONSTRAINT & NEGATION DETECTION:
   - Detect if the question contains negative phrasing or exceptions.
3. DECISIVE FACTUAL VERIFICATION:
   - Validate the fact against verifiable historical, scientific, or geographical truth.
4. FINAL CONCLUSION:
   - Conclude with the exact 0-based choice index (0 for ሀ/A, 1 for ለ/B, etc.) and exact option text.

Return ONLY valid JSON without markdown fences:
{
  "question": "<transcribed question in Amharic>",
  "options": ["<opt 0>", "<opt 1>", "<opt 2>", "<opt 3>"],
  "reasoning": "<concise 1-2 sentence proof of correctness>",
  "choice_index": <0, 1, 2, or 3>,
  "choice_text": "<exact text of the chosen correct option>"
}`;

function cleanInput(question, choices) {
  let q = (question || "").normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
    
  let c = (choices || []).map(opt => 
    opt.normalize("NFC")
       .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
       .replace(/\s+/g, ' ')
       .replace(/^([A-Ea-e0-9]\s*(\([ሀለሐመሠረa-zA-Z0-9]\))?|[ሀለሐመሠረa-zA-Z0-9])[\.\)\-\:\s]+/, "")
       .trim()
  );

  const optRegex = /([A-Ea-e])[\.\)]\s*(.*?)(?=(?:[A-Ea-e][\.\)]\s*)|$)/g;
  if (c.length === 0) {
    let match;
    let newQ = q;
    let foundOpts = [];
    while ((match = optRegex.exec(q)) !== null) {
      if (newQ === q) {
        newQ = q.substring(0, match.index).trim();
      }
      foundOpts.push(match[2].trim());
    }
    if (foundOpts.length > 0) {
      q = newQ;
      c = foundOpts;
    }
  }

  return { question: q, choices: c };
}

function findSubject(nameOrKey) {
  if (!nameOrKey) return null;
  const target = String(nameOrKey).trim().toLowerCase();
  for (const [key, data] of Object.entries(subjectsMap)) {
    if (key.toLowerCase() === target) {
      return { key, data };
    }
  }
  return null;
}

function detectSubject(questionText) {
  const qLower = (questionText || "").toLowerCase();
  for (const [subjKey, subjData] of Object.entries(subjectsMap)) {
    if (subjData.keywords && subjData.keywords.some(k => qLower.includes(k.toLowerCase()))) {
      return { key: subjKey, data: subjData };
    }
  }
  const general = findSubject("General") || findSubject("general");
  return general || { key: "General", data: { systemPrompt: "You are an expert Ethiopian national exam teacher covering all subjects. Follow Ethiopian curriculum standards." } };
}

function getSystemPrompt(subjectData) {
  let prompt = subjectData?.systemPrompt || "You are an authoritative, world-class multiple-choice exam solver with zero error tolerance.";
  return prompt + "\n\n" + BASE_SYSTEM_PROMPT;
}

function formatFewShotExamples(fewShot) {
  if (!Array.isArray(fewShot) || fewShot.length === 0) return "";
  return fewShot.map((ex, idx) => {
    let optStr = "";
    if (ex.options && typeof ex.options === "object") {
      optStr = Object.entries(ex.options).map(([k, v]) => `${k}) ${v}`).join("\n");
    }
    return `[EXAMPLE ${idx + 1}]\nQuestion: ${ex.question}\nChoices:\n${optStr}\nReasoning: ${ex.reasoning}\nANSWER: ${ex.correctAnswer}`;
  }).join("\n\n");
}

function formatQuestionPrompt(question, choices, subjectData) {
  let prompt = `[QUESTION]\n${question}\n\n[CHOICES]\n`;
  const labels = ['A', 'B', 'C', 'D', 'E'];
  choices.forEach((c, i) => {
    prompt += `${labels[i]}) ${c}\n`;
  });
  
  const fewShotText = formatFewShotExamples(subjectData?.fewShot);
  if (fewShotText) {
    prompt = `[FEW-SHOT EXAMPLES]\n${fewShotText}\n\n` + prompt;
  }
  return prompt;
}

// ─── Provider-Specific API Adapters ───────────────────────────────────────────

function buildOpenAITextBody(model, systemPrompt, userPrompt, temperature) {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 200,
    temperature: temperature
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
    max_tokens: 500,
    temperature: 0.0,
    response_format: { type: "json_object" }
  };
}

function buildAnthropicTextBody(model, systemPrompt, userPrompt, temperature) {
  return {
    model,
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt }
    ],
    max_tokens: 200,
    temperature: temperature
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
    max_tokens: 500,
    temperature: 0.0
  };
}

function buildGeminiTextBody(systemPrompt, userPrompt, temperature, model) {
  let generationConfig = {
    maxOutputTokens: 200,
    temperature: temperature
  };
  
  if (model.toLowerCase().includes("thinking") && configData.thinkingBudget && configData.thinkingBudget > 0) {
    generationConfig.thinkingConfig = {
      type: "ENABLED",
      thinkingBudget: configData.thinkingBudget
    };
    generationConfig.temperature = undefined;
  }

  return {
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig
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
      maxOutputTokens: 500,
      temperature: 0.0
    }
  };
}

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
  if (data.error) throw new Error(data.error.message || "API error");
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("No answer returned by model");
  return text;
}

async function callProviderAPI(provider, apiKey, model, systemPrompt, userPrompt, customBaseUrl, timeoutMs = 6000, temperature = 0.1) {
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
    body = buildGeminiTextBody(systemPrompt, userPrompt, temperature, model);
  } else if (provider === "anthropic") {
    body = buildAnthropicTextBody(model, systemPrompt, userPrompt, temperature);
  } else {
    body = buildOpenAITextBody(model, systemPrompt, userPrompt, temperature);
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

// ─── Single Model Query & Retry ──────────────────────────────────────────────

async function querySingleModelWithRetry(modelName, provider, apiKey, systemPrompt, userPrompt, customBaseUrl, timeoutMs = 4500, temp = 0.1) {
  const maxRetries = configData.maxRetries !== undefined ? configData.maxRetries : 1;
  let lastError = null;
  let attemptPrompt = userPrompt;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const rawText = await callProviderAPI(provider, apiKey, modelName, systemPrompt, attemptPrompt, customBaseUrl, timeoutMs, temp);
      const match = rawText.match(/ANSWER:\s*([A-Ea-e])/i);
      if (match) {
        return { text: rawText, answerLetter: match[1].toUpperCase(), error: null };
      } else {
        lastError = "Response missing ANSWER: X";
        attemptPrompt = attemptPrompt + "\n\nEnd with ANSWER: X (A, B, C, D, or E).";
      }
    } catch (err) {
      if (err.message && err.message.includes("429")) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 400));
        }
      }
      lastError = err.message;
    }
  }
  throw new Error(`Failed: ${lastError}`);
}

// ─── Fast Parallel Consensus Mode ───────────────────────────────────────────

async function solveDOMWithConsensus(question, choices, apiKey, primaryModel, provider, customBaseUrl, subjectData) {
  const nCalls = Math.min(configData.consensusCount || configData.consensusN || 3, configData.consensusMax || 3);
  const temp = configData.consensusTemperature !== undefined ? configData.consensusTemperature : 0.3;
  const timeoutMs = 4500;
  
  const systemPrompt = getSystemPrompt(subjectData);
  let promptText = formatQuestionPrompt(question, choices, subjectData);
  
  // Fire all calls concurrently in parallel
  const taskPromises = Array.from({ length: nCalls }).map(async () => {
    const t0 = Date.now();
    const res = await querySingleModelWithRetry(primaryModel, provider, apiKey, systemPrompt, promptText, customBaseUrl, timeoutMs, temp);
    return { ...res, elapsed: Date.now() - t0, model: primaryModel };
  });
  
  let settled = await Promise.allSettled(taskPromises);
  let successful = settled.filter(s => s.status === 'fulfilled' && s.value && s.value.answerLetter).map(s => s.value);
  
  if (successful.length === 0) {
    const errors = settled.map((s) => s.reason?.message || "Failed").join("; ");
    throw new Error(`All parallel consensus models failed: ${errors}`);
  }
  
  let voteCounts = {};
  successful.forEach(s => {
    voteCounts[s.answerLetter] = (voteCounts[s.answerLetter] || 0) + 1;
  });
  
  let maxVotes = 0;
  let candidates = [];
  for (const [letter, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      candidates = [letter];
    } else if (count === maxVotes) {
      candidates.push(letter);
    }
  }
  
  let winningLetter = candidates[0];
  let winningSample = successful.find(s => s.answerLetter === winningLetter) || successful[0];
  
  const letterToIndex = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4 };
  const choiceIndex = letterToIndex[winningLetter] !== undefined ? letterToIndex[winningLetter] : 0;
  
  return {
    choice_index: choiceIndex,
    choice_text: choices[choiceIndex] || "",
    reasoning: winningSample.text,
    consensus: `${maxVotes}/${successful.length} consensus`,
    votes: maxVotes,
    totalVoters: successful.length,
    voters: successful.map(s => `${s.model} (${s.elapsed}ms) - ${s.answerLetter}`)
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
    const providerConfig = PROVIDER_ENDPOINTS[provider] || PROVIDER_ENDPOINTS.custom;
    return fetchOpenAICompatibleModels(cleanKey, providerConfig.modelsUrl(cleanKey, customBaseUrl), providerConfig.authHeader(cleanKey));
  }
}

async function fetchGeminiModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();
  if (data.error) return { success: false, error: data.error.message || "Failed to fetch models" };
  if (!data.models) return { success: false, error: "No models found for this API key" };

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
  } catch (e) {}

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
  if (data.error) return { success: false, error: data.error.message || "Failed to fetch models" };

  const models = (data.data || [])
    .filter((m) => m.id)
    .slice(0, 100)
    .map((m) => ({
      id: m.id,
      displayName: m.name || m.id
    }));

  if (models.length === 0) return { success: false, error: "No models found" };
  return { success: true, models };
}

async function fetchOpenAICompatibleModels(apiKey, url, headers) {
  const res = await fetch(url, { headers: { ...headers, "Content-Type": "application/json" } });
  const data = await res.json();
  if (data.error) return { success: false, error: data.error.message || "Failed to fetch models" };

  const models = (data.data || [])
    .filter((m) => m.id)
    .map((m) => ({
      id: m.id,
      displayName: m.id
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) return { success: false, error: "No models found for this API key" };
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
  if (!apiKey) throw new Error("API Key is missing. Click the Anser extension icon and enter your API Key.");
  
  const provider = config.aiProvider || "gemini";
  const model = config.selectedModel || DEFAULT_MODEL;
  const actionType = config.actionType || "highlight";
  const inputMethod = request.preferredInputMethod || config.inputMethod || "dom";
  const consensusMode = config.consensusMode !== false;
  const customBaseUrl = (config.customBaseUrl || "").trim();

  const t0 = Date.now();

  if (inputMethod === "vision") {
    const windowId = senderTab?.windowId || null;
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 90 });
    let base64Data = screenshotDataUrl.replace(/^data:image\/jpeg;base64,/, "");

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
      modelUsed: model,
      subject: "general"
    };
  } else {
    const { question, choices } = request;
    const cleaned = cleanInput(question, choices);
    
    const subjectOverride = request.subjectOverride;
    let subjectData;
    let subjectName;
    const matchedOverride = findSubject(subjectOverride);
    if (matchedOverride) {
      subjectData = matchedOverride.data;
      subjectName = matchedOverride.key;
    } else {
      const detected = detectSubject(cleaned.question);
      subjectData = detected.data;
      subjectName = detected.key;
    }

    if (consensusMode) {
      const consensusResult = await solveDOMWithConsensus(cleaned.question, cleaned.choices, apiKey, model, provider, customBaseUrl, subjectData);
      const latencyMs = Date.now() - t0;

      await saveToQuestionBank({
        question: cleaned.question,
        choices: cleaned.choices,
        answer_index: consensusResult.choice_index,
        answer_text: consensusResult.choice_text,
        reasoning: consensusResult.reasoning,
        method: `Consensus (${consensusResult.consensus})`,
        pageUrl: request.pageUrl,
        pageTitle: request.pageTitle
      });

      return {
        success: true,
        result: consensusResult,
        latencyMs,
        actionType,
        methodUsed: "dom_consensus",
        modelUsed: `Consensus (${consensusResult.consensus})`,
        subject: subjectName
      };
    }

    const systemPrompt = getSystemPrompt(subjectData);
    let userPrompt = formatQuestionPrompt(cleaned.question, cleaned.choices, subjectData);
    
    const timeoutMs = 4500;
    const res = await querySingleModelWithRetry(model, provider, apiKey, systemPrompt, userPrompt, customBaseUrl, timeoutMs, 0.0);
    const latencyMs = Date.now() - t0;

    const letterToIndex = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4 };
    const choiceIndex = letterToIndex[res.answerLetter] !== undefined ? letterToIndex[res.answerLetter] : 0;
    
    const parsed = {
      choice_index: choiceIndex,
      choice_text: cleaned.choices[choiceIndex] || "",
      reasoning: res.text
    };

    await saveToQuestionBank({
      question: cleaned.question,
      choices: cleaned.choices,
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
      modelUsed: model,
      subject: subjectName
    };
  }
}

// ─── Question Bank ────────────────────────────────────────────────────────────

async function saveToQuestionBank(entry) {
  try {
    if (!entry || !entry.question) return;
    const data = await chrome.storage.local.get(["questionBank"]);
    let bank = Array.isArray(data.questionBank) ? data.questionBank : [];

    const normQ = entry.question.trim().toLowerCase().replace(/s+/g, " ");
    const existingIdx = bank.findIndex(
      (item) => item.question && item.question.trim().toLowerCase().replace(/s+/g, " ") === normQ
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
