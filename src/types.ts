/**
 * Types shared between server functions and components. Deliberately free of any
 * server-only imports so client components can use them safely.
 */

export type KeywordHit = {
  /** The skill/term as written on the posting (canonical spelling). */
  keyword: string;
  /** Verbatim snippet from the user's own profile that shows the keyword. */
  evidence: string;
  /** How many times the posting mentions it. */
  mentions: number;
  /** The posting treats it as a hard requirement. */
  required: boolean;
};

export type KeywordGap = {
  keyword: string;
  mentions: number;
  required: boolean;
};

export type KeywordMatch = {
  /** Posting asks for it and the profile shows it. */
  evidenced: KeywordHit[];
  /** Posting asks for it, profile says nothing about it. */
  missing: KeywordGap[];
  /** Share of posting keywords the profile evidences, 0-100. */
  coverage: number;
};

/**
 * A requirement the posting asks for that the profile does not cover. The kit
 * stops at these: it never fills them with a guess, it points the user at the
 * profile field where the real answer belongs.
 */
export type KitGap = {
  /** Honest statement of what the posting asks for and what the profile is missing. */
  text: string;
  /** One short instruction naming the field to fill in. */
  action: string;
  /** Which surface holds that field: the profile vault, or a card on the kit page. */
  where: "profile" | "kit";
  /** Element id to land on, so the link drops the user at the right field. */
  hash: string;
};

export type KitAnswer = {
  question: string;
  answer: string;
  /** Which profile fields this answer was drawn from (shown under the answer). */
  sources: string[];
  /** True when the profile has nothing to answer this with yet. */
  missingInput: boolean;
};

export type Kit = {
  generatedAt: string;
  generator: "rules";
  roleTitle: string;
  company: string;
  postingUrl: string;
  coverLetter: string;
  answers: KitAnswer[];
  keywordMatch: KeywordMatch;
  /** Explicit "your profile doesn't mention X" nudges, never invented facts. */
  gaps: KitGap[];
  /** Other questions the posting seems to ask, which the kit doesn't draft. */
  postingQuestions: string[];
  /** Profile fields the kit used, for transparency. */
  profileFactsUsed: string[];
  /** How much of the profile is filled in (0-100) — drives the "thin kit" warning. */
  profileCompleteness: number;
};

export type ApplicationSummary = {
  id: string;
  title: string;
  company: string;
  url: string;
  createdAt: string;
  hasKit: boolean;
  coverage: number | null;
  missingCount: number;
  /** When the user marked this kit as the one they are taking forward, if they did. */
  takenForwardAt: string | null;
};

export type ProfileFormValues = {
  full_name: string;
  email: string;
  phone: string;
  location: string;
  portfolio_url: string;
  github_url: string;
  linkedin_url: string;
  resume_text: string;
  education: { school: string; qualification: string; dates: string; details: string }[];
  experience: {
    title: string;
    company: string;
    start: string;
    end: string;
    description: string;
  }[];
  work_authorisation: string;
  work_authorisation_note: string;
  salary_expectation: string;
  notice_period: string;
};

export const WORK_AUTHORISATION_OPTIONS = [
  "Citizen or permanent resident",
  "Visa with unrestricted work rights",
  "Visa with limited work rights (e.g. student visa hours cap)",
  "I would need sponsorship",
  "Prefer not to say / not sure",
] as const;

/**
 * A file the user uploaded to the vault. The bytes stay on the server (they are
 * what the browser agent will attach to a real form later); the client only ever
 * sees this summary plus a preview of the text we managed to read.
 */
export type MaterialSummary = {
  id: string;
  /** "Résumé", "Transcript", … — the user's own label for the file. */
  label: string;
  /** True when this upload also filled the résumé text box. */
  isResume: boolean;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** How the text extraction went, so the UI can warn instead of pretending. */
  extractStatus: "ok" | "thin" | "empty" | "failed";
  extractNote: string;
  /** First part of the extracted text, for the vault preview. */
  textPreview: string;
  /** Total characters extracted (may exceed the preview length). */
  textLength: number;
};

