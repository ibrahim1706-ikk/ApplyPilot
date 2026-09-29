/**
 * Stage 3 — answering real application fields from the facts the user confirmed.
 *
 * This module is the bridge between "what we know about you" and "what a job
 * application asks for". For each standard field a form actually has — name,
 * email, phone, location, links, work rights, sponsorship, notice, salary, the
 * most recent role, years of experience, education, skills, certifications,
 * languages — it produces ONE answer, derived only from the user's own facts.
 *
 * The rules, without exception:
 *   - **No model calls, no network.** Plain deterministic string work, so the
 *     same facts always give the same answers and nothing can be invented.
 *   - **Only confirmed facts answer a field.** A fact the user has not confirmed
 *     is named as pending ("not confirmed yet — review it here") and its value is
 *     never used: not as the answer, not as a partial answer, not as a hint that
 *     the field might be covered. A fact the user excluded is never used either.
 *   - **Every answer carries its provenance.** An answer's sources are the facts
 *     themselves, each with the résumé line or vault field behind it, captioned
 *     in exactly the words the review screen uses (`factSourceCaption`).
 *   - **"not covered" is a real answer.** Where nothing covers a field, the
 *     engine says so and points at the exact place the detail belongs. It never
 *     computes a number, never picks a plausible default, never ranks the user's
 *     qualifications and never sums up their dates.
 *   - **Nothing is submitted, and nothing is stored.** This layer only reads.
 *     There is no submit path anywhere in the product, and these answers are
 *     recomputed from the facts every time they are asked for.
 *
 * Server-only: it reads through the storage module. The shapes it returns live in
 * `~/types` so the screen can render them without importing this file.
 */
import * as qualifications from "~/server/qualifications";
import {
  ANSWER_FIELD_SPECS,
  FACT_CATEGORY_ORDER,
  WORK_AUTHORISATION_OPTIONS,
  factSourceCaption,
} from "~/types";
import type {
  AnswerFieldKey,
  AnswerSource,
  Fact,
  FactCategory,
  FieldAnswer,
  FieldAnswerNudge,
  FieldAnswers,
} from "~/types";

// -------------------------------------------------------------- provenance ---

/**
 * The fact as an answer's source: the fact's own words, plus the line or vault
 * field behind it, captioned the way the review screen captions it. Nothing is
 * added to a fact here and nothing is inferred — a source is a copy of the fact
 * that answered the field.
 */
export function answerSource(fact: Fact): AnswerSource {
  return {
    factId: fact.id,
    category: fact.category,
    factLabel: fact.label,
    factValue: fact.value,
    fields: { ...fact.fields },
    quote: fact.quote,
    provenance: factSourceCaption(fact),
    note: fact.note,
    sourceGone: fact.sourceGone ?? false,
  };
}

// ------------------------------------------------------------------ nudges ---
//
// Where to add the real detail. Every hash is an element id that exists on the
// page it points at, so the link lands on the right field — the check script
// verifies each one against the route source rather than trusting this comment.

const PROFILE_NUDGES: Record<string, FieldAnswerNudge> = {
  name: {
    text: "Nothing you have confirmed gives your name.",
    action: "Add your full name in the vault's “About you” card",
    where: "profile",
    hash: "about-you",
  },
  email: {
    text: "Nothing you have confirmed gives an email address.",
    action: "Add your email in the vault's “About you” card",
    where: "profile",
    hash: "about-you",
  },
  phone: {
    text: "Nothing you have confirmed gives a phone number.",
    action: "Add your phone number in the vault's “About you” card",
    where: "profile",
    hash: "about-you",
  },
  location: {
    text: "Nothing you have confirmed says where you are based. We deliberately don't read a location out of a résumé line.",
    action: "Add your location in the vault's “About you” card",
    where: "profile",
    hash: "about-you",
  },
  links: {
    text: "Nothing you have confirmed gives a link like this.",
    action: "Add it in the vault's Links card",
    where: "profile",
    hash: "links",
  },
  work_rights: {
    text: "Nothing you have confirmed states your work rights. This is your own statement about your situation — we never derive one from your nationality, your address or anything else.",
    action: "Choose your work authorisation in the vault's Application basics card",
    where: "profile",
    hash: "work-authorisation",
  },
  sponsorship: {
    text: "Nothing you have confirmed settles whether you would need sponsorship.",
    action: "Choose your work authorisation in the vault's Application basics card",
    where: "profile",
    hash: "work-authorisation",
  },
  notice_period: {
    text: "Nothing you have confirmed states a notice period. We never assume one from a role's dates.",
    action: "Add your notice period in the vault's Application basics card",
    where: "profile",
    hash: "notice-period",
  },
  salary_expectation: {
    text: "Nothing you have confirmed states a salary expectation. We never suggest a range, a market rate or a “negotiable”.",
    action: "Add your salary expectation in the vault's Application basics card",
    where: "profile",
    hash: "salary",
  },
  current_role: {
    text: "Nothing you have confirmed reads as a role with a title or an employer.",
    action: "Add the role in the vault's Experience card, or under a dated heading in your résumé text",
    where: "profile",
    hash: "experience",
  },
};

