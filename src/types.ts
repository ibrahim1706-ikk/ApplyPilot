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
    hint: "The contact details every application form asks for.",
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

/** Facts grouped in display order, for the read-only screen. */
export function groupFacts(facts: Fact[]): Array<{ category: FactCategory; facts: Fact[] }> {
  return FACT_CATEGORY_ORDER.map((category) => ({
    category,
    facts: facts.filter((fact) => fact.category === category),
  }));
}

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