// ------------------------------------------------------------- qualifications ---
//
// The facts layer. Everything here describes ONE discrete thing the user's own
// material says about them — a role, a degree, a skill, a number — together with
// the exact place it came from, so the review screen can show the source line
// beside the fact and the user can correct it. Nothing is ever derived from
// anything the user did not write: where the material is silent, the honest
// answer is "we couldn't find this", which is what `FACT_CATEGORY_COPY.empty` is
// for.
//
// These types are client-safe on purpose (no server imports): the review screen
// and the SQLite layer both build on them.

export type FactCategory =
  | "identity"
  | "role"
  | "education"
  | "skill"
  | "achievement"
  | "certification"
  | "language"
  | "work_rights";

/** The order categories are shown in, and the only values ever accepted. */
export const FACT_CATEGORY_ORDER = [
  "identity",
  "role",
  "education",
  "skill",
  "achievement",
  "certification",
  "language",
  "work_rights",
] as const satisfies readonly FactCategory[];

/** One editable piece of a fact. `key` matches the key in `Fact.fields`. */
export type FactFieldSpec = {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
};

/**
 * Which fields each category has. `value` is the fact's display text; the other
 * keys are the structured parts (a role's title, company and dates) that the
 * next step of the product will answer application fields from. Fields a
 * category does not list are never stored.
 */
export const FACT_FIELDS: Record<FactCategory, FactFieldSpec[]> = {
  identity: [{ key: "value", label: "Detail", placeholder: "alex@example.com" }],
  role: [
    { key: "title", label: "Job title", placeholder: "Marketing Coordinator" },
    { key: "company", label: "Company", placeholder: "Northwind" },
    { key: "start", label: "Start", placeholder: "Feb 2023" },
    { key: "end", label: "End", placeholder: "Present" },
    {
      key: "description",
      label: "What you did",
      multiline: true,
      hint: "Your own bullet points, exactly as your material has them.",
    },
  ],
  education: [
    { key: "qualification", label: "Qualification", placeholder: "Bachelor of Commerce" },
    { key: "school", label: "Institution", placeholder: "University of Melbourne" },
    { key: "dates", label: "Dates", placeholder: "2019 – 2022" },
    { key: "details", label: "Anything else", multiline: true, hint: "Majors, grades, certificates." },
  ],
  skill: [{ key: "value", label: "Skill or tool", placeholder: "Figma" }],
  achievement: [
    { key: "value", label: "What you did", multiline: true },
    {
      key: "metric",
      label: "The number it states",
      hint: "Only ever a number that appears in your material.",
    },
  ],
  certification: [
    { key: "value", label: "Certification", placeholder: "AWS Certified Cloud Practitioner" },
    { key: "year", label: "Year", placeholder: "2024" },
  ],
  language: [
    { key: "value", label: "Language", placeholder: "Spanish" },
    { key: "level", label: "Level", placeholder: "B2" },
  ],
  work_rights: [
    { key: "value", label: "What's true for you" },
    { key: "note", label: "Note", hint: "Optional — e.g. a visa expiry date." },
  ],
};

/** Human copy for each category: heading, explanation, and the honest empty answer. */
export const FACT_CATEGORY_COPY: Record<
  FactCategory,
  { title: string; hint: string; empty: string; addLabel: string }