/** Nudges that land on the review screen's own "add" form for a category. */
function addNudge(category: FactCategory, text: string, action: string): FieldAnswerNudge {
  return { text, action, where: "qualifications", hash: `add-${category}` };
}

const YEARS_NUDGE: FieldAnswerNudge = addNudge(
  "identity",
  "Nothing you have confirmed states how many years of experience you have. We don't calculate it from your role dates — that number would be ours, not yours.",
  "Add it as a detail on the review screen — for example “6 years of experience” — and confirm it"
);

const SKILLS_NUDGE = addNudge(
  "skill",
  "Nothing you have confirmed lists a skill or a tool. We never lift one out of a sentence, and we never add one you didn't write.",
  "Add a skill on the review screen, or put a SKILLS section in your résumé text"
);

const CERTIFICATIONS_NUDGE = addNudge(
  "certification",
  "Nothing you have confirmed lists a certification or a licence. We never infer one from a training provider mentioned elsewhere.",
  "Add a certification on the review screen, or put a CERTIFICATIONS heading in your résumé text"
);

const LANGUAGES_NUDGE = addNudge(
  "language",
  "Nothing you have confirmed lists a language. We never infer one from where you live or where you studied.",
  "Add a language on the review screen, or put a LANGUAGES heading in your résumé text"
);

const EDUCATION_NUDGE: FieldAnswerNudge = {
  text: "Nothing you have confirmed reads as a qualification or an institution.",
  action: "Add your education in the vault's Education card, or a dated qualification line in your résumé text",
  where: "profile",
  hash: "education",
};

// ----------------------------------------------------------- fact lookups ---

/** Facts by category, in the order the review screen lists them. */
function byCategory(facts: Fact[]): Record<FactCategory, Fact[]> {
  const out = Object.fromEntries(FACT_CATEGORY_ORDER.map((category) => [category, [] as Fact[]])) as Record<
    FactCategory,
    Fact[]
  >;
  for (const fact of facts) out[fact.category].push(fact);
  return out;
}

/** The identity facts carrying one of these labels, in list order. */
function byLabel(facts: Fact[], labels: readonly string[]): Fact[] {
  return facts.filter((fact) => fact.category === "identity" && labels.includes(fact.label));
}

// --------------------------------------------------- dates, for "most recent" ---
//
// Only ever used to put the roles in order. No duration is ever computed from
// them: the engine picks the most recent role, it does not add anything up.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function dateScore(text: string): number {
  const value = text.trim().toLowerCase();
  if (!value) return Number.NEGATIVE_INFINITY;
  if (/\b(present|current|now|ongoing|to date|today)\b/.test(value)) return Number.MAX_SAFE_INTEGER;
  const year = /\b(19|20)\d{2}\b/.exec(value);
  if (!year) return Number.NEGATIVE_INFINITY;
  const month = MONTHS.findIndex((name) => value.includes(name));
  return Number(year[0]) * 100 + (month + 1);
}

/** Roles ordered most recent first. A role with no dates sorts last, never first. */
export function rolesMostRecentFirst(facts: Fact[]): Fact[] {
  return facts
    .filter((fact) => fact.category === "role")
    .map((fact, index) => ({ fact, index }))
    .sort((a, b) => {
      const endA = dateScore(a.fact.fields.end ?? "");
      const endB = dateScore(b.fact.fields.end ?? "");
      if (endA !== endB) return endB - endA;
      const startA = dateScore(a.fact.fields.start ?? "");
      const startB = dateScore(b.fact.fields.start ?? "");
      if (startA !== startB) return startB - startA;
      return a.index - b.index;
    })
    .map((entry) => entry.fact);
}

