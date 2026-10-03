/**
 * Anser - Extension Settings Popup Logic
 * Multi-Provider AI Support
 */

const PROVIDER_CONFIG = {
  gemini: {
    label: "Gemini API Key",
    placeholder: "AIzaSy...",
    getKeyUrl: "https://aistudio.google.com/app/apikey",
    getKeyLabel: "Get Key"
  },
  openai: {
    label: "OpenAI API Key",
    placeholder: "sk-...",
    getKeyUrl: "https://platform.openai.com/api-keys",
    getKeyLabel: "Get Key"
  },
  anthropic: {
    label: "Anthropic API Key",
    placeholder: "sk-ant-...",
    getKeyUrl: "https://console.anthropic.com/settings/keys",
    getKeyLabel: "Get Key"
  },
  openrouter: {
    label: "OpenRouter API Key",
    placeholder: "sk-or-...",
    getKeyUrl: "https://openrouter.ai/keys",
    getKeyLabel: "Get Key"
  },
  groq: {
    label: "Groq API Key",
    placeholder: "gsk_...",
    getKeyUrl: "https://console.groq.com/keys",
    getKeyLabel: "Get Key"
  },
  custom: {
    label: "API Key",
    placeholder: "Enter your API key...",
    getKeyUrl: "",
    getKeyLabel: ""
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const providerSelect = document.getElementById("provider-select");
  const customUrlSection = document.getElementById("custom-url-section");
  const customBaseUrlInput = document.getElementById("custom-base-url");
  const apiKeyInput = document.getElementById("api-key-input");
  const apiKeyLabel = document.getElementById("api-key-label");
  const getKeyLink = document.getElementById("get-key-link");
  const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
  const fetchModelsBtn = document.getElementById("fetch-models-btn");
  const keyFeedback = document.getElementById("key-feedback");

  const modelSelect = document.getElementById("model-select");
  const modelCountHint = document.getElementById("model-count-hint");
  const connectionStatus = document.getElementById("connection-status");

  const actionHighlightRadio = document.getElementById("action-highlight");
  const actionAutoClickRadio = document.getElementById("action-autoclick");
  const inputDomRadio = document.getElementById("input-dom");
  const inputVisionRadio = document.getElementById("input-vision");
  const consensusToggle = document.getElementById("consensus-toggle");
  const consensusNSelect = document.getElementById('consensus-n');
  const subjectSelect = document.getElementById('subject-select');
  const stealthToggle = document.getElementById("stealth-toggle");
  const openBankBtn = document.getElementById("open-bank-btn");
  const popupBankCount = document.getElementById("popup-bank-count");
  const missCountBadge = document.getElementById('miss-count-badge');
  const exportMissesBtn = document.getElementById('export-misses-btn');
  const clearMissesBtn = document.getElementById('clear-misses-btn');

  const saveBtn = document.getElementById("save-btn");

  // Question Bank live counter & navigation
  function updateBankCountBadge() {
    chrome.storage.local.get(["questionBank"], (data) => {
      const count = Array.isArray(data.questionBank) ? data.questionBank.length : 0;
      if (popupBankCount) {
        popupBankCount.textContent = count === 1 ? "1 saved" : `${count} saved`;
      }
    });
  }
  updateBankCountBadge();

  if (openBankBtn) {
    openBankBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("bank.html") });
    });
    openBankBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL("bank.html") });
      }
    });
  }

  // Real-time listener for questionBank updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.questionBank) {
      updateBankCountBadge();
    }
  });

  let currentSelectedModel = "gemini-3.5-flash-lite";

  const EYE_OPEN_SVG = `
    <svg class="icon-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d="M10 4C5.5 4 2 10 2 10s3.5 6 8 6 8-6 8-6-3.5-6-8-6z"/>
      <circle cx="10" cy="10" r="2.5"/>
    </svg>
  `;

  const EYE_CLOSED_SVG = `
    <svg class="icon-svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d="M2 2l16 16M9.9 4.2C10 4.2 10 4.2 10 4.2c4.5 0 8 5.8 8 5.8s-1.3 2.3-3.2 3.8M6.2 6.2C3.8 7.5 2 10 2 10s3.5 5.8 8 5.8c1.5 0 3-.4 4.2-1.2"/>
      <path d="M8.5 8.5a2.5 2.5 0 003 3"/>
    </svg>
  `;

  // Update UI based on selected provider
  function updateProviderUI(provider) {
    const config = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.gemini;
    apiKeyLabel.textContent = config.label;
    apiKeyInput.placeholder = config.placeholder;

    if (config.getKeyUrl) {
      getKeyLink.href = config.getKeyUrl;
      getKeyLink.textContent = "";
      getKeyLink.innerHTML = `${config.getKeyLabel}<svg class="link-arrow" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5"/></svg>`;
      getKeyLink.style.display = "";
    } else {
      getKeyLink.style.display = "none";
    }

    // Show/hide custom URL section
    customUrlSection.style.display = provider === "custom" ? "" : "none";

    // Vision mode only works with Gemini (multimodal), disable for others that don't support it natively
    // (OpenAI and Anthropic support vision too, so keep it enabled for them)
    const visionSupported = ["gemini", "openai", "anthropic", "openrouter"].includes(provider);
    if (!visionSupported && inputVisionRadio.checked) {
      inputDomRadio.checked = true;
      chrome.storage.local.set({ inputMethod: "dom" });
    }
    inputVisionRadio.disabled = !visionSupported;

    // Consensus mode is now supported for all providers
  }

  // 1. Load Stored Settings
  chrome.storage.local.get(
    ["geminiApiKey", "selectedModel", "actionType", "inputMethod", "consensusMode", "consensusN", "subjectOverride", "stealthMode", "aiProvider", "customBaseUrl", "missLog"],
    (data) => {
      const provider = data.aiProvider || "gemini";
      providerSelect.value = provider;
      updateProviderUI(provider);

      if (data.consensusN) {
        consensusNSelect.value = data.consensusN.toString();
      } else {
        consensusNSelect.value = "3";
      }

      if (data.subjectOverride) {
        subjectSelect.value = data.subjectOverride;
      } else {
        subjectSelect.value = "auto";
      }

      const misses = data.missLog || [];
      if (missCountBadge) {
        missCountBadge.textContent = misses.length === 1 ? "1 miss" : `${misses.length} misses`;
      }

      if (data.customBaseUrl) {
        customBaseUrlInput.value = data.customBaseUrl;
      }

      const apiKey = (data.geminiApiKey || "").trim();
      apiKeyInput.value = apiKey;

      if (data.selectedModel) {
        currentSelectedModel = data.selectedModel;
      }

      if (data.actionType === "auto_click") {
        actionAutoClickRadio.checked = true;
      } else {
        actionHighlightRadio.checked = true;
      }

      if (data.inputMethod === "vision") {
        inputVisionRadio.checked = true;
      } else {
        inputDomRadio.checked = true;
      }

      if (data.consensusMode !== undefined) {
        consensusToggle.checked = data.consensusMode;
      } else {
        consensusToggle.checked = provider === "gemini";
      }

      if (data.stealthMode !== undefined) {
        stealthToggle.checked = data.stealthMode;
      } else {
        stealthToggle.checked = false;
      }

      if (apiKey) {
        fetchAndPopulateModels(apiKey, currentSelectedModel);
      } else {
        setConnectionStatus("disconnected", "No API Key");
        modelCountHint.textContent = "Enter key above";
        modelSelect.disabled = true;
        modelSelect.innerHTML = '<option value="">Select a model</option>';
      }
    }
  );

  // Provider change handler
  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value;
    chrome.storage.local.set({ aiProvider: provider });
    updateProviderUI(provider);

    // Reset model list
    modelSelect.innerHTML = '<option value="">Select a model</option>';
    modelSelect.disabled = true;
    modelCountHint.textContent = "Press Connect";
    setConnectionStatus("disconnected", "Not connected");
    clearFeedback();
  });

  // Custom base URL persistence
  if (customBaseUrlInput) {
    customBaseUrlInput.addEventListener("input", () => {
      chrome.storage.local.set({ customBaseUrl: customBaseUrlInput.value.trim() });
    });
  }

  // 2. Toggle API Key Visibility with Vector SVGs
  toggleKeyVisibilityBtn.addEventListener("click", () => {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleKeyVisibilityBtn.innerHTML = EYE_CLOSED_SVG;
    } else {
      apiKeyInput.type = "password";
      toggleKeyVisibilityBtn.innerHTML = EYE_OPEN_SVG;
    }
  });

  // 3. Real-Time Auto-Persist API Key on input & change
  apiKeyInput.addEventListener("input", () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key });
    if (!key) {
      setConnectionStatus("disconnected", "No API Key");
      modelCountHint.textContent = "Enter key above";
      clearFeedback();
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">Select a model</option>';
    }
  });

  apiKeyInput.addEventListener("change", () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key });
  });

  // 4. Connect / Fetch Models Button Click
  fetchModelsBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showFeedback("Please enter a valid API Key", "error");
      setConnectionStatus("disconnected", "No API Key");
      return;
    }
    const provider = providerSelect.value;
    const customBaseUrl = customBaseUrlInput?.value?.trim() || "";
    // Immediately persist entered key to storage so it is never lost
    chrome.storage.local.set({ geminiApiKey: key, aiProvider: provider, customBaseUrl });
    fetchAndPopulateModels(key, modelSelect.value || currentSelectedModel);
  });

  // 5. Fetch models from background service worker
  function fetchAndPopulateModels(apiKey, targetModel) {
    const provider = providerSelect.value;
    const customBaseUrl = customBaseUrlInput?.value?.trim() || "";
    setConnectionStatus("checking", "Connecting...");
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">Connecting...</option>';
    modelCountHint.textContent = "Connecting...";
    clearFeedback();

    chrome.runtime.sendMessage(
      { action: "FETCH_MODELS", apiKey, provider, customBaseUrl },
      (response) => {
        if (chrome.runtime.lastError) {
          setConnectionStatus("error", "Error");
          showFeedback(chrome.runtime.lastError.message, "error");
          return;
        }

        if (!response || !response.success) {
          setConnectionStatus("error", "Invalid Key");
          showFeedback(response?.error || "Failed to load models", "error");
          modelCountHint.textContent = "Connection failed";
          return;
        }

        const models = response.models || [];
        modelSelect.innerHTML = "";

        models.forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.displayName || m.id;
          modelSelect.appendChild(opt);
        });

        // Restore target model if available
        const hasTarget = models.some((m) => m.id === targetModel);
        if (hasTarget) {
          modelSelect.value = targetModel;
        } else if (models.length > 0) {
          modelSelect.value = models[0].id;
        }

        // Persist validated key and chosen model
        chrome.storage.local.set({
          geminiApiKey: apiKey,
          selectedModel: modelSelect.value,
          aiProvider: provider
        });

        modelSelect.disabled = false;
        setConnectionStatus("connected", "Connected");
        modelCountHint.textContent = `${models.length} models ready`;
        showFeedback("API Key verified and models loaded!", "success");
      }
    );
  }

  // 6. Real-time auto-persistence for model selection & radio buttons
  modelSelect.addEventListener("change", () => {
    currentSelectedModel = modelSelect.value;
    chrome.storage.local.set({ selectedModel: modelSelect.value });
  });

  actionHighlightRadio.addEventListener("change", () => {
    if (actionHighlightRadio.checked) chrome.storage.local.set({ actionType: "highlight" });
  });

  actionAutoClickRadio.addEventListener("change", () => {
    if (actionAutoClickRadio.checked) chrome.storage.local.set({ actionType: "auto_click" });
  });

  inputDomRadio.addEventListener("change", () => {
    if (inputDomRadio.checked) chrome.storage.local.set({ inputMethod: "dom" });
  });

  inputVisionRadio.addEventListener("change", () => {
    if (inputVisionRadio.checked) chrome.storage.local.set({ inputMethod: "vision" });
  });

  consensusToggle.addEventListener("change", () => {
    chrome.storage.local.set({ consensusMode: consensusToggle.checked });
  });

  stealthToggle.addEventListener("change", () => {
    chrome.storage.local.set({ stealthMode: stealthToggle.checked });
  });

  subjectSelect.addEventListener('change', () => {
    const val = subjectSelect.value;
    chrome.storage.local.set({ subjectOverride: val === 'auto' ? '' : val });
    // Also notify the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'SET_SUBJECT_OVERRIDE', subject: val === 'auto' ? null : val });
      }
    });
  });

  consensusNSelect.addEventListener('change', () => {
    chrome.storage.local.set({ consensusN: parseInt(consensusNSelect.value, 10) });
  });

  if (exportMissesBtn) {
    exportMissesBtn.addEventListener('click', () => {
      chrome.storage.local.get(['missLog'], (data) => {
        const misses = data.missLog || [];
        const blob = new Blob([JSON.stringify(misses, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
          url: url,
          filename: `anser-miss-log-${new Date().toISOString().slice(0,10)}.json`
        });
      });
    });
  }

  if (clearMissesBtn) {
    clearMissesBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: "CLEAR_MISS_LOG" }, (response) => {
        if (missCountBadge) {
          missCountBadge.textContent = "0 misses";
        }
      });
    });
  }

  // 7. Save Settings with Tactile Feedback
  saveBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value || currentSelectedModel;
    const actionType = actionAutoClickRadio.checked ? "auto_click" : "highlight";
    const inputMethod = inputVisionRadio.checked ? "vision" : "dom";
    const consensusMode = consensusToggle.checked;
    const consensusN = parseInt(consensusNSelect.value, 10) || 3;
    const subjectOverride = subjectSelect.value === 'auto' ? '' : subjectSelect.value;
    const stealthMode = stealthToggle.checked;
    const provider = providerSelect.value;
    const customBaseUrl = customBaseUrlInput?.value?.trim() || "";

    chrome.storage.local.set(
      {
        geminiApiKey: key,
        selectedModel: model,
        actionType: actionType,
        inputMethod: inputMethod,
        consensusMode: consensusMode,
        consensusN: consensusN,
        subjectOverride: subjectOverride,
        stealthMode: stealthMode,
        aiProvider: provider,
        customBaseUrl: customBaseUrl
      },
      () => {
        saveBtn.classList.add("saved");
        saveBtn.innerHTML = `
          <svg style="width:15px;height:15px;" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 11 8 15 16 6"></polyline>
          </svg>
          <span>Preferences Saved!</span>
        `;
        if (key && !modelSelect.disabled) {
          showFeedback("Preferences & API Key saved!", "success");
        } else if (!key) {
          showFeedback("Preferences saved (Note: API Key is empty)", "error");
        }
        setTimeout(() => {
          saveBtn.classList.remove("saved");
          saveBtn.innerHTML = `<span>Save Preferences</span>`;
        }, 1500);
      }
    );
  });

  // UI Helpers
  function setConnectionStatus(state, label) {
    connectionStatus.className = `status-pill ${state}`;
    connectionStatus.innerHTML = `
      <span class="status-dot"></span>
      <span class="status-text">${label}</span>
    `;
  }

  function showFeedback(msg, type) {
    keyFeedback.textContent = msg;
    keyFeedback.className = `form-feedback ${type}`;
  }

  function clearFeedback() {
    keyFeedback.className = "form-feedback hidden";
    keyFeedback.textContent = "";
  }
});
