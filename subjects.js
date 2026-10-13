/**
 * Anser - Subject configuration.
 * Edit the system prompts / hints / keywords freely. Few-shot examples live in fewshots.json.
 * Amharic keywords are best-effort: if a subject is detected wrongly, pick it manually in the popup.
 */
const ANSER_SUBJECTS = {
  Math: {
    system: "You are an expert Ethiopian Grade 9-12 Mathematics teacher following the Ethiopian national curriculum (Natural Science stream, EUEE).",
    hints: "Show every calculation. Recompute arithmetic a second time before choosing. Watch for sign errors, order of operations, domain restrictions and unit conversions. Substitute each option back into the problem when that is faster than solving directly.",
    keywords: ["እኩልታ", "ተግባር", "ማትሪክስ", "ሎጋሪዝም", "ሶስት ማዕዘን", "ሦስት ማዕዘን", "ዲተርሚናንት", "ተከታታይ ቁጥር", "ዕድል", "ወሰን", "ስሌት", "ድምር", "ጥምርታ", "log", "sin", "cos", "tan", "√", "∫", "lim", "x²", "x^2", "f(x)", "polynomial", "equation"]
  },
  Physics: {
    system: "You are an expert Ethiopian Grade 9-12 Physics teacher following the Ethiopian national curriculum (Natural Science stream, EUEE).",
    hints: "Write the governing formula, substitute the numbers WITH units, compute, and check units and order of magnitude. Convert units to SI first (km/h to m/s, g to kg, cm to m). Use g = 10 m/s² only if the question says so, otherwise 9.8 m/s² and pick the closest option. Watch vector direction and signs.",
    keywords: ["ፍጥነት", "ኃይል", "ሃይል", "ጉልበት", "ፍጥነት መጨመር", "ማፍጠን", "ኒውተን", "ጁል", "ዋት", "ቮልት", "ኦኤም", "ኦህም", "ሞገድ", "ብርሃን", "ኤሌክትሪክ", "ጅረት", "ግፊት", "ሙቀት", "ማግኔት", "ግጭት", "ስበት", "መነፅር", "m/s", "kg", "newton", "joule", "watt", "velocity", "acceleration", "current"]
  },
  Chemistry: {
    system: "You are an expert Ethiopian Grade 9-12 Chemistry teacher following the Ethiopian national curriculum (Natural Science stream, EUEE).",
    hints: "Balance equations before using them. Carry units through every step (g, mol, L, M). Compute molar masses from the periodic table carefully. For periodic trends, electron configuration, bonding and organic naming, state the rule you apply before choosing.",
    keywords: ["ኬሚካል", "ኬሚስትሪ", "አቶም", "ሞል", "ኤሌክትሮን", "ፕሮቶን", "አሲድ", "ቤዝ", "ንጥረ ነገር", "ውህድ", "ሞለኪውል", "ኦክሳይድ", "አዮን", "ፔሪዮዲክ", "ኦርጋኒክ", "ኤሌክትሮሊሲስ", "ኬሚካላዊ ምላሽ", "mol", "pH", "H2O", "NaCl", "HCl", "NaOH", "CO2", "H2SO4", "reaction", "acid", "molar"]
  },
  Biology: {
    system: "You are an expert Ethiopian Grade 9-12 Biology teacher following the Ethiopian national curriculum (Natural Science stream, EUEE).",
    hints: "Use standard textbook terminology. Recall the exact definition or process, then compare each option to it. For genetics, set up the cross (Punnett square) and compute ratios explicitly. Beware of absolute words such as 'only', 'always', 'never' in options.",
    keywords: ["ሴል", "ህዋስ", "ሕዋስ", "ዘረ-መል", "ዘረመል", "ጂን", "ዲኤንኤ", "ፎቶሲንተሲስ", "ብርሃን ተዋሕዶ", "እፅዋት", "ዕፅዋት", "እንስሳ", "ባክቴሪያ", "ቫይረስ", "ደም", "ኢንዛይም", "ሚቶኮንድሪያ", "ክሮሞዞም", "ሥነ ምህዳር", "ሜታቦሊዝም", "ዝግመተ ለውጥ", "cell", "gene", "DNA", "enzyme", "photosynthesis", "organism"]
  },
  English: {
    system: "You are an expert English-language teacher preparing Ethiopian Grade 9-12 students for the EUEE, following the Ethiopian national curriculum.",
    hints: "The question is in English. Identify what is tested (tense, agreement, conditionals, reported speech, prepositions, vocabulary, synonym/antonym, reading comprehension). State the grammar rule or the meaning, then test each option. For reading comprehension, rely only on the passage given.",
    keywords: ["grammar", "synonym", "antonym", "tense", "passage", "sentence", "correct form", "choose the", "underlined", "blank", "pronoun", "preposition", "adjective", "adverb", "reported speech", "conditional", "paragraph", "meaning of the word", "____"]
  },
  Aptitude: {
    system: "You are an expert in scholastic aptitude tests (verbal, numerical and abstract reasoning) preparing Ethiopian Grade 12 students for the EUEE.",
    hints: "Identify the pattern or logical rule explicitly (differences, ratios, alternating series, analogy relation, syllogism). Verify the rule on EVERY given term before applying it to find the answer. For syllogisms, test each option against the premises only, ignoring real-world knowledge.",
    keywords: ["ቀጣዩ", "ተከታታይ", "ቅደም ተከተል", "ተመሳሳይ ግንኙነት", "analogy", "series", "sequence", "next number", "odd one out", "syllogism", "all of the following"]
  },
  General: {
    system: "You are an expert Ethiopian Grade 9-12 teacher following the Ethiopian national curriculum, preparing students for the EUEE.",
    hints: "First identify exactly what is asked (subject entity and the precise attribute). Reject plausible trap distractors (similar names, adjacent dates, associated places). Respect the calendar system: the Ethiopian calendar (ዓ.ም) is about 7-8 years behind the Gregorian calendar.",
    keywords: []
  }
};

const ANSER_SUBJECT_NAMES = Object.keys(ANSER_SUBJECTS);

/** Cheap keyword scorer. Returns a subject name (falls back to "General"). */
function detectSubject(question, choices) {
  const text = ((question || "") + " " + (choices || []).join(" ")).toLowerCase();
  const letters = text.replace(/[^a-z\u1200-\u137F]/g, "");
  const ethiopic = (letters.match(/[\u1200-\u137F]/g) || []).length;
  const latin = (letters.match(/[a-z]/g) || []).length;
  const mostlyLatin = letters.length > 0 && ethiopic / letters.length < 0.1;

  const scores = {};
  for (const [name, cfg] of Object.entries(ANSER_SUBJECTS)) {
    let s = 0;
    for (const kw of cfg.keywords) {
      const k = kw.toLowerCase();
      if (/^[a-z]+$/.test(k)) {
        // plain English word: whole-word match only ("sin" must not hit "single")
        if (new RegExp("(^|[^a-z])" + k + "([^a-z]|$)").test(text)) s += 1;
      } else if (text.includes(k)) {
        s += 1;
      }
    }
    scores[name] = s;
  }
  // English-language question with no science vocabulary => most likely the English subject
  if (mostlyLatin && latin > 25 && scores.Math + scores.Physics + scores.Chemistry + scores.Biology === 0) {
    scores.English += 2;
  }
  let best = "General", bestScore = 0; // 1 keyword hit is enough; highest score wins
  for (const [name, s] of Object.entries(scores)) {
    if (name !== "General" && s > bestScore) { best = name; bestScore = s; }
  }
  return best;
}