// ------------------------------------------------------- stated years of exp ---
//
// The one place a "number" answer is allowed, and only because the user's own
// material states it. Both patterns require the word "experience", so a line
// about years of study or a date range cannot be mistaken for it.

const YEARS_WITH_EXPERIENCE_RE =
  /\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:\w+[-\s]){0,3}experience\b/i;
const EXPERIENCE_WITH_YEARS_RE = /\bexperience\s*[:\-–—]?\s*(\d{1,2}\s*\+?\s*(?:years?|yrs?))\b/i;

/** The exact phrase from the user's own text that states a number of years. */
export function statedYearsPhrase(text: string): string {
  const first = YEARS_WITH_EXPERIENCE_RE.exec(text);
  if (first) return first[0].replace(/\s+/g, " ").trim();
  const second = EXPERIENCE_WITH_YEARS_RE.exec(text);
  if (second?.[1]) return second[1].replace(/\s+/g, " ").trim();
  return "";
}

// ------------------------------------------------------- sponsorship mapping ---
//
// A form asks "will you need sponsorship?" and the user's vault holds a
// work-authorisation answer. Three of the five offered answers plainly settle
// that question, so the answer is a restatement of the user's own choice and the
// caveat says which choice it came from. The other two do NOT settle it, and the
// engine says so rather than picking the likelier reading.

const SPONSORSHIP_FROM_ANSWER: Record<string, { answer: string; caveat: string }> = {
  [WORK_AUTHORISATION_OPTIONS[0]]: {
    answer: "No",
    caveat:
      "Built from the work-rights answer you confirmed — you chose “Citizen or permanent resident”, which settles this question.",
  },
  [WORK_AUTHORISATION_OPTIONS[1]]: {
    answer: "No",
    caveat:
      "Built from the work-rights answer you confirmed — you chose “Visa with unrestricted work rights”, which settles this question.",
  },
  [WORK_AUTHORISATION_OPTIONS[3]]: {
    answer: "Yes",
    caveat:
      "Built from the work-rights answer you confirmed — you chose “I would need sponsorship”, which settles this question.",
  },
};

/** The answers that genuinely do not settle the sponsorship question. */
const SPONSORSHIP_NOT_SETTLED: Record<string, string> = {
  [WORK_AUTHORISATION_OPTIONS[2]]:
    "Your confirmed work-rights answer says you have a visa with limited work rights. That doesn't say whether you would need sponsorship later, so this field is left for you to answer — put your wording in the vault's work-authorisation note and it can be used next time.",
  [WORK_AUTHORISATION_OPTIONS[4]]:
    "Your confirmed work-rights answer is “Prefer not to say / not sure”, so there is nothing here to answer this question with. An application form is not a place to guess on your behalf.",
};

// --------------------------------------------------------------- the rules ---

type Rule = {
  /** Every fact in the set that addresses this field, in display order. */
  candidates: (facts: Fact[], index: Record<FactCategory, Fact[]>) => Fact[];
  /** The answer text, built from the CONFIRMED candidates only. */
  build: (confirmed: Fact[]) => string;
  /** A caveat about how the answer was put together, given the confirmed facts. */
  caveat?: (confirmed: Fact[], all: Fact[]) => string;
  /** One line for the single-value identity fields and the joined list fields. */
  notCovered: string;
  nudge: FieldAnswerNudge;
};

function firstValue(facts: Fact[]): string {
  return facts[0]?.value ?? "";
}

