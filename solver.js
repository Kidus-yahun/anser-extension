/**
 * Anser - Accuracy engine (runs inside the service worker).
 *
 * Pipeline per question:
 *   clean input -> pick subject -> N parallel "reason in English" votes
 *   -> majority (tie => extra vote or verifier) -> optional verification pass -> final answer.
 *
 * Depends on (globals): ANSER_DEFAULTS (config.js), ANSER_SUBJECTS/detectSubject (subjects.js),
 * AnserText (textutils.js), callModelText (background.js).
 */

const ANSWER_LETTERS = ["A", "B", "C", "D", "E", "F"];

// ─── Settings & few-shots ────────────────────────────────────────────────────

async function loadAccuracySettings() {
  const { accuracySettings } = await chrome.storage.local.get(["accuracySettings"]);
  const s = { ...ANSER_DEFAULTS, ...(accuracySettings || {}) };
  s.votes = Math.max(1, Math.min(5, parseInt(s.votes, 10) || 1));
  return s;
}

let _fileFewShots = null;
async function loadFileFewShots() {
  if (_fileFewShots) return _fileFewShots;
  try {
    const res = await fetch(chrome.runtime.getURL("fewshots.json"));
    _fileFewShots = await res.json();
  } catch (e) {
    console.warn("[Anser] fewshots.json could not be loaded:", e);
    _fileFewShots = {};
  }
  return _fileFewShots;
}