> = {
  identity: {
    title: "Who you are",
    hint: "The contact details every application form asks for, plus your notice period and salary expectation from the vault.",
    empty: "We couldn't find any contact details — add your name and email in the profile vault.",
    addLabel: "Add a detail",
  },
  role: {
    title: "Roles",
    hint: "Jobs and placements, with dates, read from dated headings in your material.",
    empty:
      "We couldn't find any roles. There were no dated role headings in your résumé text and nothing saved in the vault's Experience list.",
    addLabel: "Add a role",
  },
  education: {
    title: "Education and qualifications",
    hint: "Degrees, diplomas and study, as your material states them.",
    empty:
      "We couldn't find any education. There was no education section with an institution or qualification in your résumé text, and nothing saved in the vault's Education list.",
    addLabel: "Add education",
  },
  skill: {
    title: "Skills and tools",
    hint: "Only what your material lists — we never add a tool you didn't mention.",
    empty:
      "We couldn't find a skills list. Put your skills under a heading like SKILLS or TECHNICAL SKILLS in your résumé text and we'll read them.",
    addLabel: "Add a skill",
  },
  achievement: {
    title: "Numbers in your material",
    hint: "Lines that state a measurable result, with the number they contain.",
    empty:
      "We couldn't find any quantified results. Lines like “grew sign-ups 40% in two quarters” are what we look for — nothing is calculated or estimated.",
    addLabel: "Add a result",
  },
  certification: {
    title: "Certifications and licences",
    hint: "Read from a certifications section in your material.",
    empty:
      "We couldn't find any certifications. List them under a heading like CERTIFICATIONS or LICENCES and we'll read them.",
    addLabel: "Add a certification",
  },
  language: {
    title: "Languages",
    hint: "Read from a languages section in your material.",
    empty:
      "We couldn't find any languages. List them under a heading like LANGUAGES — for example “English (native), Spanish (B2)”.",
    addLabel: "Add a language",
  },
  work_rights: {
    title: "Work rights",
    hint: "From your vault answer, plus anything your material states about visas or citizenship.",
    empty:
      "We couldn't find anything about your work rights. Choose an answer in the vault's Application basics card.",
    addLabel: "Add a work-rights statement",
  },
};

/** Where a fact came from. Every fact has exactly one. */
export type FactSource =
  /** A field the user filled in themselves, in the profile vault. */
  | { kind: "profile"; field: string; label: string }
  /** A verbatim line of résumé text (uploaded, extracted, or pasted). */
  | { kind: "resume"; line: number; section: string }
  /** The user typed this fact on the review screen. */
  | { kind: "user" };

/** Whether the user's own word stands behind a fact. Only "confirmed" is usable. */
export type FactStatus = "suggested" | "confirmed" | "excluded";

export type FactOrigin = "extracted" | "user";

export type Fact = {
  id: string;
  category: FactCategory;
  /** Short label, e.g. "Email", "Role", "Certification". */
  label: string;
  /** Display text. Kept in step with `fields` — see `deriveFactValue`. */
  value: string;
  fields: Record<string, string>;
  source: FactSource;
  /** The verbatim line (or field value) the fact came from, quoted next to it. */
  quote: string;
  /** A caveat about how we read it — shown, never hidden. */
  note: string;
  status: FactStatus;
  origin: FactOrigin;
  /** True once the user has changed any part of it. */
  edited: boolean;
  /**
   * True when the exact line this fact was read from is no longer in the user's
   * material, but their own corrected version is kept and shown. Never set by the
   * extractor — only when a decision outlives the line it was made about.
   */
  sourceGone?: boolean;
  /** When the user kept, corrected or added this fact (their own timestamp). */
  decidedAt?: string;
  /** A note the user attached to a fact they added themselves. */
  userNote?: string;
  /**
   * The fact exactly as it read when the user's decision was taken, so their
   * version can still be shown — and the original quote still cited — after the
   * material behind it changes.
   */
  originalValue?: string;
  createdAt: string;
  updatedAt: string;
};

/** A fact as the extractor produces it, before it has an id or a status. */
export type FactDraft = Pick<Fact, "category" | "label" | "value" | "fields" | "source" | "quote" | "note">;

/** One section heading the extractor recognised, for the "what we read" summary. */
export type SectionSummary = { kind: string; heading: string; line: number };

/** What a pass of the extractor found, and — just as importantly — didn't find. */
export type ExtractionReport = {
  extractedAt: string;
  /** Characters of résumé text that were read. */
  resumeChars: number;
  /** Sections recognised in the résumé text, in document order. */
  sections: SectionSummary[];
  counts: Record<FactCategory, number>;
  /** Plain-English "we couldn't find this" statements, one per empty category. */
  missing: string[];
  /** Notes about how something was read, or why nothing was. */
  notes: string[];
};

/**
 * The fact's display text, kept consistent with its structured fields so the two
 * can never drift apart. Used when the extractor builds a fact and every time the
 * user saves an edit.
 */