const RULES: Record<AnswerFieldKey, Rule> = {
  full_name: {
    candidates: (facts) => byLabel(facts, ["Name"]),
    build: firstValue,
    notCovered: "Your material doesn't state your name in any form we can quote.",
    nudge: PROFILE_NUDGES.name!,
  },
  email: {
    candidates: (facts) => byLabel(facts, ["Email"]),
    build: firstValue,
    notCovered: "Nothing you have confirmed gives an email address, and we never guess one from your name.",
    nudge: PROFILE_NUDGES.email!,
  },
  phone: {
    candidates: (facts) => byLabel(facts, ["Phone"]),
    build: firstValue,
    notCovered: "Nothing you have confirmed gives a phone number.",
    nudge: PROFILE_NUDGES.phone!,
  },
  location: {
    candidates: (facts) => byLabel(facts, ["Location"]),
    build: firstValue,
    notCovered:
      "Nothing you have confirmed says where you are based. We only use the Location field in your vault for this — a city line in a résumé is too easy to mistake for an employer's address.",
    nudge: PROFILE_NUDGES.location!,
  },
  portfolio: {
    candidates: (facts) => byLabel(facts, ["Portfolio"]),
    build: firstValue,
    notCovered: "You have no portfolio or personal site confirmed, so this field stays empty rather than pointing somewhere you didn't name.",
    nudge: PROFILE_NUDGES.links!,
  },
  github: {
    candidates: (facts) => byLabel(facts, ["GitHub"]),
    build: firstValue,
    notCovered: "You have no GitHub link confirmed, so this field stays empty rather than pointing somewhere you didn't name.",
    nudge: PROFILE_NUDGES.links!,
  },
  linkedin: {
    candidates: (facts) => byLabel(facts, ["LinkedIn"]),
    build: firstValue,
    notCovered: "You have no LinkedIn link confirmed, so this field stays empty rather than pointing somewhere you didn't name.",
    nudge: PROFILE_NUDGES.links!,
  },
  work_rights: {
    candidates: (_facts, index) => index.work_rights,
    // The vault answer is the one the user chose for this exact question, so it
    // answers the field; anything else their material says about their work
    // rights stays beside it as an additional source rather than being dropped.
    build: (confirmed) => confirmed.find((fact) => fact.source.kind === "profile")?.value ?? firstValue(confirmed),
    caveat: (confirmed) =>
      confirmed.length > 1
        ? `Your material says more than one thing about this. The answer above is the work-rights statement you chose in your vault; the other ${String(
            confirmed.length - 1
          )} are quoted beside it so nothing is hidden.`
        : "",
    notCovered:
      "Nothing you have confirmed states your work rights. This is your own statement about your situation — we never derive one from your nationality, your address or anything else.",
    nudge: PROFILE_NUDGES.work_rights!,
  },
  sponsorship: {
    candidates: (_facts, index) => index.work_rights,
    build: () => "",
    notCovered:
      "Nothing you have confirmed settles whether you would need sponsorship. Forms ask this in their own words, so we leave it for you rather than reading it into your work-rights answer.",
    nudge: PROFILE_NUDGES.sponsorship!,
  },
  notice_period: {
    candidates: (facts) => byLabel(facts, ["Notice period"]),
    build: firstValue,
    notCovered: "Nothing you have confirmed states a notice period, and we never assume one from a role's dates.",
    nudge: PROFILE_NUDGES.notice_period!,
  },
  salary_expectation: {
    candidates: (facts) => byLabel(facts, ["Salary expectation"]),
    build: firstValue,
    notCovered:
      "Nothing you have confirmed states a salary expectation. We never suggest a range, a market rate or “negotiable” — the number would be ours, not yours.",
    nudge: PROFILE_NUDGES.salary_expectation!,
  },
  current_role: {
    candidates: (facts) => {
      const roles = rolesMostRecentFirst(facts);
      return roles.length > 0 ? [roles[0]!] : [];
    },
    build: (confirmed) => firstValue(confirmed),
    caveat: () => "",
    notCovered: "Nothing you have confirmed reads as a role with a title or an employer.",
    nudge: PROFILE_NUDGES.current_role!,
  },
  years_experience: {
    candidates: (facts) => facts.filter((fact) => statedYearsPhrase(fact.value) !== ""),
    build: (confirmed) => statedYearsPhrase(firstValue(confirmed)),
    caveat: () =>
      "The number above is stated in your own material, quoted word for word. We never calculate it from your role dates, and we never round it up.",
    notCovered:
      "Nothing you have confirmed states how many years of experience you have. We don't calculate it from your role dates — that number would be ours, not yours.",
    nudge: YEARS_NUDGE,
  },
  education: {
    candidates: (_facts, index) => index.education,
    build: (confirmed) => confirmed.map((fact) => fact.value).join(" · "),
    caveat: (confirmed) =>
      confirmed.length > 1
        ? `Your material states ${String(confirmed.length)} qualifications. They are all listed above in your own words — we don't rank them or pick the “highest”, so use the one this form asks for.`
        : "",
    notCovered: "Nothing you have confirmed reads as a qualification or an institution.",
    nudge: EDUCATION_NUDGE,
  },
  skills: {
    candidates: (_facts, index) => index.skill,
    build: (confirmed) => confirmed.map((fact) => fact.value).join(", "),
    caveat: (confirmed) =>
      confirmed.length > 0
        ? `Each skill above is one your material lists, in your own words. We never add a tool you didn't write.`
        : "",
    notCovered: "Nothing you have confirmed lists a skill or a tool.",
    nudge: SKILLS_NUDGE,
  },
  certifications: {
    candidates: (_facts, index) => index.certification,
    build: (confirmed) => confirmed.map((fact) => fact.value).join(" · "),
    caveat: () => "",
    notCovered: "Nothing you have confirmed lists a certification or a licence.",
    nudge: CERTIFICATIONS_NUDGE,
  },
  languages: {
    candidates: (_facts, index) => index.language,
    build: (confirmed) =>
      confirmed
        .map((fact) => {
          const level = (fact.fields.level ?? "").trim();
          return level ? `${fact.value} (${level})` : fact.value;
        })
        .join(", "),
    caveat: () => "",
    notCovered: "Nothing you have confirmed lists a language.",
    nudge: LANGUAGES_NUDGE,
  },
};

