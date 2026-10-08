/**
 * Anser - AI MCQ Solver
 * Content Script (Injected into Web Pages)
 */

(function () {
  // Prevent duplicate injections
  if (window.__ANSER_INJECTED__) return;
  window.__ANSER_INJECTED__ = true;

  let isSolving = false;
  let floatingWidget = null;
  let isStealth = false;
  let infoPillTimeout = null;

  // 1. Create and inject floating UI widget
  function createWidget() {
    if (document.getElementById("anser-floating-widget")) return;

    floatingWidget = document.createElement("div");
    floatingWidget.id = "anser-floating-widget";
    floatingWidget.className = "anser-widget";
    floatingWidget.innerHTML = `
      <div class="anser-widget-inner">
        <button id="anser-solve-btn" type="button" class="anser-btn-trigger" title="Solve current question (Alt+Q)">
          <div class="anser-icon-pod">
            <svg class="anser-icon-svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L14.4 8.6L21 11L14.4 13.4L12 20L9.6 13.4L3 11L9.6 8.6L12 2Z"/>
            </svg>
            <div class="anser-spinner"></div>
          </div>
          <span id="anser-btn-label" class="anser-label">Solve</span>
          <kbd class="anser-kbd">Alt+Q</kbd>
        </button>
        <div id="anser-info-pill" class="anser-info hidden" title="Click to dismiss"></div>
      </div>
    `;

    document.body.appendChild(floatingWidget);

    const solveBtn = document.getElementById("anser-solve-btn");
    const infoPill = document.getElementById("anser-info-pill");

    // Stealth Mode: check if overlay button should be hidden
    chrome.storage.local.get(["stealthMode"], (data) => {
      applyStealthState(!!data.stealthMode);
    });

    if (solveBtn) {
      solveBtn.addEventListener("click", () => {
        if (isSolving && Date.now() - lastSolveStartTime > 2500) {
          resetSolvingState();
          showNotification("Solving reset", "info", 1500);
          return;
        }
        triggerSolve();
      });
    }

    if (infoPill) {
      infoPill.addEventListener("click", () => {
        clearTimeout(infoPillTimeout);
        infoPill.classList.add("hidden");
      });
    }
  }

  function applyStealthState(enabled) {
    isStealth = enabled;
    if (floatingWidget) {
      floatingWidget.classList.toggle("anser-stealth", enabled);
    }
    const solveBtn = document.getElementById("anser-solve-btn");
    if (solveBtn) {
      solveBtn.classList.toggle("stealth-hidden", enabled);
    }
  }

  // Real-time listener for Stealth Mode toggle
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.stealthMode !== undefined) {
      applyStealthState(!!changes.stealthMode.newValue);
    }
  });

  // Filter out any header, navigation, or extension UI elements
  function isIgnoredElement(el) {
    if (!el || !(el instanceof Element)) return true;
    return !!el.closest("header, nav, [role='navigation'], #header, .site-header, .navbar, .nav, aside, footer, #anser-floating-widget, [class*='anser-']");
  }

  // Filter out page-level outer containers so we only evaluate genuine question cards
  function isPageLevelContainer(el) {
    if (!el || !(el instanceof Element)) return true;
    return !!el.matches("body, html, main, section, article, .quiz-container, [class*='quiz-container']");
  }

  // Strict computed visibility checker to completely ignore hidden/transitioned-away questions in SPAs
  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;

    // Zero bounding rect means hidden, collapsed, or detached
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;

    // Computed style check
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    const opacity = parseFloat(style.opacity);
    if (!isNaN(opacity) && opacity < 0.05) {
      return false;
    }

    // offsetParent is null for elements hidden with display:none in any ancestor (except fixed/sticky)
    if (el.offsetParent === null && style.position !== "fixed" && style.position !== "sticky") {
      return false;
    }

    return true;
  }

  // Calculate viewport visibility & proximity score for active question targeting
  function getViewportScore(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return -10000;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;

    if (rect.width <= 10 || rect.height <= 10) return -10000;

    // Check visible vertical bounds
    const top = Math.max(0, rect.top);
    const bottom = Math.min(vh, rect.bottom);
    if (bottom <= top) return -10000; // Not visible in current viewport

    const visibleHeight = bottom - top;
    const centerY = rect.top + rect.height / 2;
    const distFromCenter = Math.abs(centerY - vh / 2);

    const hasFocus = el.contains(document.activeElement);

    return (visibleHeight * 2) - distFromCenter + (hasFocus ? 2000 : 0);
  }

  // Clean raw question text and strip platform noise / timers / countdowns
  function cleanQuestionText(raw) {
    if (!raw) return "";
    let text = raw.normalize('NFC')
      .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u034F\u061C\u180E]/g, '')
      .replace(/\s+/g, " ")
      .replace(/\[\s*(?:\d+(?:\.\d+)?\s*(?:points?|marks?|pts?)|marked\s*out\s*of\s*\d+(?:\.\d+)?)\s*\]/gi, "")
      .replace(/\b(?:Points?|Marks?):\s*\d+(?:\.\d+)?\b/gi, "")
      // Strip quiz banners and timers (e.g. "ጥያቄዎችን በመመለስ ይሸለሙ", "8 ሰከንዶች ይቀራሉ", "Total time: 40 ሰከንዶች", "5 of 15")
      .replace(/ጥያቄዎችን\s*በመመለስ\s*ይሸለሙ/gi, "")
      .replace(/\d+\s*ሰከንዶች?\s*(?:ይቀራሉ|ቀሩ|የቀሩ)?/gi, "")
      .replace(/Total\s*time:\s*\d+\s*ሰከንዶች?/gi, "")
      .replace(/\b\d+\s*of\s*\d+\b/gi, "")
      .trim();

    // If options were accidentally bundled in the question string (e.g. "ሀ. ... ለ. ... ሐ. ..."), truncate at the first option marker
    const optMarkerMatch = text.match(/\s+([ሀለሐመሠረabcdABCD0-9][.)\s]\s*)/);
    if (optMarkerMatch && text.match(/[ሀA][.)\s].*?[ለB][.)\s]/)) {
      const idx = text.indexOf(optMarkerMatch[0]);
      if (idx > 5) {
        text = text.slice(0, idx).trim();
      }
    }

    return text.trim();
  }

  // Clean raw option text
  function cleanOptionText(raw) {
    if (!raw) return "";
    return raw.normalize('NFC')
      .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u034F\u061C\u180E]/g, '')
      .replace(/\s+/g, " ")
      .replace(/^([A-Ea-e0-9]\s*(\([ሀለሐመሠረa-zA-Z0-9]\))?|[ሀለሐመሠረa-zA-Z0-9])[\.\)\-\:\s]+/, "")
      .trim();
  }

  // Extract Question and Choices from a scoped container element
  function extractFromContainer(container) {
    if (!container || isIgnoredElement(container) || !isElementVisible(container) || isPageLevelContainer(container)) {
      return null;
    }

    // A. Extract Question Text
    let questionText = "";

    // A1. Specific anchor headers (React/Chakra exam portal: .text-question-color + .my-content)
    const qColorEl = container.querySelector(".text-question-color, [class*='question-color']");
    const qContentEl = container.querySelector(".my-content, [class*='my-content'], #question-text, [class*='qtext']");

    const isColorVis = qColorEl && isElementVisible(qColorEl);
    const isContentVis = qContentEl && isElementVisible(qContentEl);

    if (isContentVis) {
      const body = qContentEl.innerText.trim();
      if (isColorVis) {
        const rawPrefix = qColorEl.innerText.trim();
        // Strict prefix validation: must be short (< 20 chars) and match question number pattern
        if (rawPrefix.length <= 20 && /^(\d{1,3}[\.\)\-:]|\b(?:Q|Question|ጥያቄ)\s*\d{1,3}[\.\)\-:]?)\s*$/i.test(rawPrefix)) {
          questionText = `${rawPrefix} ${body}`;
        } else {
          questionText = body;
        }
      } else {
        questionText = body;
      }
    } else if (isColorVis) {
      const siblingH = qColorEl.nextElementSibling;
      if (siblingH && isElementVisible(siblingH)) {
        const rawPrefix = qColorEl.innerText.trim();
        const body = siblingH.innerText.trim();
        if (rawPrefix.length <= 20 && /^(\d{1,3}[\.\)\-:]|\b(?:Q|Question|ጥያቄ)\s*\d{1,3}[\.\)\-:]?)\s*$/i.test(rawPrefix)) {
          questionText = `${rawPrefix} ${body}`;
        } else {
          questionText = body || rawPrefix;
        }
      } else {
        questionText = qColorEl.innerText.trim();
      }
    }

    // A2. Heading / Legend tag
    if (!questionText) {
      const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, legend, [role='heading']"))
        .filter((h) => !isIgnoredElement(h) && isElementVisible(h));
      for (const h of headings) {
        const text = h.innerText.trim();
        if (text.length >= 3) {
          questionText = text;
          break;
        }
      }
    }

    // A3. Question number pattern matching anywhere in container
    if (!questionText) {
      const allTextNodes = Array.from(container.querySelectorAll("p, div, span"))
        .filter((el) => !isIgnoredElement(el) && isElementVisible(el) && el.children.length === 0);
      for (const node of allTextNodes) {
        const t = node.innerText.trim();
        if (/^(\d{1,3}[\.\)\-:]|\b(?:Q|Question|ጥያቄ)\s*\d{1,3}[\.\)\-:]?)/i.test(t) || /[?፧፤]$/.test(t)) {
          questionText = t;
          break;
        }
      }
    }

    questionText = cleanQuestionText(questionText);
    if (!questionText || questionText.length < 3) return null;

    // B. Extract Option Cards & Choices (STRICTLY VISIBLE ONLY)
    let optionElements = [];

    // Strategy B1: Chakra Stack / Options Stack
    const stack = container.querySelector(".chakra-stack, [class*='chakra-stack'], [class*='options-stack'], [role='radiogroup']");
    if (stack && !isIgnoredElement(stack) && isElementVisible(stack)) {
      const children = Array.from(stack.children).filter((c) => !isIgnoredElement(c) && isElementVisible(c));
      if (children.length >= 2 && children.length <= 8) {
        optionElements = children;
      }
    }

    // Strategy B2: Radio Input grouping
    if (optionElements.length === 0) {
      const radios = Array.from(container.querySelectorAll("input[type='radio'], [role='radio']"))
        .filter((r) => !isIgnoredElement(r) && isElementVisible(r));
      if (radios.length >= 2 && radios.length <= 8) {
        optionElements = radios
          .map((r) => r.closest("label, div.cursor-pointer, [class*='option'], li, div") || r.parentElement)
          .filter((el) => isElementVisible(el));
      }
    }

    // Strategy B3: Clickable Divs / Option Cards with congruent parent
    if (optionElements.length === 0) {
      const candidates = Array.from(
        container.querySelectorAll("div.cursor-pointer, [class*='cursor-pointer'], button.option, [class*='option'], div[value]")
      ).filter((el) => !isIgnoredElement(el) && isElementVisible(el) && el !== container);

      const parentMap = new Map();
      candidates.forEach((el) => {
        const p = el.parentElement;
        if (!p || isIgnoredElement(p) || !isElementVisible(p)) return;
        if (!parentMap.has(p)) parentMap.set(p, []);
        parentMap.get(p).push(el);
      });

      for (const items of parentMap.values()) {
        const visibleItems = items.filter(isElementVisible);
        if (visibleItems.length >= 2 && visibleItems.length <= 8) {
          optionElements = visibleItems;
          break;
        }
      }
    }

    // Strategy B4: Ethiopic / Latin Option Marker check (ሀ. ለ. ሐ. መ. or A. B. C. D.)
    if (optionElements.length === 0) {
      const markerRegex = /^[ሀለሐመሠረabcdABCD0-9][.)\s]/;
      const allDivs = Array.from(container.querySelectorAll("div, p, label, li"))
        .filter((el) => !isIgnoredElement(el) && isElementVisible(el) && markerRegex.test(el.innerText.trim()));
      if (allDivs.length >= 2 && allDivs.length <= 8) {
        optionElements = allDivs
          .map((d) => d.closest("div.cursor-pointer, [class*='option'], label, li, div") || d)
          .filter(isElementVisible);
        optionElements = Array.from(new Set(optionElements)); // deduplicate
      }
    }

    // Ensure all options are strictly visible
    optionElements = optionElements.filter((el) => isElementVisible(el));
    if (optionElements.length < 2) return null;

    // C. Extract Clean Choice Text for each option element
    const choices = optionElements.map((el) => {
      const pBreak = el.querySelector("p.break-all, [class*='break-all']");
      if (pBreak && isElementVisible(pBreak)) return cleanOptionText(pBreak.innerText);
      const allP = Array.from(el.querySelectorAll("p")).filter(isElementVisible);
      if (allP.length >= 2) return cleanOptionText(allP[allP.length - 1].innerText);
      return cleanOptionText(el.innerText || el.textContent);
    });

    // Final validation: at least 2 choices, not all blank
    if (choices.length < 2 || choices.every((c) => c.length === 0)) return null;

    return {
      question: questionText,
      choices: choices,
      elements: optionElements,
      container: container,
      detectionType: "fast_dom_v2_active"
    };
  }

  // 2. Intelligent Fast DOM 2.0 Question & Choice Extractor
  function extractQuestionAndChoices() {
    const rawCandidates = new Set();

    // Strategy 1: Option-First Discovery (Highest precision for SPAs)
    // Find all visible option elements on the screen and trace to their enclosing card
    const visibleOptions = Array.from(
      document.querySelectorAll(
        ".chakra-stack > div, .options-stack > div, [role='radiogroup'] > div, input[type='radio'], button.option, [class*='option'], div.cursor-pointer, div[value], .option-btn"
      )
    ).filter((el) => !isIgnoredElement(el) && isElementVisible(el));

    visibleOptions.forEach((opt) => {
      const card = opt.closest(".react-reveal, [class*='react-reveal'], .quiz-card, .question-card, .card, fieldset, form") ||
                   opt.parentElement?.parentElement?.parentElement;
      if (card && !isIgnoredElement(card) && !isPageLevelContainer(card) && isElementVisible(card)) {
        rawCandidates.add(card);
      }
    });

    // Strategy 2: Targeted visible anchor elements (.my-content, .text-question-color, #question-text)
    document.querySelectorAll(".my-content, .text-question-color, [class*='question-color'], #question-text, [class*='qtext']").forEach((el) => {
      if (isIgnoredElement(el) || !isElementVisible(el)) return;
      const card = el.closest(".react-reveal, [class*='react-reveal'], .quiz-card, .question-card, .card, fieldset, form") ||
                   el.parentElement?.parentElement;
      if (card && !isIgnoredElement(card) && !isPageLevelContainer(card) && isElementVisible(card)) {
        rawCandidates.add(card);
      }
    });

    // Strategy 3: Standard card selectors (excluding page-level wrappers)
    const containerSelectors = [
      ".react-reveal, [class*='react-reveal']",
      ".quiz-card, .question-card, .que, [class*='question-container']",
      "fieldset, [role='radiogroup']",
      ".card"
    ];
    containerSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (!isIgnoredElement(el) && !isPageLevelContainer(el) && isElementVisible(el)) {
          rawCandidates.add(el);
        }
      });
    });

    // Rank candidates by viewport proximity (user's currently viewed question first!)
    const candidateList = Array.from(rawCandidates)
      .map((el) => ({ el, score: getViewportScore(el) }))
      .filter((c) => c.score > -9000)
      .sort((a, b) => b.score - a.score)
      .map((c) => c.el);

    const evaluationQueue = candidateList.length > 0 ? candidateList : Array.from(rawCandidates);

    // Evaluate containers in priority order
    for (const container of evaluationQueue) {
      const extracted = extractFromContainer(container);
      if (extracted) {
        return extracted;
      }
    }

    // Benchmark fallback
    const benchmarkQ = document.querySelector("#question-text");
    const benchmarkOpts = Array.from(document.querySelectorAll(".option-btn")).filter((el) => !isIgnoredElement(el) && isElementVisible(el));
    if (benchmarkQ && !isIgnoredElement(benchmarkQ) && isElementVisible(benchmarkQ) && benchmarkOpts.length >= 2) {
      return {
        question: cleanQuestionText(benchmarkQ.innerText),
        choices: benchmarkOpts.map((el) => {
          const label = el.querySelector(".option-label");
          return cleanOptionText((label || el).innerText);
        }),
        elements: benchmarkOpts,
        container: benchmarkQ.closest(".quiz-card, main, div") || document.body,
        detectionType: "benchmark"
      };
    }

    return null;
  }

  // Find candidate option elements safely without header/navigation pollution
  function findCandidateOptionElements() {
    const extracted = extractQuestionAndChoices();
    if (extracted && extracted.elements?.length >= 2) {
      return extracted.elements;
    }

    // Direct fallback for general option buttons
    const benchmarkOpts = Array.from(document.querySelectorAll(".option-btn")).filter((el) => !isIgnoredElement(el));
    if (benchmarkOpts.length >= 2) return benchmarkOpts;

    return [];
  }

  // 3. Match AI choice to the clickable DOM element
  function findTargetOptionElement(answer, elements) {
    if (!elements || elements.length === 0) return null;

    const targetText = cleanOptionText(answer.choice_text || "").toLowerCase();
    const targetIdx = typeof answer.choice_index === "number" && answer.choice_index >= 0 && answer.choice_index < elements.length
      ? answer.choice_index
      : null;

    function getCleanElementText(el) {
      const pBreak = el.querySelector("p.break-all, [class*='break-all']");
      if (pBreak) return cleanOptionText(pBreak.innerText).toLowerCase();
      const allP = el.querySelectorAll("p");
      if (allP.length >= 2) return cleanOptionText(allP[allP.length - 1].innerText).toLowerCase();
      const raw = el.innerText || el.textContent || "";
      return cleanOptionText(raw).toLowerCase();
    }

    // 1. Check if the element at targetIdx matches the text (highest confidence)
    if (targetIdx !== null) {
      const elText = getCleanElementText(elements[targetIdx]);
      if (targetText && (elText.includes(targetText) || targetText.includes(elText))) {
        return elements[targetIdx];
      }
    }

    // 2. Exact or substring text match across all candidate elements
    if (targetText.length > 0) {
      for (let i = 0; i < elements.length; i++) {
        const elText = getCleanElementText(elements[i]);
        if (elText === targetText || elText.includes(targetText) || targetText.includes(elText)) {
          return elements[i];
        }
        if (targetText.length >= 3 && elText.startsWith(targetText.slice(0, 3))) {
          return elements[i];
        }
      }
    }

    // 3. Direct index fallback IF valid index and within bounds
    if (targetIdx !== null && targetIdx < elements.length) {
      return elements[targetIdx];
    }

    // 4. Return null if no match found
    return null;
  }

  // 4. Highlight or Auto-Click
  function applyAnswer(targetEl, answer, latencyMs, actionType, payload) {
    // Clear existing highlights
    document.querySelectorAll(".anser-highlight").forEach((el) => {
      el.classList.remove("anser-highlight");
      el.querySelector(".anser-badge")?.remove();
    });

    if (!targetEl) return;

    targetEl.classList.add("anser-highlight");

    // Add badge
    const badge = document.createElement("span");
    badge.className = "anser-badge";
    const consensusTag = answer.consensus ? ` • ${answer.consensus}` : "";
    badge.innerHTML = `
      <svg class="anser-badge-svg" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5L8 0Z"/>
      </svg>
      <span>AI (${(latencyMs / 1000).toFixed(1)}s${consensusTag})</span>
    `;

    const markWrongBtn = document.createElement("button");
    markWrongBtn.className = "anser-mark-wrong-btn";
    markWrongBtn.textContent = "Mark Wrong";
    markWrongBtn.style.marginLeft = "8px";
    markWrongBtn.style.fontSize = "0.8em";
    markWrongBtn.style.cursor = "pointer";
    markWrongBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const correctLetter = prompt("Enter the correct answer letter (A/B/C/D):");
      if (correctLetter) {
        let letterIndex = -1;
        const upperLetter = correctLetter.toUpperCase().trim();
        if (upperLetter === 'A') letterIndex = 0;
        else if (upperLetter === 'B') letterIndex = 1;
        else if (upperLetter === 'C') letterIndex = 2;
        else if (upperLetter === 'D') letterIndex = 3;

        const currentQuestionId = payload?.questionId || Date.now().toString();
        const questionText = payload?.question || 'unknown';
        const choices = payload?.choices || [];

        chrome.runtime.sendMessage({
          action: 'LOG_MISS',
          questionId: currentQuestionId,
          question: questionText,
          options: choices,
          modelAnswer: answer.choice_index,
          correctAnswer: letterIndex,
          subject: answer.subject || 'unknown'
        });
        markWrongBtn.textContent = '✓ Logged';
        markWrongBtn.disabled = true;
      }
    };
    badge.appendChild(markWrongBtn);

    targetEl.appendChild(badge);

    // Scroll element into view smoothly if needed
    targetEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // If Auto-Click mode
    if (actionType === "auto_click") {
      setTimeout(() => {
        targetEl.click();
      }, 150);
    }
  }

  let solveWatchdog = null;
  let lastSolveStartTime = 0;

  function resetSolvingState() {
    isSolving = false;
    clearTimeout(solveWatchdog);
    solveWatchdog = null;
    if (floatingWidget) floatingWidget.classList.remove("anser-busy");
    const labelEl = document.getElementById("anser-btn-label");
    if (labelEl) labelEl.textContent = "Solve";
  }

  // 5. Trigger Solve Pipeline
  async function triggerSolve() {
    if (isSolving) {
      console.warn("[Anser] Solve already in progress.");
      return;
    }
    isSolving = true;
    lastSolveStartTime = Date.now();

    const labelEl = document.getElementById("anser-btn-label");
    const infoPill = document.getElementById("anser-info-pill");

    if (labelEl) labelEl.textContent = "Analyzing...";
    if (floatingWidget) floatingWidget.classList.add("anser-busy");
    if (infoPill) infoPill.classList.add("hidden");

    // 9-second auto-reset watchdog to ensure answers always complete within 10s limit
    clearTimeout(solveWatchdog);
    solveWatchdog = setTimeout(() => {
      if (isSolving) {
        console.warn("[Anser] Solving timed out after 9s. Resetting state.");
        resetSolvingState();
        showError("Solving request timed out (<9s). Please try again.");
      }
    }, 9000);

    try {
      // Check stored preference for input method (DOM vs Vision)
      const settings = await chrome.storage.local.get(["inputMethod"]);
      const preferredInputMethod = settings.inputMethod || "dom";

      const extracted = extractQuestionAndChoices();
      let payload = {};

      if (preferredInputMethod === "vision" || !extracted) {
        // Calculate high-DPI bounding box of the active quiz card for tight cropping
        const quizCard =
          extracted?.container ||
          document
            .querySelector(
              ".react-reveal, [class*='react-reveal'], .my-content, .text-question-color, .quiz-card, [class*='card'], [class*='quiz']"
            )
            ?.closest(".react-reveal, [class*='react-reveal'], form, section, .quiz-container") ||
          document.querySelector(".my-content, .text-question-color, .quiz-card, #question-text")?.parentElement ||
          document.body;
        const rect = quizCard.getBoundingClientRect();
        const pad = 16;
        const cropArea = {
          left: Math.max(0, rect.left - pad),
          top: Math.max(0, rect.top - pad),
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        };

        payload = {
          action: "SOLVE_QUESTION",
          preferredInputMethod: "vision",
          cropArea: cropArea,
          pageUrl: window.location.href,
          pageTitle: document.title,
          subjectOverride: window.__anserSubjectOverride || null,
          question: extracted?.question,
          choices: extracted?.choices
        };
      } else {
        payload = {
          action: "SOLVE_QUESTION",
          preferredInputMethod: "dom",
          question: extracted.question,
          choices: extracted.choices,
          pageUrl: window.location.href,
          pageTitle: document.title,
          subjectOverride: window.__anserSubjectOverride || null
        };
      }

      // Send to background service worker
      chrome.runtime.sendMessage(payload, (response) => {
        resetSolvingState();

        if (!response || !response.success) {
          showError(response?.error || "Failed to solve question");
          return;
        }

        const { result, latencyMs, actionType, methodUsed } = response;
        const isVision = methodUsed === "vision" || payload.preferredInputMethod === "vision";
        const latencySec = (latencyMs / 1000).toFixed(1);
        const pillConsensus = result.consensus ? ` (${result.consensus})` : "";
        const subjectTag = result.subject ? ` [${result.subject}]` : "";
        const answerLabel = formatAnswerLabel(result);

        if (isVision) {
          // Vision Crop Mode: cannot highlight or click DOM elements, so a simple notification is the right way
          showNotification(`✓ ${answerLabel} ${subjectTag} (${latencySec}s${pillConsensus})`, "success", 6000);
        } else {
          // DOM Mode: find and highlight / click target DOM element
          const targetElements = extracted?.elements?.length ? extracted.elements : findCandidateOptionElements();
          const targetEl = findTargetOptionElement(result, targetElements);

          if (targetEl) {
            applyAnswer(targetEl, result, latencyMs, actionType, payload);
            // In non-stealth mode, also show confirmation notification
            if (!isStealth) {
              showNotification(`✓ ${result.choice_text} ${subjectTag} (${latencySec}s${pillConsensus})`, "success", 4000);
            }
          } else {
            // Target DOM card not found, fallback to notification
            showNotification(`✓ ${answerLabel} ${subjectTag} (${latencySec}s${pillConsensus})`, "success", 5000);
          }
        }
      });
    } catch (err) {
      resetSolvingState();
      showError(err.message);
    }
  }

  function formatAnswerLabel(result) {
    if (!result) return "";
    const lettersEng = ["A", "B", "C", "D", "E", "F"];
    const lettersEth = ["ሀ", "ለ", "ሐ", "መ", "ሠ", "ረ"];
    const idx = typeof result.choice_index === "number" ? result.choice_index : -1;
    const rawText = (result.choice_text || "").trim();

    // If text already has a letter/number prefix like "ሀ.", "A)", "1.", keep as-is
    if (/^[ሀለሐመሠረabcdABCD0-9][.)\s]/.test(rawText)) {
      return rawText;
    }

    if (idx >= 0 && idx < lettersEng.length) {
      return `${lettersEng[idx]} (${lettersEth[idx]}): ${rawText}`;
    }

    return rawText;
  }

  function showNotification(htmlContent, type = "success", durationMs = 5000) {
    const infoPill = document.getElementById("anser-info-pill");
    if (!infoPill) return;

    clearTimeout(infoPillTimeout);

    infoPill.innerHTML = `
      <span class="anser-pill-dot"></span>
      <span class="anser-pill-text">${htmlContent}</span>
    `;
    infoPill.className = `anser-info ${type}`;
    infoPill.classList.remove("hidden");

    infoPillTimeout = setTimeout(() => {
      infoPill.classList.add("hidden");
    }, durationMs);
  }

  function showError(msg) {
    if (isStealth) {
      console.warn("[Anser]:", msg);
      return;
    }
    showNotification(`⚠️ ${msg}`, "error", 4500);
  }

  // 6. Listen for messages from background (Hotkey Alt+Q) or direct keydown
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "TRIGGER_SOLVE") {
      triggerSolve();
    }
  });

  function handleHotkey(e) {
    if (e.altKey && (e.code === "KeyQ" || e.key === "q" || e.key === "Q")) {
      e.preventDefault();
      e.stopPropagation();
      triggerSolve();
    }
  }

  // Capture phase on both window and document to ensure event is handled even if page stops bubbling
  window.addEventListener("keydown", handleHotkey, { capture: true });
  document.addEventListener("keydown", handleHotkey, { capture: true });

  // Initialize widget when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createWidget);
  } else {
    createWidget();
  }
})();
