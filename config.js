/**
 * Anser - Accuracy settings (ONE place for all tunables)
 * Shared by the service worker (importScripts) and the popup.
 * No secrets live here: the API key is stored in chrome.storage.local only.
 * Users can change most of these from the popup ("Accuracy Engine" card);
 * values saved there override these defaults.
 */
const ANSER_DEFAULTS = {
  // Self-consistency voting: 1 for lightning speed (~0.8s), up to 3 for consensus
  votes: 1,
  // Temperature 0.0 for pure greedy factual decoding when votes=1
  temperature: 0.0,
  // Turn off slow internal thinking so models answer in <1 second
  thinkingLevel: "off",
  thinkingBudgets: { low: 0, medium: 0, high: 0 },
  // Verification pass off to avoid secondary delay
  verifyMode: "off",
  verifyTemperature: 0.0,
  // Output token ceiling: 1000 tokens ensures reasoning + ANSWER: X are never cut off
  maxOutputTokens: 1000,
  // Generous 15s timeout to handle multimodal or network delays
  timeoutMs: 15000,
  // Retries when reply does not end with ANSWER: X
  maxFormatRetries: 1,
  // Retries on 429/503
  maxRetries429: 2,
  // Max simultaneous API calls
  concurrency: 3,
  // "auto" or one of: Math, Physics, Chemistry, Biology, English, Aptitude, General
  subject: "auto",
  // Use worked examples from fewshots.json
  useFewShots: true,
  maxFewShotsPerSubject: 2
};