// ------------------------------------------------------------- the answers ---

function emptyCopy(hasFacts: boolean): string {
  return hasFacts
    ? "None of the facts we read have been confirmed by you yet, so there is nothing here we will answer a form with. Go through “What we found in your material”, keep or correct what's right, confirm the set — and these fields fill in from exactly that."
    : "We have nothing to answer from yet: there are no facts on your account at all. Add your résumé text or fill in the vault, then confirm what we read and these fields will fill in.";
}

/**
 * One answer per standard field, built from the facts that stand behind it.
 *
 * Pure: it takes a fact set and returns the answers, with no storage and no
 * network, which is what lets the check script exercise every rule directly.
 */
export function fieldAnswersFromFacts(facts: Fact[]): FieldAnswers {
  const index = byCategory(facts);
  const answers: FieldAnswer[] = [];
  const notes: string[] = [];
  const pendingFactIds = new Set<string>();
  const excludedFactIds = new Set<string>();

  for (const spec of ANSWER_FIELD_SPECS) {
    const rule = RULES[spec.key];
    const candidates = rule.candidates(facts, index);
    const confirmed = candidates.filter((fact) => fact.status === "confirmed");
    const pending = candidates.filter((fact) => fact.status === "suggested");
    const excluded = candidates.filter((fact) => fact.status === "excluded");

    for (const fact of pending) pendingFactIds.add(fact.id);
    for (const fact of excluded) excludedFactIds.add(fact.id);

    let status: FieldAnswer["status"] = "not-covered";
    let answer = "";
    let caveat = "";
    let notCovered = rule.notCovered;
    let nudge: FieldAnswerNudge | null = rule.nudge;
    let pendingNote = "";

    if (spec.key === "sponsorship") {
      // Wording the two remaining cases before anything else: a work-rights
      // answer that genuinely does not settle this question must not be turned
      // into a yes or a no.
      const vaultAnswer =
        confirmed.find((fact) => fact.source.kind === "profile")?.value.trim() ??
        (confirmed[0] ? firstValue(confirmed).trim() : "");
      const mapped = vaultAnswer ? SPONSORSHIP_FROM_ANSWER[vaultAnswer] : undefined;
      const unsettled = vaultAnswer ? SPONSORSHIP_NOT_SETTLED[vaultAnswer] : undefined;
      if (confirmed.length > 0 && mapped) {
        status = "answered";
        answer = mapped.answer;
        caveat = mapped.caveat;
        nudge = null;
      } else {
        if (unsettled) {
          notCovered = unsettled;
          // The note field is where the user's own wording for this belongs.
          nudge = { ...PROFILE_NUDGES.sponsorship!, hash: "work-authorisation-note" };
        } else if (confirmed.length > 0) {
          notCovered =
            `Your confirmed work-rights statement reads “${firstValue(confirmed)}”. That is your own wording, and it doesn't plainly settle whether you would need sponsorship, so this field is left for you to answer.`;
          nudge = PROFILE_NUDGES.sponsorship!;
        } else {
          nudge = PROFILE_NUDGES.sponsorship!;
        }
      }
    } else if (confirmed.length > 0) {
      status = "answered";
      answer = rule.build(confirmed).trim();
      caveat = rule.caveat ? rule.caveat(confirmed, facts) : "";
      nudge = null;
      // A build that produces nothing (a role with no title or employer, say) is
      // not an answer: it must not read as covered.
      if (!answer) {
        status = "not-covered";
        caveat = "";
        nudge = rule.nudge;
      }
    }

    if (status === "not-covered" && confirmed.length === 0 && pending.length > 0) {
      status = "pending";
      pendingNote = "not confirmed yet — review it here";
      nudge = null;
      if (spec.key === "current_role") {
        caveat =
          "The most recent role in your material hasn't been confirmed, and we won't answer with an older role in its place — that would point a form at a job you are not in.";
      } else {
        caveat =
          "Your material covers this, but nothing you have confirmed does, so no answer is written here.";
      }
    }

    // A form wants ONE answer. Where the user's material holds more than one
    // confirmed fact about a field, the answer is the statement they chose in
    // their vault (the one written for exactly this question) and every other
    // fact is quoted beside it — never blended into the answer, and never thrown
    // away.
    let sourceFacts = confirmed;
    let relatedFacts: Fact[] = [];
    if (status === "answered" && (spec.key === "work_rights" || spec.key === "sponsorship") && confirmed.length > 0) {
      const preferred = confirmed.find((fact) => fact.source.kind === "profile") ?? confirmed[0]!;
      sourceFacts = [preferred];
      relatedFacts = confirmed.filter((fact) => fact.id !== preferred.id);
    }

    answers.push({
      field: spec.key,
      group: spec.group,
      question: spec.question,
      hint: spec.hint,
      status,
      answer: status === "answered" ? answer : "",
      sources: status === "answered" ? sourceFacts.map(answerSource) : [],
      related: status === "answered" ? relatedFacts.map(answerSource) : [],
      pending: pending.map(answerSource),
      excluded: excluded.map(answerSource),
      notCovered: status === "not-covered" ? `Not covered — ${notCovered}` : "",
      pendingNote,
      caveat,
      nudge: status === "answered" ? null : nudge,
    });
  }

  const answered = answers.filter((item) => item.status === "answered").length;
  const pending = answers.filter((item) => item.status === "pending").length;
  const notCovered = answers.filter((item) => item.status === "not-covered").length;
  const confirmedCount = facts.filter((fact) => fact.status === "confirmed").length;

  if (pending > 0) {
    notes.push(
      `${String(pending)} of these fields ${pending === 1 ? "is" : "are"} covered by your material but not by anything you have confirmed, so no answer is written for ${
        pending === 1 ? "it" : "them"
      }. Confirming the fact is what makes it usable — we won't use it before that.`
    );
  }
  if (excludedFactIds.size > 0) {
    notes.push(
      `${String(excludedFactIds.size)} fact${excludedFactIds.size === 1 ? "" : "s"} you excluded would have answered a field on this page. Nothing is put back on your behalf: bring ${
        excludedFactIds.size === 1 ? "it" : "them"
      } back on the review screen if it should be used.`
    );
  }
  notes.push(
    answers.reduce((total, item) => total + item.sources.length, 0) === 0
      ? "Not one answer here was written from a fact you haven't confirmed, and nothing was filled in to fill a gap."
      : "Every answer above is built only from facts you confirmed, and every fact shows the line or vault field it came from."
  );

  const empty = confirmedCount === 0;

  return {
    answers,
    answered,
    pending,
    notCovered,
    confirmedCount,
    factCount: facts.length,
    empty,
    emptyCopy: emptyCopy(facts.length > 0),
    notes,
  };
}

/**
 * The answers for this account, read through the storage module exactly as the
 * review screen reads its facts — so both screens always speak about the same
 * fact set, with the same decisions applied. Nothing is written here.
 */
export function fieldAnswersFor(userId: string): FieldAnswers {
  return fieldAnswersFromFacts(qualifications.ensureFacts(userId).facts);
}