export function deriveFactValue(
  category: FactCategory,
  fields: Record<string, string>,
  fallback = ""
): string {
  const get = (key: string): string => (fields[key] ?? "").trim();
  if (category === "role") {
    const title = get("title");
    const company = get("company");
    const dates = [get("start"), get("end")].filter(Boolean).join(" – ");
    const who = title && company ? `${title} at ${company}` : title || company;
    return [who, dates ? `(${dates})` : ""].filter(Boolean).join(" ");
  }
  if (category === "education") {
    const qualification = get("qualification");
    const school = get("school");
    const dates = get("dates");
    const what =
      qualification && school ? `${qualification}, ${school}` : qualification || school;
    return [what, dates ? `(${dates})` : ""].filter(Boolean).join(" ");
  }
  return get("value") || fallback.trim();
}

/** Just the `value` field of a fact, for comparing two facts for equivalence. */
export function normalisedFactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Human description of where a fact came from, shown under its quote. Lives here
 * (not in the extractor) because the client needs it and the extractor is
 * server-only.
 */
export function factSourceLabel(source: FactSource): string {
  if (source.kind === "profile") return `From your vault — ${source.label}`;
  if (source.kind === "resume") return `From your résumé text, line ${source.line}`;
  return "Added by you";
}

/**
 * The caption under a fact's quoted line.
 *
 * While the fact still traces to something the material has, this says where it
 * is read from, in the present tense. Once the exact line is gone
 * (`sourceGone` — a decision that outlived the line behind it) it reads as a PAST
 * reading instead, because the stored line is what the material said when we read
 * it, not where the fact sits now: saying "from line 10" about a line 10 that has
 * since changed would assert a location the material no longer supports.
 */
