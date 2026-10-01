/**
 * Anser - Question Bank Dashboard Logic
 * Unified Copy All & Catalog Management
 */

document.addEventListener("DOMContentLoaded", () => {
  let allQuestions = [];
  let currentFilter = "all";
  let copyFormat = "text"; // "text" or "json"
  let toastTimeout = null;

  const countPill = document.getElementById("bank-count-pill");
  const cardsContainer = document.getElementById("cards-container");
  const emptyState = document.getElementById("empty-state");
  const noResults = document.getElementById("no-results");
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search-btn");
  const filterTags = document.querySelectorAll(".filter-tag");

  const copyAllBtn = document.getElementById("copy-all-btn");
  const copyAllLabel = document.getElementById("copy-all-label");
  const exportJsonBtn = document.getElementById("export-json-btn");
  const clearAllBtn = document.getElementById("clear-all-btn");
  const formatTextBtn = document.getElementById("format-text-btn");
  const formatJsonBtn = document.getElementById("format-json-btn");
  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toast-text");

  // 1. Initial Load from chrome.storage.local
  loadQuestionBank();

  // Real-time synchronization if background solves new questions
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.questionBank) {
      allQuestions = Array.isArray(changes.questionBank.newValue) ? changes.questionBank.newValue : [];
      renderView();
    }
  });

  function loadQuestionBank() {
    chrome.storage.local.get(["questionBank"], (data) => {
      allQuestions = Array.isArray(data.questionBank) ? data.questionBank : [];
      renderView();
    });
  }

  // 2. Format Switcher (Text vs JSON)
  formatTextBtn.addEventListener("click", () => {
    copyFormat = "text";
    formatTextBtn.classList.add("active");
    formatJsonBtn.classList.remove("active");
    copyAllLabel.textContent = "Copy All (Text)";
  });

  formatJsonBtn.addEventListener("click", () => {
    copyFormat = "json";
    formatJsonBtn.classList.add("active");
    formatTextBtn.classList.remove("active");
    copyAllLabel.textContent = "Copy All (JSON)";
  });

  // 3. Single-Click "Copy All"
  copyAllBtn.addEventListener("click", async () => {
    const listToCopy = getFilteredQuestions();
    if (listToCopy.length === 0) {
      showToast("Question bank is empty", "error");
      return;
    }

    let payload = "";
    if (copyFormat === "json") {
      payload = JSON.stringify(listToCopy, null, 2);
    } else {
      payload = formatQuestionsAsText(listToCopy);
    }

    try {
      await navigator.clipboard.writeText(payload);
      const originalText = copyAllLabel.textContent;
      copyAllBtn.classList.add("copied");
      copyAllLabel.textContent = `✓ Copied ${listToCopy.length} Questions!`;
      showToast(`✓ Copied ${listToCopy.length} questions to clipboard (${copyFormat.toUpperCase()})`);

      setTimeout(() => {
        copyAllBtn.classList.remove("copied");
        copyAllLabel.textContent = originalText;
      }, 2000);
    } catch (err) {
      console.error("Clipboard error:", err);
      showToast("Failed to copy to clipboard", "error");
    }
  });

  function formatQuestionsAsText(questions) {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const ethLetters = ["ሀ", "ለ", "ሐ", "መ", "ሠ", "ረ", "ሰ", "ሸ"];

    return questions
      .map((q, idx) => {
        const num = idx + 1;
        const qText = q.question;
        const choicesText = (q.choices || [])
          .map((c, cIdx) => {
            const isCorrect = cIdx === q.answer_index;
            const letter = letters[cIdx] || `${cIdx + 1}`;
            const eth = ethLetters[cIdx] || "";
            const marker = eth ? `${letter} (${eth})` : `${letter}`;
            return `   ${marker}) ${c}${isCorrect ? "  <-- [CORRECT ANSWER]" : ""}`;
          })
          .join("\n");

        const explanation = q.reasoning ? `\n   Explanation: ${q.reasoning}` : "";
        return `${num}. ${qText}\n${choicesText}${explanation}`;
      })
      .join("\n\n");
  }

  // 4. Export JSON File Download
  exportJsonBtn.addEventListener("click", () => {
    if (allQuestions.length === 0) {
      showToast("Question bank is empty", "error");
      return;
    }

    const jsonStr = JSON.stringify(allQuestions, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const now = new Date().toISOString().slice(0, 10);
    const filename = `anser-question-bank-${now}.json`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Downloaded ${filename}`);
  });

  // 5. Clear All with Confirmation
  clearAllBtn.addEventListener("click", () => {
    if (allQuestions.length === 0) {
      showToast("Bank is already empty");
      return;
    }

    const confirmClear = confirm(`Are you sure you want to clear all ${allQuestions.length} saved questions?`);
    if (confirmClear) {
      chrome.storage.local.set({ questionBank: [] }, () => {
        allQuestions = [];
        renderView();
        showToast("Question bank cleared");
      });
    }
  });

  // 6. Search and Filter
  searchInput.addEventListener("input", () => {
    const val = searchInput.value.trim();
    clearSearchBtn.classList.toggle("hidden", val.length === 0);
    renderView();
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.classList.add("hidden");
    renderView();
    searchInput.focus();
  });

  filterTags.forEach((tag) => {
    tag.addEventListener("click", () => {
      filterTags.forEach((t) => t.classList.remove("active"));
      tag.classList.add("active");
      currentFilter = tag.dataset.filter || "all";
      renderView();
    });
  });

  function getFilteredQuestions() {
    const query = searchInput.value.trim().toLowerCase();

    return allQuestions.filter((q) => {
      // Filter by method
      if (currentFilter === "dom") {
        if (!q.method?.toLowerCase().includes("dom") && !q.method?.toLowerCase().includes("consensus")) return false;
      } else if (currentFilter === "vision") {
        if (!q.method?.toLowerCase().includes("vision")) return false;
      }

      // Filter by search query
      if (query) {
        const inQ = (q.question || "").toLowerCase().includes(query);
        const inAns = (q.answer_text || "").toLowerCase().includes(query);
        const inReason = (q.reasoning || "").toLowerCase().includes(query);
        const inChoices = (q.choices || []).some((c) => c.toLowerCase().includes(query));
        if (!inQ && !inAns && !inReason && !inChoices) return false;
      }

      return true;
    });
  }

  // 7. Render View
  function renderView() {
    const totalCount = allQuestions.length;
    countPill.textContent = totalCount === 1 ? "1 question" : `${totalCount} questions`;

    if (totalCount === 0) {
      cardsContainer.innerHTML = "";
      emptyState.classList.remove("hidden");
      noResults.classList.add("hidden");
      return;
    }

    emptyState.classList.add("hidden");

    const filtered = getFilteredQuestions();
    if (filtered.length === 0) {
      cardsContainer.innerHTML = "";
      noResults.classList.remove("hidden");
      return;
    }

    noResults.classList.add("hidden");
    renderCards(filtered);
  }

  function renderCards(questions) {
    cardsContainer.innerHTML = "";
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const ethLetters = ["ሀ", "ለ", "ሐ", "መ", "ሠ", "ረ", "ሰ", "ሸ"];

    questions.forEach((q, idx) => {
      const card = document.createElement("div");
      card.className = "question-card";
      card.dataset.id = q.id;

      const timeAgo = formatTimeAgo(q.timestamp);
      const methodLabel = q.method || "Fast DOM";

      // Choices HTML
      const choicesHtml = (q.choices || [])
        .map((c, cIdx) => {
          const isCorrect = cIdx === q.answer_index;
          const letter = letters[cIdx] || `${cIdx + 1}`;
          const eth = ethLetters[cIdx] || "";
          const marker = eth ? `${letter} (${eth})` : `${letter}`;
          return `
            <div class="choice-item ${isCorrect ? "correct" : ""}">
              <span class="choice-marker">${marker}</span>
              <span class="choice-text">${escapeHtml(c)}</span>
              ${isCorrect ? `<svg class="correct-check" style="width:16px;height:16px;" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>` : ""}
            </div>
          `;
        })
        .join("");

      // Reasoning HTML
      const reasoningHtml = q.reasoning
        ? `
        <div class="reasoning-box">
          <span class="reasoning-label">Explanation:</span>
          <span>${escapeHtml(q.reasoning)}</span>
        </div>
      `
        : "";

      card.innerHTML = `
        <div class="card-header-bar">
          <div class="card-tags">
            <span class="q-index-tag">#${idx + 1}</span>
            <span class="method-tag">${escapeHtml(methodLabel)}</span>
            <span class="time-tag">${timeAgo}</span>
          </div>
          <div class="card-actions">
            <button class="card-action-btn copy-single" title="Copy this question">
              <svg style="width:13px;height:13px;" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="7" y="7" width="10" height="10" rx="2"/>
                <path d="M4 13H3a2 2 0 01-2-2V3a2 2 0 012-2h8a2 2 0 012 2v1"/>
              </svg>
              <span>Copy</span>
            </button>
            <button class="card-action-btn delete" title="Delete question">
              <svg style="width:13px;height:13px;" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 6h12M7 6V4a1 1 0 011-1h4a1 1 0 011 1v2M6 6l1 10a2 2 0 002 2h2a2 2 0 002-2l1-10"/>
              </svg>
            </button>
          </div>
        </div>

        <h3 class="card-question-text">${escapeHtml(q.question)}</h3>

        <div class="choices-stack">
          ${choicesHtml}
        </div>

        ${reasoningHtml}
      `;

      // Copy Single Card Handler
      card.querySelector(".copy-single").addEventListener("click", () => {
        const text = formatQuestionsAsText([q]);
        navigator.clipboard.writeText(text).then(() => {
          showToast(`✓ Copied Question #${idx + 1}`);
        });
      });

      // Delete Single Card Handler
      card.querySelector(".delete").addEventListener("click", () => {
        deleteQuestion(q.id);
      });

      cardsContainer.appendChild(card);
    });
  }

  function deleteQuestion(id) {
    allQuestions = allQuestions.filter((q) => q.id !== id);
    chrome.storage.local.set({ questionBank: allQuestions }, () => {
      renderView();
      showToast("Question deleted");
    });
  }

  // 8. Toast Helper
  function showToast(msg, type = "success") {
    clearTimeout(toastTimeout);
    toastText.textContent = msg;
    toast.classList.remove("hidden");
    toastTimeout = setTimeout(() => {
      toast.classList.add("hidden");
    }, 2500);
  }

  function formatTimeAgo(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    const now = new Date();
    const diffSec = Math.floor((now - date) / 1000);

    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});
