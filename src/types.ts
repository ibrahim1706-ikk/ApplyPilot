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