export function factSourceCaption(fact: Fact): string {
  const section =
    fact.source.kind === "resume" && fact.source.section !== "other"
      ? `read in your “${fact.source.section}” section`
      : null;
  if (fact.sourceGone) {
    const was =
      fact.source.kind === "resume"
        ? `Was read from your résumé text, line ${fact.source.line}`
        : fact.source.kind === "profile"
          ? `Was read from your vault — ${fact.source.label}`
          : "Was added by you";
    return [
      was,
      section ? `${section} when we read your material` : "when we read your material",
      fact.edited ? "edited by you after we read it" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
  }
  return [factSourceLabel(fact.source), section, fact.edited ? "edited by you after we read it" : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** Facts grouped in display order, for the read-only screen. */
export function groupFacts(facts: Fact[]): Array<{ category: FactCategory; facts: Fact[] }> {
  return FACT_CATEGORY_ORDER.map((category) => ({
    category,
    facts: facts.filter((fact) => fact.category === category),
  }));
}

// ------------------------------------------------------- the user's decisions ---
//
// Stage 2: the fact set becomes the user's own. What the extractor reads is only
// a suggestion; what the user keeps, corrects or adds is the record. Decisions
// are stored separately from the extracted facts, keyed by fact id, so a résumé
// change re-reads the material without throwing away anything the user decided.
//
// Nothing here is ever inferred: a decision is only ever something the user did.

export type FactDecisionAction = "keep" | "correct" | "exclude" | "add";

/** The fact exactly as it read when the user acted on it. */
export type FactSnapshot = {
  label: string;
  value: string;
  quote: string;
  note: string;
  source: FactSource;
};

export type FactDecision = {
  /** The fact this decision is about (its own id for a fact the user added). */
  id: string;
  category: FactCategory;
  action: FactDecisionAction;
  /** The user's own values — present for "correct" and "add", kept if later excluded. */
  fields?: Record<string, string>;
  /** Display text of the user's version, kept in step with `fields`. */
  value?: string;
  /** Optional note the user typed for a fact they added. */
  userNote?: string;
  /** How the fact read when the decision was taken (absent for "add"). */
  snapshot?: FactSnapshot;
  /**
   * `category|normalised value` of the fact as extracted. An exclusion sticks to
   * this rather than to a line number, so re-uploading the same résumé (whose
   * lines have moved) does not quietly bring back something the user removed.
   */
  valueKey: string;
  at: string;
};

/** `category|normalised value` — how a decision finds the fact it was made about. */
export function factValueKey(category: FactCategory, value: string): string {
  return `${category}|${normalisedFactText(value)}`;
}

/**
 * When the user confirmed a set as a whole, and a fingerprint of the set they
 * confirmed. If the set has changed since, the fingerprint no longer matches and
 * the confirmation reads as stale — the user is told, rather than the app
 * pretending an edited set was the one they signed off.
 */
export type FactConfirmation = { at: string; setHash: string };

export type FactConfirmations = {
  overall: FactConfirmation | null;
  categories: Record<FactCategory, FactConfirmation | null>;
};

export function emptyFactConfirmations(): FactConfirmations {
  return {
    overall: null,
    categories: Object.fromEntries(
      FACT_CATEGORY_ORDER.map((category) => [category, null])
    ) as Record<FactCategory, FactConfirmation | null>,
  };
}

/** What stage 3 gates on: has the user confirmed the facts as they now stand? */
export type ConfirmationStatus = "confirmed" | "changed" | "pending";

export function confirmationStatus(
  confirmations: FactConfirmations,
  scope: "overall" | FactCategory,
  currentHash: string
): ConfirmationStatus {
  const entry = scope === "overall" ? confirmations.overall : confirmations.categories[scope];
  if (!entry) return "pending";
  return entry.setHash === currentHash ? "confirmed" : "changed";
}

/** Short label for a fact's provenance and decision, for the review list. */
export type FactBadge =
  | "not-confirmed"
  | "kept"
  | "edited"
  | "excluded"
  | "you-added"
  | "line-gone"
  | "kept-line-gone";

export function factBadge(fact: Fact): FactBadge {
  if (fact.origin === "user") return "you-added";
  if (fact.status === "excluded") return "excluded";
  // The line behind a decision can go without the decision going with it. What
  // the user decided is stated first ("kept by you", "your version"), because
  // that is still true; the gone line is what is added.
  if (fact.sourceGone) return fact.edited ? "line-gone" : "kept-line-gone";
  if (fact.edited) return "edited";
  if (fact.status === "confirmed") return "kept";
  return "not-confirmed";
}

export const FACT_BADGE_COPY: Record<FactBadge, { label: string; className: string }> = {
  "not-confirmed": { label: "not confirmed yet", className: "bg-slate-100 text-slate-600" },
  kept: { label: "kept by you", className: "bg-emerald-100 text-emerald-800" },
  edited: { label: "edited by you", className: "bg-amber-100 text-amber-900" },
  excluded: { label: "excluded by you", className: "bg-slate-200 text-slate-600" },
  "you-added": { label: "you added this", className: "bg-indigo-100 text-indigo-800" },
  "line-gone": { label: "your version — line no longer in your material", className: "bg-amber-100 text-amber-900" },
  "kept-line-gone": { label: "kept by you — line no longer in your material", className: "bg-amber-100 text-amber-900" },
};

/** Labels offered for an uploaded material. The first one fills the résumé text. */
export const MATERIAL_LABELS = [
  "Résumé",
  "Cover letter sample",
  "Transcript",
  "Portfolio",
  "References",
  "Other",
] as const;

// ------------------------------------------------------------ upload limits ---
// These live here (not in the server-only extractor) so the UI can show the same
// limits the server enforces without pulling a parser into the browser bundle.

/** Hard cap on an uploaded file. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const HUMAN_MAX_SIZE = "5 MB";
export const SUPPORTED_FORMATS_COPY = "PDF, Word .docx, .txt or .md, up to 5 MB";
export const UPLOAD_ACCEPT_ATTRIBUTE =
  ".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

// -------------------------------------------------- answering a real form ---
//
// Stage 3. A job application asks for a fixed set of things; this is the list we
// answer, and the shape an answer comes back in. The engine itself
// (`src/server/field-answers.ts`) is server-only; these types and the copy below
// are client-safe so the screen can render an answer without ever reaching for
// the storage module.
//
// The rules the engine holds to, stated here because the screen's copy repeats
// them to the user:
//   - an answer is built ONLY from a fact the user has confirmed;
//   - every answer carries the fact it came from, and the résumé line or vault
//     field behind that fact, in the same words the review screen uses;
//   - a fact the user has not confirmed is named as pending and never used;
//   - where nothing covers a field, the honest answer is "not covered" plus a
//     pointer to the exact place the real detail belongs. There is no default,
//     no interpolation between facts, and nothing filled in to look complete.
//
// Nothing here is ever submitted: the app has no submit path.

/** The application fields this layer answers. One per real form question. */
export type AnswerFieldKey =
  | "full_name"
  | "email"
  | "phone"
  | "location"
  | "portfolio"
  | "github"
  | "linkedin"
  | "work_rights"
  | "sponsorship"
  | "notice_period"
  | "salary_expectation"
  | "current_role"
  | "years_experience"
  | "education"
  | "skills"
  | "certifications"
  | "languages";

export type AnswerGroup = "identity" | "arrangements" | "experience" | "qualifications";

/** Display copy for each group of fields, in the order they are shown. */
export const ANSWER_GROUP_COPY: Record<AnswerGroup, { title: string; hint: string }> = {
  identity: {
    title: "Who you are",
    hint: "The details nearly every application form opens with. Nothing here is completed for you — each one comes from a fact you confirmed.",
  },
  arrangements: {
    title: "Working arrangements",
    hint: "Work rights, sponsorship, notice and pay — the questions that decide whether an application can go ahead. Your own wording is used, never a standard answer.",
  },
  experience: {
    title: "Your experience",
    hint: "What your material says about your most recent role, and only the numbers your material actually states.",
  },
  qualifications: {
    title: "Qualifications, skills and languages",
    hint: "Every entry here is quoted as your material has it. We don't rank, summarise or upgrade anything.",
  },
};

/**
 * What a real form asks, per field, and which group it belongs to. The engine
 * fills the answer; the order below is the order the screen shows.
 */
export const ANSWER_FIELD_SPECS: Array<{
  key: AnswerFieldKey;
  group: AnswerGroup;
  question: string;
  hint: string;
}> = [
  { key: "full_name", group: "identity", question: "First and last name", hint: "As your material spells it." },
  { key: "email", group: "identity", question: "Email address", hint: "The one you gave us." },
  { key: "phone", group: "identity", question: "Phone number", hint: "Digits exactly as your material has them." },
  { key: "location", group: "identity", question: "Where you are based", hint: "City and country, from your vault." },
  { key: "portfolio", group: "identity", question: "Portfolio or personal website", hint: "Only if you have one saved." },
  { key: "github", group: "identity", question: "GitHub", hint: "Only if you have one saved." },
  { key: "linkedin", group: "identity", question: "LinkedIn", hint: "Only if you have one saved." },
  {
    key: "work_rights",
    group: "arrangements",
    question: "Are you authorised to work here? / what is your visa status?",
    hint: "Your own statement about your work rights.",
  },
  {
    key: "sponsorship",
    group: "arrangements",
    question: "Will you now or in the future need sponsorship?",
    hint: "Only answered from a work-rights answer that plainly settles it.",
  },
  { key: "notice_period", group: "arrangements", question: "Notice period / how soon could you start?", hint: "Your own wording." },
  { key: "salary_expectation", group: "arrangements", question: "Salary expectation", hint: "Your own wording, never a range we pick." },
  {
    key: "current_role",
    group: "experience",
    question: "Current or most recent job title and employer",
    hint: "The most recent role in your material, quoted as it stands.",
  },
  {
    key: "years_experience",
    group: "experience",
    question: "How many years of experience do you have?",
    hint: "Only when your material states a number itself — we never do the arithmetic for you.",
  },
  { key: "education", group: "qualifications", question: "Education / highest qualification", hint: "Every qualification your material states." },
  { key: "skills", group: "qualifications", question: "Skills and tools", hint: "The skills your material lists, in your own words." },
  { key: "certifications", group: "qualifications", question: "Certifications and licences", hint: "Only the ones your material states." },
  { key: "languages", group: "qualifications", question: "Languages", hint: "With the level your material gives, if it gives one." },
];

/** Which group a field belongs to, for grouping the answers on the screen. */
export function answerGroupOf(field: AnswerFieldKey): AnswerGroup {
  return ANSWER_FIELD_SPECS.find((spec) => spec.key === field)?.group ?? "identity";
}

/**
 * `answered` — at least one confirmed fact covers it, and the answer is built
 * from those facts alone.
 * `pending` — the material covers it, but nothing the user has confirmed does.
 * The answer is WITHHELD (empty) and the fact is named as pending.
 * `not-covered` — nothing in the material covers it. "not covered" is shown
 * with a pointer to where the real detail goes.
 */
export type FieldAnswerStatus = "answered" | "pending" | "not-covered";

/** One fact an answer was built from, with the line or field behind it. */
export type AnswerSource = {
  /** The fact's id — the same id the review screen lists it under. */
  factId: string;
  category: FactCategory;
  /** The fact's own short label, e.g. "Email", "Skill", "Role". */
  factLabel: string;
  /** The fact's display text, exactly as it stands (the user's wording if edited). */
  factValue: string;
  /** The structured parts of the fact, e.g. a role's title, company and dates. */
  fields: Record<string, string>;
  /** The résumé line or vault field value the fact was read from. */
  quote: string;
  /** Where that came from, in the review screen's own words. */
  provenance: string;
  /** The caveat the fact already carries, if any — shown, never hidden. */
  note: string;
  /** True when the line behind the fact is no longer in the user's material. */
  sourceGone: boolean;
};

/** Where to add the real detail for a field nothing covers. */
export type FieldAnswerNudge = {
  /** Plain statement of what is missing. */
  text: string;
  /** What to do about it, in one short instruction. */
  action: string;
  /** Which surface holds the place to add it. */
  where: "profile" | "qualifications";
  /** Element id to land on, so the link drops the user at the right place. */
  hash: string;
};

export type FieldAnswer = {
  field: AnswerFieldKey;
  group: AnswerGroup;
  /** The question as a real form asks it. */
  question: string;
  hint: string;
  status: FieldAnswerStatus;
  /** The answer text. Empty unless the status is "answered" — never a default. */
  answer: string;
  /** The facts the answer was built from. Never empty when answered. */
  sources: AnswerSource[];
  /**
   * Confirmed facts that say something else about this field, quoted beside the
   * answer rather than folded into it. The answer is never a blend of the two:
   * where a form wants one answer, the user's own chosen statement is it, and
   * anything else their material says is shown, not merged.
   */
  related: AnswerSource[];
  /** Facts that cover this field that the user has NOT confirmed. Never used. */
  pending: AnswerSource[];
  /** Facts the user excluded that would otherwise have covered this field. */
  excluded: AnswerSource[];
  /** Honest statement of what isn't covered. Empty when answered. */
  notCovered: string;
  /** The "not confirmed yet" sentence. Empty unless something is pending. */
  pendingNote: string;
  /** A caveat about how the answer was put together, e.g. we don't rank degrees. */
  caveat: string;
  /** Where to add what's missing. Null when the field is answered. */
  nudge: FieldAnswerNudge | null;
};

export type FieldAnswers = {
  answers: FieldAnswer[];
  answered: number;
  pending: number;
  notCovered: number;
  /** Facts the user confirmed — the only ones any answer can come from. */
  confirmedCount: number;
  /** Facts in the set at all: confirmed, still to confirm, and excluded. */
  factCount: number;
  /** True when no fact is confirmed yet: the honest empty state. */
  empty: boolean;
  emptyCopy: string;
  /** Things worth telling the user about this set of answers. */
  notes: string[];
};

/** Shown wherever a fact covers a field but the user hasn't confirmed it yet. */
export const PENDING_FACT_COPY = "not confirmed yet — review it here";

/** The lead-in on a field nothing in the confirmed set covers. */
export const NOT_COVERED_COPY = "not covered";

/** The nudge sentence used when the user excluded the fact that would have answered. */
export const EXCLUDED_FACT_COPY =
  "You excluded the fact we found for this, so it isn't used here — nothing is put back without you.";