async function getFewShots(subject, settings) {
  if (!settings.useFewShots) return [];
  const file = await loadFileFewShots();
  const { fewShotsUser } = await chrome.storage.local.get(["fewShotsUser"]);
  const mine = (fewShotsUser && fewShotsUser[subject]) || [];
  const base = Array.isArray(file[subject]) ? file[subject] : [];
  return [...mine, ...base]
    .filter((x) => x && x.question && Array.isArray(x.options) && /^[A-F]$/.test(x.answer || ""))
    .slice(0, settings.maxFewShotsPerSubject);
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function formatOptions(choices) {
  return choices.map((c, i) => `${ANSWER_LETTERS[i]}) ${c}`).join("\n");
}

function buildSystemPrompt(subject, shots) {
  const cfg = ANSER_SUBJECTS[subject] || ANSER_SUBJECTS.General;
  const n = "A, B, C, D";
  let p = `${cfg.system}

The question and options may be written in Amharic (Ge'ez script), English, or a mix. Options are labelled ${n} by their position (A = ሀ, B = ለ, C = ሐ, D = መ). Follow this protocol exactly:

1. TRANSLATE: Translate the question and EVERY option into English. Copy numbers, units, symbols and names exactly. Detect negative or exclusive wording such as አይደለም, ያልሆነው, የማይካተተው, የተሳሳተው, NOT, EXCEPT, FALSE, LEAST — if present, you must pick the option that does NOT fit.
2. SOLVE IN ENGLISH: Work out the answer step by step in English before looking at the options. ${cfg.hints}
3. CHECK EVERY OPTION: Compare your result with each option and eliminate the wrong ones. If nothing matches exactly, recheck your work, then choose the closest correct option.
4. FINISH: Keep the reasoning compact. The very last line of your reply must be exactly:
ANSWER: X
where X is one capital letter (the option label). Write nothing after it. Never answer with option text instead of the letter.`;

  if (shots && shots.length) {
    p += "\n\nSOLVED EXAMPLES (same format you must follow):";
    shots.forEach((s, i) => {
      p += `\n\n--- Example ${i + 1} ---\nQuestion: ${s.question}\n${formatOptions(s.options)}\nReasoning: ${s.reasoning || "(verified correct answer)"}\nANSWER: ${s.answer}`;
    });
  }
  return p;
}

function buildUserPrompt(question, choices, hasImage, extra) {
  let p = `QUESTION:\n${question}\n\nOPTIONS:\n${formatOptions(choices)}`;
  if (hasImage) {
    p += "\n\nNOTE: This question contains an image/figure that is NOT available to you. Use the text only; if the answer truly depends on the figure, pick the most probable option.";
  }
  if (extra) p += `\n\n${extra}`;
  p += `\n\nTranslate to English, solve step by step, check every option, then end with the line "ANSWER: X".`;
  return p;
}

function buildVerifyPrompt(question, choices, hasImage, tally, proposedLetter) {
  const tallyText = Object.entries(tally).map(([l, c]) => `${l}×${c}`).join(", ");
  const extra = `VERIFICATION TASK: Independent solution attempts produced: ${tallyText || "none"}. The leading candidate is ${proposedLetter}. Do NOT assume it is right. Translate the question to English, re-solve it from scratch (recompute every number), then test EACH option one by one (A, B, C, D…) stating briefly why it is right or wrong. End with "ANSWER: X" for the option you are now convinced is correct (it may differ from ${proposedLetter}).`;
  return buildUserPrompt(question, choices, hasImage, extra);
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** Returns 0-based option index of the LAST "ANSWER: X" in the text, or -1. */
function parseAnswerIndex(text, nOptions) {
  if (!text) return -1;
  const re = /ANSWER\s*[:：=]\s*[*_`(\[]*\s*([A-Fa-f])(?![A-Za-z])/g;
  let m, last = -1;
  while ((m = re.exec(text))) last = m[1].toUpperCase().charCodeAt(0) - 65;
  return last >= 0 && last < nOptions ? last : -1;
}

function extractReasoning(text) {
  const body = (text || "").replace(/ANSWER\s*[:：=][\s\S]*$/i, "").trim().replace(/\s+/g, " ");
  return body.length > 400 ? "…" + body.slice(-400) : body;
}

// ─── Calling the model with format-retry ─────────────────────────────────────

async function callAndParse(ctx, systemPrompt, userPrompt, temperature) {
  const { settings, choices } = ctx;
  let lastErr = new Error("No valid answer");
  for (let attempt = 0; attempt <= settings.maxFormatRetries; attempt++) {
    const prompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\nREMINDER: Your previous reply did not end with the required line. Finish with exactly one last line: ANSWER: X (X = one capital letter from ${ANSWER_LETTERS.slice(0, choices.length).join(", ")}).`;
    try {
      const text = await callModelText(ctx.provider, ctx.apiKey, ctx.model, systemPrompt, prompt, ctx.customBaseUrl, {
        temperature,
        thinkingLevel: settings.thinkingLevel,
        thinkingBudgets: settings.thinkingBudgets,
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        maxRetries429: settings.maxRetries429
      });
      const idx = parseAnswerIndex(text, choices.length);
      if (idx >= 0) return { idx, text };
      lastErr = new Error("Model reply had no valid 'ANSWER: X' line");
    } catch (e) {
      lastErr = e;
      if (e && e.fatal) throw e; // bad key / unsupported model: retrying will not help
    }
  }
  throw lastErr;
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * @param {object} p { question, choices, hasImage, provider, apiKey, model, customBaseUrl, votesOverride }
 * @returns {object} { choice_index, choice_text, reasoning, consensus, votes, totalVoters, subject, tally, verification, ... }
 */
async function solveMCQ(p) {
  const settings = await loadAccuracySettings();
  if (typeof p.votesOverride === "number") settings.votes = Math.max(1, Math.min(5, p.votesOverride));

  // 5. Clean the input (second line of defence; content.js already cleaned it)
  let question = AnserText.normalizeText(p.question);
  let choices = (p.choices || []).map((c) => AnserText.stripOptionLabel(c));
  if (choices.length < 2) {
    const split = AnserText.splitMergedOptions(question);
    if (split) { question = split.question || question; choices = split.options; }
  }
  choices = choices.slice(0, ANSWER_LETTERS.length);
  if (!question || choices.length < 2) throw new Error("Could not read the question and options.");

  // 4. Subject
  const subject =
    settings.subject && settings.subject !== "auto" && ANSER_SUBJECTS[settings.subject]
      ? settings.subject
      : detectSubject(question, choices);
  const shots = await getFewShots(subject, settings);
  const systemPrompt = buildSystemPrompt(subject, shots);
  const userPrompt = buildUserPrompt(question, choices, !!p.hasImage);

  const ctx = { provider: p.provider, apiKey: p.apiKey, model: p.model, customBaseUrl: p.customBaseUrl, settings, choices };

  // 3. Voting (same model, N parallel samples)
  const tasks = Array.from({ length: settings.votes }, () => async () => {
    try { return await callAndParse(ctx, systemPrompt, userPrompt, settings.temperature); }
    catch (e) { return { error: e }; }
  });
  let results = await runPool(tasks, settings.concurrency);
  let good = results.filter((r) => r && r.idx !== undefined);

  if (good.length === 0) {
    const firstErr = results.find((r) => r && r.error)?.error;
    throw new Error(firstErr?.message || "All attempts failed");
  }

  const tallyOf = (arr) => {
    const t = new Map();
    arr.forEach((r) => t.set(r.idx, (t.get(r.idx) || 0) + 1));
    return t;
  };
  const leaders = (t) => {
    const max = Math.max(...t.values());
    return { max, idxs: [...t.entries()].filter(([, c]) => c === max).map(([i]) => i) };
  };

  let tally = tallyOf(good);
  let { max, idxs } = leaders(tally);

  // Tie and no verifier => one extra vote to break it
  if (idxs.length > 1 && settings.verifyMode === "off") {
    const extra = await runPool([() => callAndParse(ctx, systemPrompt, userPrompt, settings.temperature).catch((e) => ({ error: e }))], 1);
    if (extra[0] && extra[0].idx !== undefined) {
      good = good.concat(extra);
      tally = tallyOf(good);
      ({ max, idxs } = leaders(tally));
    }
  }

  // First leader in vote order wins ties unless the verifier decides
  let finalIdx = good.find((r) => idxs.includes(r.idx)).idx;
  const sample = good.find((r) => r.idx === finalIdx);
  const split = tally.size > 1;
  const tallyLetters = {};
  [...tally.entries()].sort((a, b) => b[1] - a[1]).forEach(([i, c]) => (tallyLetters[ANSWER_LETTERS[i]] = c));

  // 8. Verification pass
  const verification = { ran: false, answer: null, changed: false };
  const wantVerify = settings.verifyMode === "always" || (settings.verifyMode === "split" && split);
  let reasoning = extractReasoning(sample.text);
  if (wantVerify) {
    try {
      const vPrompt = buildVerifyPrompt(question, choices, !!p.hasImage, tallyLetters, ANSWER_LETTERS[finalIdx]);
      const v = await callAndParse(ctx, systemPrompt, vPrompt, settings.verifyTemperature);
      verification.ran = true;
      verification.answer = ANSWER_LETTERS[v.idx];
      if (v.idx !== finalIdx) { verification.changed = true; finalIdx = v.idx; }
      reasoning = extractReasoning(v.text);
    } catch (e) {
      console.warn("[Anser] Verification failed, keeping vote result:", e.message);
    }
  }

  const agreed = tally.get(finalIdx) || 0;
  let label = `${agreed}/${good.length} agreed`;
  if (verification.ran) label += verification.changed ? " · verifier changed answer" : " · verified ✓";

  return {
    choice_index: finalIdx,
    choice_text: choices[finalIdx],
    reasoning,
    consensus: label,
    votes: agreed,
    totalVoters: good.length,
    subject,
    tally: tallyLetters,
    verification,
    choices,
    fewShotsUsed: shots.length
  };
}
