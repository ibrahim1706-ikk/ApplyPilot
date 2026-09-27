/**
 * The qualifications facts layer — the deterministic extractor.
 *
 * It reads two things the user already gave us and nothing else:
 *   1. the résumé text on their profile (typed in, or the text we pulled out of
 *      a PDF / .docx they uploaded), and
 *   2. the structured fields they filled in the vault (education, experience,
 *      work authorisation, links).
 *
 * From those it produces a list of facts, each with the profile field or the
 * verbatim line it came from, so the user can check it.
 *
 * Rules this module holds to, without exception:
 *   - No model calls, no network, no external service. Plain string work, so
 *     the same input always gives the same output and nothing can be invented
 *     by a language model.
 *   - Nothing is inferred. A skill is only a skill if it is listed under a
 *     skills heading; a number is only reported if the user's own line contains
 *     it; an employer is only named if the text names it. When the material
 *     does not say, the category comes back empty and the report says so in
 *     plain words, matching `FACT_CATEGORY_COPY`.
 *   - Every fact carries a quote: the exact line of their material, or the
 *     exact value of the profile field, that it was read from.
 *
 * Ambitious reading is a bug here, not a feature. A résumé we half-read is
 * worse than one we admit we could not read: the whole product promise is that
 * every filled field traces back to the user's own words.
 *
 * Server-only: imports the storage module, so it must never reach a component.
 */
import { createHash } from "node:crypto";
import * as db from "~/db";
import { FACT_CATEGORY_COPY, FACT_CATEGORY_ORDER, deriveFactValue } from "~/types";
import type {
  ExtractionReport,
  Fact,
  FactCategory,
  FactDraft,
  FactSource,
  SectionSummary,
} from "~/types";

// --------------------------------------------------------------- the input ---

/** Everything the extractor is allowed to look at. Nothing else is passed in. */
export type QualificationInput = {
  resumeText: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  portfolioUrl: string;
  githubUrl: string;
  linkedinUrl: string;
  education: db.EducationEntry[];
  experience: db.ExperienceEntry[];
  workAuthorisation: string;
  workAuthorisationNote: string;
  salaryExpectation: string;
  noticePeriod: string;
};

export function inputFromProfile(profile: db.Profile): QualificationInput {
  return {
    resumeText: profile.resume_text ?? "",
    fullName: profile.full_name ?? "",
    email: profile.email ?? "",
    phone: profile.phone ?? "",
    location: profile.location ?? "",
    portfolioUrl: profile.portfolio_url ?? "",
    githubUrl: profile.github_url ?? "",
    linkedinUrl: profile.linkedin_url ?? "",
    education: profile.education ?? [],
    experience: profile.experience ?? [],
    workAuthorisation: profile.work_authorisation ?? "",
    workAuthorisationNote: profile.work_authorisation_note ?? "",
    salaryExpectation: profile.salary_expectation ?? "",
    noticePeriod: profile.notice_period ?? "",
  };
}

// ------------------------------------------------------------ section kinds ---

type SectionKind =
  | "identity"
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "certifications"
  | "languages"
  | "projects"
  | "achievements"
  | "other";

/** Headings we recognise, and which part of a résumé they open. */
const HEADINGS: Array<{ kind: SectionKind; patterns: RegExp[] }> = [
  {
    kind: "identity",
    patterns: [
      /^contact( details| information)?$/,
      /^personal (details|information)$/,
      /^details$/,
      // Work-rights lines usually sit under their own heading near the top.
      /^(work|working) rights$/,
      /^(work|working) (authorisation|authorization|permit)$/,
      /^right to work$/,
      /^visa (status|details)$/,
      /^eligibility to work$/,
    ],
  },
  {
    kind: "summary",
    patterns: [
      /^summary$/,
      /^(professional |career |personal )?(profile|summary|statement|objective)$/,
      /^about( me)?$/,
      /^career (overview|summary|profile|objective)$/,
    ],
  },
  {
    kind: "experience",
    patterns: [
      /^(work|professional|relevant|employment|industry)? ?(experience|history)$/,
      /^employment$/,
      /^career history$/,
      /^work history$/,
      /^professional background$/,
      /^(work|professional) record$/,
    ],
  },
  {
    kind: "education",
    patterns: [
      /^education$/,
      /^education (and|&) (training|qualifications)$/,
      /^academic (background|history|qualifications)$/,
      /^qualifications?$/,
      /^training( (and|&) education)?$/,
    ],
  },
  {
    kind: "skills",
    patterns: [
      /^(technical|core|key|professional|other|additional) skills$/,
      /^skills( (and|&) (tools|technologies|interests))?$/,
      /^(technical )?(skills|competencies|proficiencies|proficiency)$/,
      /^(tools|technologies|tech stack|technology stack)$/,
      /^(areas of )?expertise$/,
      /^(software|systems|platforms)$/,
    ],
  },
  {
    kind: "certifications",
    patterns: [
      /^certifications?$/,
      /^certifications? (and|&) (licences|licenses|training)$/,
      /^licences?$/,
      /^licenses?$/,
      /^licences? (and|&) certifications?$/,
      /^professional (development|certifications?)$/,
    ],
  },
  {
    kind: "languages",
    patterns: [/^languages?$/, /^language (skills|proficiency)$/],
  },
  {
    kind: "projects",
    patterns: [/^(personal |side |selected |key |notable )?projects?$/, /^portfolio$/],
  },
  {
    kind: "achievements",
    patterns: [
      /^(key |selected |notable |career )?(achievements|accomplishments|awards|honours|honors)$/,
    ],
  },
  {
    kind: "other",
    patterns: [
      /^(interests|hobbies|activities|extracurricular)$/,
      /^referees?$/,
      /^references?$/,
      /^volunteering$/,
      /^volunteer (work|experience)$/,
      /^publications?$/,
      /^(additional|other|further) information$/,
      /^memberships?$/,
    ],
  },
];

/** Job-title words, used only to tell a title line from an employer line. */
const TITLE_WORDS = [
  "manager",
  "engineer",
  "developer",
  "designer",
  "analyst",
  "coordinator",
  "assistant",
  "associate",
  "consultant",
  "officer",
  "director",
  "specialist",
  "administrator",
  "accountant",
  "teacher",
  "nurse",
  "technician",
  "researcher",
  "scientist",
  "representative",
  "executive",
  "supervisor",
  "architect",
  "recruiter",
  "writer",
  "marketer",
  "strategist",
  "lead",
  "intern",
  "trainee",
  "apprentice",
  "head of",
  "chief",
  "founder",
  "president",
  "partner",
  "advisor",
  "adviser",
  "counsel",
  "paralegal",
  "editor",
  "producer",
  "planner",
  "buyer",
  "scheduler",
  "operator",
  "attendant",
  "cook",
  "chef",
  "barista",
  "driver",
  "labourer",
  "laborer",
  "apprentice",
  "graduate",
  "tutor",
  "lecturer",
  "therapist",
  "pharmacist",
  "dentist",
  "electrician",
  "mechanic",
  "welder",
  "painter",
  "cleaner",
  "security",
  "receptionist",
  "cashier",
  "assistant manager",
  "product owner",
  "scrum master",
  "data scientist",
];

/** Words that mark a line as being about study rather than work. */
const EDUCATION_WORDS = [
  "university",
  "college",
  "institute",
  "polytechnic",
  "school",
  "academy",
  "faculty",
  "tafe",
  "bachelor",
  "master",
  "masters",
  "doctorate",
  "doctoral",
  "phd",
  "mba",
  "mfa",
  "bsc",
  "b.sc",
  "msc",
  "m.sc",
  "ba ",
  "b.a",
  "beng",
  "b.eng",
  "bcom",
  "b.com",
  "diploma",
  "certificate iii",
  "certificate iv",
  "associate degree",
  "degree",
  "honours",
  "honors",
  "gpa",
  "atar",
  "hsc",
  "vce",
  "wam",
  "thesis",
  "dissertation",
  "major",
  "graduated",
  "graduation",
];

/** Qualification markers, for reading a line inside an education section. */
const QUALIFICATION_WORDS = [
  "bachelor",
  "master",
  "masters",
  "doctor",
  "doctoral",
  "phd",
  "doctorate",
  "mba",
  "mfa",
  "bsc",
  "msc",
  "ba",
  "bs",
  "ms",
  "beng",
  "meng",
  "bcom",
  "b.com",
  "llb",
  "llm",
  "diploma",
  "advanced diploma",
  "graduate certificate",
  "graduate diploma",
  "certificate",
  "associate degree",
  "degree",
  "a levels",
  "a-levels",
  "high school diploma",
  "higher school certificate",
  "secondary education",
  "foundation studies",
];

const INSTITUTION_WORDS = [
  "university",
  "college",
  "institute",
  "institution",
  "polytechnic",
  "school",
  "academy",
  "faculty",
  "tafe",
  "conservatorium",
  "conservatory",
];

/** Units and verbs that make a line a *result* rather than just a sentence. */
const RESULT_UNITS = [
  "%",
  "percent",
  "per cent",
  "bps",
  "x ",
  "times",
  "fold",
  "hours",
  "hrs",
  "days",
  "weeks",
  "months",
  "years",
  "people",
  "users",
  "customers",
  "clients",
  "students",
  "subscribers",
  "downloads",
  "sign-ups",
  "signups",
  "registrations",
  "tickets",
  "accounts",
  "calls",
  "leads",
  "projects",
  "stores",
  "outlets",
  "sessions",
  "orders",
  "sales",
  "revenue",
  "budget",
  "costs",
  "followers",
  "views",
  "members",
  "employees",
  "staff",
  "shipments",
  "transactions",
  "records",
  "reports",
  "sites",
  "stores",
  "$",
  "£",
  "€",
  "aud",
  "usd",
  "eur",
  "gbp",
  "k ",
  "k,",
  "k.",
  "m ",
  "million",
  "billion",
  "thousand",
];

const RESULT_VERBS = [
  "grew",
  "growing",
  "growth",
  "increased",
  "increase",
  "decreased",
  "decrease",
  "reduced",
  "reduce",
  "reduction",
  "cut",
  "saved",
  "saving",
  "savings",
  "improved",
  "improvement",
  "raised",
  "raise",
  "drove",
  "driven",
  "generated",
  "boosted",
  "doubled",
  "tripled",
  "halved",
  "achieved",
  "delivered",
  "managed",
  "handled",
  "processed",
  "led",
  "trained",
  "scaled",
  "onboarded",
  "migrated",
  "shipped",
  "launched",
  "automated",
  "cleaned",
  "moderated",
  "served",
  "supported",
  "mentored",
  "organised",
  "organized",
  "planned",
  "won",
  "exceeded",
  "surpassed",
  "reached",
  "recovered",
  "cleared",
  "tested",
  "audited",
  "reconciled",
  "built",
];

// -------------------------------------------------------------- tiny helpers ---

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasDigit(text: string): boolean {
  return /\d/.test(text);
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Lowercase, punctuation-free — for comparing two facts for duplicates. */
function key(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/** A bullet or numbered list marker at the start of a line. */
const BULLET_RE = /^\s*(?:[•‣▪●○◾◦·*\-–—]|\d{1,2}[.)])\s+/;

function isBullet(line: string): boolean {
  return BULLET_RE.test(line);
}

/** A list line: a bullet, a number, or simply indented. */
function isListLine(line: Line): boolean {
  return isBullet(line.raw) || line.indented;
}

/** The line without its list marker. The quote keeps the marker; values don't. */
function stripMarker(line: string): string {
  return line.replace(BULLET_RE, "").trim();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const lower = ` ${haystack.toLowerCase()} `;
  return needles.some((needle) => lower.includes(needle));
}

function looksLikeTitle(text: string): boolean {
  return containsAny(text, TITLE_WORDS);
}

function looksLikeStudy(text: string): boolean {
  return containsAny(text, EDUCATION_WORDS);
}

// ------------------------------------------------------------------- dates ---

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const PRESENT = "(?:present|current|now|to date|ongoing|today)";
const DATE_TOKEN = `(?:${MONTH}\\.?\\s*'?\\d{2,4}|\\d{2}/\\d{4}|\\d{4}|${PRESENT})`;
const DATE_SEP = "(?:–|—|‑|-|to|until|through|till)";
const DATE_RANGE_RE = new RegExp(`\\b(${DATE_TOKEN})\\s*${DATE_SEP}\\s*(${DATE_TOKEN})\\b`, "i");
const DATE_RANGE_ALL_RE = new RegExp(
  `\\b(${DATE_TOKEN})\\s*${DATE_SEP}\\s*(${DATE_TOKEN})\\b`,
  "gi"
);
const DATE_TOKEN_RE = new RegExp(`\\b${DATE_TOKEN}\\b`, "gi");

/** Years are the one thing we accept bare, e.g. "(2024)" on a certification. */
function findYear(text: string): string {
  const match = /\b(19|20)\d{2}\b/.exec(text);
  return match?.[0] ?? "";
}

/** The first date range in a line, as `[start, end]`, or null. */
function findDateRange(text: string): [string, string] | null {
  const match = DATE_RANGE_RE.exec(text);
  if (!match?.[1] || !match[2]) return null;
  return [squash(match[1]), squash(match[2])];
}

/** Every date range in a line, so several can be removed from a heading. */
function findAllDateRanges(text: string): Array<[string, string, string]> {
  DATE_RANGE_ALL_RE.lastIndex = 0;
  const out: Array<[string, string, string]> = [];
  let match = DATE_RANGE_ALL_RE.exec(text);
  while (match) {
    out.push([squash(match[0]), squash(match[1]), squash(match[2])]);
    match = DATE_RANGE_ALL_RE.exec(text);
  }
  return out;
}

/** A lone date token, used for "one date only" headings and date-only lines. */
function findSingleDate(text: string): string {
  DATE_TOKEN_RE.lastIndex = 0;
  const match = DATE_TOKEN_RE.exec(text);
  return match ? squash(match[0]) : "";
}

/** True when a line is nothing but dates, e.g. "2018 – 2021". */
function isDateOnly(text: string): boolean {
  const stripped = squash(
    text
      .replace(DATE_RANGE_ALL_RE, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(new RegExp(`\\b${DATE_TOKEN}\\b`, "gi"), " ")
      .replace(/[()\[\]|,·•–—\-]/g, " ")
  );
  return stripped.length === 0 && hasDigit(text);
}

function removeDateRanges(text: string): string {
  let out = text;
  for (const [whole] of findAllDateRanges(text)) out = out.replace(whole, " ");
  return squash(out);
}

// ------------------------------------------------------------- the document ---

type Line = {
  /** 1-based line number in the résumé text, as the user sees it numbered. */
  number: number;
  /** The line exactly as it appears in their material, trimmed at the ends. */
  raw: string;
  /** The line with any list marker removed — what values are read from. */
  text: string;
  section: SectionKind;
  isHeading: boolean;
  /**
   * True when the line was indented in the user's text. PDF and Word exports
   * routinely lose the bullet glyph itself, which would otherwise make every
   * bullet point in the document look like a heading.
   */
  indented: boolean;
};

type ParsedDocument = {
  lines: Line[];
  sections: SectionSummary[];
  /** Notes about the read itself, shown to the user verbatim. */
  notes: string[];
};

/** Does this line look like a section heading? Returns the section it opens. */
function nameLikeLine(raw: string): boolean {
  const text = squash(raw.replace(/[|,]+$/, ""));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (text.length > 40 || hasDigit(text)) return false;
  if (EMAIL_RE.test(text) || /https?:|www\.|@/.test(text)) return false;
  if (containsAny(text, NAME_STOPWORDS) || looksLikeStudy(text) || looksLikeTitle(text)) return false;
  return words.every((word) => /^[A-Z][A-Za-z'’.-]*$/.test(word) || /^[A-Z.]+$/.test(word));
}

function headingKind(raw: string, current: SectionKind): SectionKind | null {
  const line = squash(raw.replace(/[:\s]+$/, ""));
  if (!line || line.length > 40 || wordCount(line) > 6) return null;
  if (hasDigit(line) || /[.!?]$/.test(line)) return null;
  const normalised = line.toLowerCase().replace(/[&]/g, "and").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const entry of HEADINGS) {
    if (entry.patterns.some((pattern) => pattern.test(normalised))) return entry.kind;
  }
  // An unknown ALL-CAPS line is treated as a heading, with one guard: inside a
  // list section (skills, certifications, languages) a shouted line is far more
  // likely to be content than a new section.
  const listSection = current === "skills" || current === "certifications" || current === "languages";
  const shouty = /^[A-Z][A-Z\s&/,'()-]{2,}$/.test(line) && wordCount(line) <= 3;
  // "ALEX MORGAN" at the top of a résumé is a name, not a section heading, and
  // swallowing it as an unknown heading would hide the one identity fact almost
  // every résumé states on its first line.
  if (shouty && !listSection && !nameLikeLine(line)) return "other";
  return null;
}

/**
 * Splits the résumé text into numbered lines with a section attached to each,
 * and records every heading it recognised for the "what we read" summary.
 *
 * A heading may carry its first item on the same line — "SKILLS: Figma, SQL" —
 * which is common and would otherwise hide the whole section.
 */
function parseDocument(resumeText: string): ParsedDocument {
  const rawLines = resumeText.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = [];
  const sections: SectionSummary[] = [];
  const notes: string[] = [];
  let current: SectionKind = "other";
  let seenHeading = false;
  let inlineContent: string | null = null;

  rawLines.forEach((rawLine, index) => {
    const number = index + 1;
    const raw = rawLine.replace(/\s+$/, "").replace(/^\s+/, "");
    const indented = /^\s+\S/.test(rawLine);
    if (!raw.trim()) return;

    if (inlineContent !== null) {
      const content = inlineContent;
      inlineContent = null;
      lines.push({
        number,
        raw: content,
        text: stripMarker(content),
        section: current,
        isHeading: false,
        indented: false,
      });
    }

    const colonMatch = /^([A-Za-z][A-Za-z &/]{2,40}):\s*(\S.*)$/.exec(raw);
    if (colonMatch?.[1] && colonMatch[2]) {
      const kind = headingKind(colonMatch[1], current);
      if (kind) {
        current = kind;
        seenHeading = true;
        sections.push({ kind, heading: squash(colonMatch[1]), line: number });
        const rest = colonMatch[2].trim();
        if (rest) {
          // The quote stays the whole line ("SKILLS: Figma, SQL"), because that
          // is the line the user can find in their own document.
          lines.push({
            number,
            raw,
            text: stripMarker(rest),
            section: current,
            isHeading: false,
            indented,
          });
        }
        return;
      }
    }

    const kind = headingKind(raw, current);
    if (kind) {
      current = kind;
      seenHeading = true;
      sections.push({ kind, heading: squash(raw.replace(/:$/, "")), line: number });
      return;
    }

    lines.push({ number, raw, text: stripMarker(raw), section: current, isHeading: false, indented });
  });

  if (!seenHeading && lines.length > 0) {
    notes.push(
      "Your résumé text has no section headings we recognise, so we read it line by line and only kept what each line plainly says."
    );
  }
  return { lines, sections, notes };
}

// ------------------------------------------------------------- fact building ---

function draft(
  category: FactCategory,
  label: string,
  fields: Record<string, string>,
  source: FactSource,
  quote: string,
  note = ""
): FactDraft {
  return {
    category,
    label,
    value: deriveFactValue(category, fields),
    fields,
    source,
    quote,
    note,
  };
}

function profileSource(field: string, label: string): FactSource {
  return { kind: "profile", field, label };
}

function lineSource(line: Line): FactSource {
  return { kind: "resume", line: line.number, section: line.section };
}

/** Turns drafts into stored facts: every one starts unconfirmed and unedited. */
function finish(drafts: FactDraft[], at: string): Fact[] {
  return drafts.map((item) => {
    const sourceKey =
      item.source.kind === "profile"
        ? `profile:${item.source.field}`
        : item.source.kind === "resume"
          ? `line:${item.source.line}`
          : "user";
    return {
      ...item,
      id: `${item.category}-${shortHash(`${sourceKey}|${item.value}|${item.quote}`)}`,
      status: "suggested" as const,
      origin: "extracted" as const,
      edited: false,
      createdAt: at,
      updatedAt: at,
    };
  });
}

/** Drops drafts whose display value is empty, and exact duplicates. */
function dedupe(drafts: FactDraft[]): FactDraft[] {
  const seen = new Set<string>();
  const out: FactDraft[] = [];
  for (const item of drafts) {
    if (!item.value.trim()) continue;
    const fingerprint = `${item.category}|${key(item.value)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(item);
  }
  return out;
}

// ----------------------------------------------------------------- identity ---

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s,;)]+/i;
const BARE_URL_ALL_RE = /\b((?:github|linkedin|gitlab|behance|dribbble)\.com\/[^\s,;)|]+)/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d(?:[\d\s().-]{5,}\d)/g;
const NAME_STOPWORDS = [
  "resume",
  "résumé",
  "curriculum",
  "vitae",
  "cv",
  "profile",
  "contact",
  "phone",
  "mobile",
  "email",
  "address",
  "portfolio",
  "linkedin",
  "github",
];

/** A phone number, or null. Dates are explicitly excluded — see the guard. */
function findPhone(text: string): string {
  PHONE_RE.lastIndex = 0;
  let match = PHONE_RE.exec(text);
  while (match) {
    const candidate = squash(match[0]);
    const digits = candidate.replace(/\D/g, "");
    const isYearPair = /^\d{4}\s*[-–—/]\s*\d{4}$/.test(candidate);
    const hasLetters = /[A-Za-z]/.test(candidate);
    if (!isYearPair && !hasLetters && digits.length >= 8 && digits.length <= 15) return candidate;
    match = PHONE_RE.exec(text);
  }
  return "";
}

/** The first line that reads as a person's name. Never guessed from context. */
function findName(lines: Line[]): Line | null {
  for (const line of lines.slice(0, 6)) {
    const text = line.text.trim();
    if (!text || line.isHeading || isBullet(line.raw)) continue;
    if (text.length > 60 || wordCount(text) > 5 || hasDigit(text)) continue;
    if (EMAIL_RE.test(text) || /http|www\.|@/.test(text)) continue;
    if (looksLikeStudy(text)) continue;
    if (containsAny(text, NAME_STOPWORDS)) continue;
    const words = text.split(/\s+/);
    const capitalised = words.every((word) => /^[A-Z][A-Za-z'.\-]*$/.test(word) || /^[A-Z.]+$/.test(word));
    if (capitalised && words.length >= 2) return line;
  }
  return null;
}

function identityDrafts(input: QualificationInput, doc: ParsedDocument): FactDraft[] {
  const out: FactDraft[] = [];
  const lines = doc.lines;
  const wholeText = lines.map((line) => line.raw).join("\n");

  const field = (label: string, fieldName: string, value: string, note = ""): void => {
    if (!value.trim()) return;
    out.push(
      draft(
        "identity",
        label,
        { value: squash(value) },
        profileSource(fieldName, label),
        squash(value),
        note
      )
    );
  };

  field("Name", "full_name", input.fullName);
  field("Email", "email", input.email);
  field("Phone", "phone", input.phone);
  field("Location", "location", input.location);
  field("Portfolio", "portfolio_url", input.portfolioUrl);
  field("GitHub", "github_url", input.githubUrl);
  field("LinkedIn", "linkedin_url", input.linkedinUrl);

  const have = (label: string): boolean => out.some((item) => item.label === label);

  if (!have("Email") || !have("Phone")) {
    for (const line of lines) {
      const email = !have("Email") ? EMAIL_RE.exec(line.raw)?.[0] ?? "" : "";
      const phone = !have("Phone") ? findPhone(line.raw) : "";
      if (email) {
        out.push(
          draft(
            "identity",
            "Email",
            { value: email },
            lineSource(line),
            line.raw,
            "Read from your résumé text. Check it — it is only a copy of what your material says."
          )
        );
      }
      if (phone) {
        out.push(
          draft(
            "identity",
            "Phone",
            { value: phone },
            lineSource(line),
            line.raw,
            "Read from your résumé text. Check the digits against your original file."
          )
        );
      }
    }
  }

  if (!have("Name")) {
    const nameLine = findName(lines);
    if (nameLine) {
      out.push(
        draft(
          "identity",
          "Name",
          { value: nameLine.text },
          lineSource(nameLine),
          nameLine.raw,
          "We read this from the first name-like line of your résumé text. If it is a heading or a job title instead, it is wrong — correct it in the vault."
        )
      );
    }
  }

  if (!have("GitHub") || !have("LinkedIn") || !have("Portfolio")) {
    for (const line of lines) {
      BARE_URL_ALL_RE.lastIndex = 0;
      const bare = line.raw.match(BARE_URL_ALL_RE) ?? [];
      const urls = [line.raw.match(URL_RE)?.[0] ?? "", ...bare];
      for (const url of urls.filter(Boolean)) {
        const lower = url.toLowerCase();
        const label = lower.includes("github")
          ? "GitHub"
          : lower.includes("linkedin")
            ? "LinkedIn"
            : "Portfolio";
        if (have(label)) continue;
        if (label !== "Portfolio" && !lower.includes("github") && !lower.includes("linkedin")) continue;
        if (label === "Portfolio" && (lower.includes("github") || lower.includes("linkedin"))) continue;
        out.push(
          draft(
            "identity",
            label,
            { value: url },
            lineSource(line),
            line.raw,
            ""
          )
        );
      }
    }
  }

  if (!have("Location")) {
    // Deliberately not attempted: a city line cannot be told from an employer's
    // location or a conference name, and a wrong location is worse than none.
    if (wholeText.trim()) {
      doc.notes.push(
        "We didn't read a location out of your résumé text — a city line is too easy to mistake for an employer's address, so we only use the Location field in your vault."
      );
    }
  }
  return out;
}

// -------------------------------------------------------------------- roles ---

type RoleLine = {
  line: Line;
  fields: { title: string; company: string; start: string; end: string };
  note: string;
};

const ROLE_SPLIT_RE = /\s*(?:,|;|\||·|•)\s*|\s+(?:at|@|for)\s+|\s+-\s+|\s+–\s+|\s+—\s+/i;

/** Splits "Marketing Coordinator, Northwind" into parts, without inventing. */
function splitRoleParts(text: string): string[] {
  return text
    .split(ROLE_SPLIT_RE)
    .map((part) => squash(part.replace(/^[,\-–—|]+|[,\-–—|]+$/g, "")))
    .filter(Boolean);
}

/**
 * Whether a fragment of a line reads as a job title or an employer — short, and
 * not a sentence. A bullet point whose glyph a PDF dropped is exactly what this
 * keeps out: "Owned the support-deflection model, which reduced tickets 18%" has
 * a comma in it, but it is a sentence about work, not the name of a job.
 */
const SENTENCE_WORDS = ["which", "that", "who", "whose", "was", "were", "is", "and", "the", "with", "then", "also", "into"];
function validRolePart(part: string): boolean {
  if (part.length < 2 || part.length > 80) return false;
  if (wordCount(part) > 6) return false;
  if (!/[A-Za-z]/.test(part)) return false;
  if (looksLikeStudy(part)) return false;
  if (/[.!?]$/.test(part)) return false;
  const words = part.split(/\s+/);
  if (words.some((word) => SENTENCE_WORDS.includes(word))) return false;
  return true;
}

/**
 * Reads role headings out of the résumé text.
 *
 * A role heading is only accepted when the line itself says what the role is:
 * either "Title, Company" (with an optional date range), or a dated line plus a
 * neighbouring line — and in that second case only when exactly one of the two
 * lines reads as a job title, because otherwise we would be guessing which is
 * the employer. When we cannot tell, nothing is emitted and the report says so.
 */
function roleDrafts(doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const resumeRoles: RoleLine[] = [];
  const skipped: string[] = [];
  const sectionForRoles = doc.sections.some((section) => section.kind === "experience");
  const fallback = !sectionForRoles && doc.lines.length > 0;

  doc.lines.forEach((line, index) => {
    const inRoleSection = line.section === "experience" || line.section === "projects";
    const range = findDateRange(line.text);
    if (!inRoleSection && !(fallback && range)) return;
    if (line.isHeading) return;
    if (isListLine(line) && !range) return;
    if (isDateOnly(line.text) || line.text.length > 120) return;
    if (looksLikeStudy(line.text)) return;

    const withoutDates = removeDateRanges(line.text);
    let start = range?.[0] ?? "";
    let end = range?.[1] ?? "";
    const parts = splitRoleParts(withoutDates).filter(validRolePart);

    let title = "";
    let company = "";
    let note = "";

    if (parts.length >= 2) {
      title = parts[0] ?? "";
      company = parts[1] ?? "";
      if (parts.length > 2) {
        note = `This line also says “${parts.slice(2).join(" · ")}”, which we left as it stands rather than filing it as an employer or a location.`;
      }
    } else {
      // One part only. Try the neighbouring lines, but only accept the pairing
      // when the text itself makes the roles of the two lines unambiguous.
      const single = parts[0] ?? squash(withoutDates);
      if (!single || single.length > 80) return;
      const neighbours = [doc.lines[index - 1], doc.lines[index + 1]].filter(
        (candidate): candidate is Line =>
          candidate !== undefined &&
          !candidate.isHeading &&
          !isListLine(candidate) &&
          !isDateOnly(candidate.text) &&
          candidate.text.length <= 60 &&
          wordCount(candidate.text) <= 6 &&
          !hasDigit(candidate.text) &&
          !looksLikeStudy(candidate.text) &&
          // The other line must not already be a role heading of its own.
          !findDateRange(candidate.text)
      );
      const withDates = range !== null;
      const candidates = withDates
        ? neighbours.filter((candidate) => looksLikeTitle(candidate.text) !== looksLikeTitle(single))
        : [];
      const partner = candidates[0];
      if (!partner) {
        if (range) skipped.push(squash(line.text));
        return;
      }
      if (looksLikeTitle(single)) {
        title = single;
        company = partner.text;
      } else {
        title = partner.text;
        company = single;
      }
      note =
        "Read across two lines: the job title and the employer are on separate lines of your material, and only one of them reads as a job title, so we paired them that way.";
      if (!start) {
        const other = findDateRange(partner.text);
        if (other) {
          start = other[0];
          end = other[1];
        }
      }
    }

    if (!start && !end) {
      const lone = findSingleDate(line.text);
      if (lone && !isNaN(Number(lone.slice(0, 4))) && lone.length >= 4) {
        start = lone;
        note = [
          note,
          "This heading gives one date only. We put it in the start date; we haven't assumed an end date.",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }

    if (!title && !company) return;
    resumeRoles.push({ line, fields: { title, company, start, end }, note });
  });

  // Bullet points under a role become that role's description points.
  const bulletOwner = new Map<number, string[]>();
  let owner: Line | null = null;
  const roleLineNumbers = new Set(resumeRoles.map((role) => role.line.number));
  for (const line of doc.lines) {
    if (roleLineNumbers.has(line.number)) {
      owner = line;
      continue;
    }
    if (line.isHeading) {
      owner = null;
      continue;
    }
    if (owner && isListLine(line) && (line.section === "experience" || line.section === "projects")) {
      const list = bulletOwner.get(owner.number) ?? [];
      list.push(line.text);
      bulletOwner.set(owner.number, list);
    }
  }

  const drafts: FactDraft[] = [];
  for (const role of resumeRoles) {
    const points = bulletOwner.get(role.line.number) ?? [];
    const fields = {
      title: role.fields.title,
      company: role.fields.company,
      start: role.fields.start,
      end: role.fields.end,
      description: points.join("\n"),
    };
    drafts.push(
      draft("role", "Role", fields, lineSource(role.line), role.line.raw, role.note)
    );
  }

  if (skipped.length > 0) {
    notes.push(
      `We found ${skipped.length} dated line${skipped.length === 1 ? "" : "s"} where we couldn't tell which part is the employer and which is the job title, so we left ${
        skipped.length === 1 ? "it" : "them"
      } out rather than guess: ${skipped.map((text) => `“${text}”`).join(", ")}. Add the role in the vault and it will show here.`
    );
  }
  return { drafts, notes };
}

/** Roles saved in the vault. These are quoted from the user's own fields. */
function profileRoleDrafts(
  input: QualificationInput,
  resumeRoles: FactDraft[]
): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const resumeKeys = new Set(
    resumeRoles
      .map((item) => key(`${item.fields.title} ${item.fields.company}`))
      .filter((value) => value.length > 0)
  );
  const drafts: FactDraft[] = [];
  let overlapped = 0;
  input.experience.forEach((entry, index) => {
    const fields = {
      title: entry.title.trim(),
      company: entry.company.trim(),
      start: entry.start.trim(),
      end: entry.end.trim(),
      description: entry.description.trim(),
    };
    if (!fields.title && !fields.company) return;
    const fingerprint = key(`${fields.title} ${fields.company}`);
    if (fingerprint && resumeKeys.has(fingerprint)) {
      overlapped += 1;
      return;
    }
    drafts.push(
      draft(
        "role",
        "Role",
        fields,
        profileSource(`experience.${index}`, `Experience ${index + 1} in your vault`),
        [fields.title, fields.company].filter(Boolean).join(" at ") +
          (fields.start || fields.end ? ` (${[fields.start, fields.end].filter(Boolean).join(" – ")})` : ""),
        "Saved in the vault's Experience list."
      )
    );
  });
  if (overlapped > 0) {
    notes.push(
      `${overlapped} role${overlapped === 1 ? "" : "s"} appear${overlapped === 1 ? "s" : ""} both in your vault list and in your résumé text. We're showing the version quoted from your material.`
    );
  }
  return { drafts, notes };
}

// ---------------------------------------------------------------- education ---

type EducationBlock = { lines: Line[] };

function educationBlocks(lines: Line[]): EducationBlock[] {
  const blocks: EducationBlock[] = [];
  let current: EducationBlock | null = null;
  for (const line of lines) {
    if (line.section !== "education") {
      current = null;
      continue;
    }
    if (line.isHeading) continue;
    if (isDateOnly(line.text)) {
      // A bare date line belongs to the block it sits in.
      if (current) current.lines.push(line);
      continue;
    }
    // A line that names an institution and follows a block that has no
    // institution of its own starts a new block: the common
    // "University of Melbourne / 2018 – 2021 / Bachelor of Commerce" is one
    // entry, but "Bachelor of Arts" after a completed entry is a new one.
    const startsNew = /^\s*(?:19|20)\d{2}\b/.test(line.text);
    if (!current || startsNew) {
      current = { lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks.filter((block) => block.lines.length > 0);
}

/**
 * One block (a degree, a diploma, a year of study) → one fact.
 *
 * Blocks are read segment by segment rather than line by line, because an
 * education entry is written in at least three shapes:
 *   "Bachelor of Commerce, University of Melbourne, 2015 – 2018"   (one line)
 *   "Bachelor of Commerce" / "University of Melbourne" / "2015-2018"
 *   "University of Melbourne" / "2015-2018" / "Bachelor of Commerce"
 * A segment is only ever filed as the qualification or the institution when the
 * words themselves say so; anything left over — a WAM, a major, an award —
 * becomes "anything else". A piece that carries both, or neither, is left in the
 * field it reads as and the note says what we couldn't separate.
 */
function parseEducationBlock(block: EducationBlock): FactDraft | null {
  const joined = block.lines.map((line) => line.text).join(" | ");
  const ranges = findAllDateRanges(joined);
  const dates = ranges.length > 0 ? `${ranges[0][1]} – ${ranges[0][2]}` : "";

  // Dates are cut out before splitting, so "2015 – 2018" can't be mistaken for a
  // third segment or for part of an institution's name.
  const segments = removeDateRanges(joined)
    .split(/\s*[,;|·]\s*|\s+at\s+|\s+from\s+|\s+–\s+|\s+—\s+/i)
    .map((piece) => squash(piece.replace(/^-\s*/, "")))
    .filter((piece) => piece.length > 1 && !/^\d{4}$/.test(piece));

  const qualificationSegment = segments.find((piece) => containsAny(piece, QUALIFICATION_WORDS));
  const schoolSegment = segments.find(
    (piece) => containsAny(piece, INSTITUTION_WORDS) && piece !== qualificationSegment
  );
  if (!qualificationSegment && !schoolSegment) return null;

  const qualification = qualificationSegment ?? "";
  const school = schoolSegment ?? "";

  const used = new Set([qualificationSegment, schoolSegment].filter(Boolean));
  const details = block.lines
    .filter((line) => {
      if (isDateOnly(line.text)) return false;
      const parts = removeDateRanges(line.text)
        .split(/\s*[,;|·]\s*|\s+at\s+|\s+from\s+|\s+–\s+|\s+—\s+/i)
        .map(squash)
        .filter((piece) => piece.length > 1);
      return !parts.some((piece) => used.has(piece));
    })
    .map((line) => squash(line.text))
    .join(" · ");

  const quote = block.lines.map((line) => line.raw).join("  /  ");
  const notes: string[] = [];
  if (qualification && !school) {
    notes.push(
      "We read a qualification but no institution name on these lines, so the institution is left blank rather than filled in."
    );
  }
  if (school && !qualification) {
    notes.push("We read an institution but no qualification name on these lines.");
  }
  const fields = { qualification, school, dates, details };
  if (!deriveFactValue("education", fields)) return null;
  return draft(
    "education",
    "Education",
    fields,
    lineSource(block.lines[0]!),
    quote,
    notes.join(" ")
  );
}

function educationDrafts(input: QualificationInput, doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const resumeDrafts: FactDraft[] = [];
  for (const block of educationBlocks(doc.lines)) {
    const item = parseEducationBlock(block);
    if (item) resumeDrafts.push(item);
  }
  const resumeKeys = new Set(
    resumeDrafts.flatMap((item) => [
      key(item.fields.school ?? ""),
      key(item.fields.qualification ?? ""),
    ]).filter((value) => value.length > 3)
  );
  const drafts = [...resumeDrafts];
  let overlapped = 0;
  input.education.forEach((entry, index) => {
    const fields = {
      qualification: entry.qualification.trim(),
      school: entry.school.trim(),
      dates: entry.dates.trim(),
      details: entry.details.trim(),
    };
    if (!fields.qualification && !fields.school) return;
    if (
      (fields.school && resumeKeys.has(key(fields.school))) ||
      (fields.qualification && resumeKeys.has(key(fields.qualification)))
    ) {
      overlapped += 1;
      return;
    }
    drafts.push(
      draft(
        "education",
        "Education",
        fields,
        profileSource(`education.${index}`, `Education ${index + 1} in your vault`),
        [fields.qualification, fields.school].filter(Boolean).join(", ") +
          (fields.dates ? ` (${fields.dates})` : ""),
        "Saved in the vault's Education list."
      )
    );
  });
  if (overlapped > 0) {
    notes.push(
      `${overlapped} education entr${overlapped === 1 ? "y" : "ies"} appear${overlapped === 1 ? "s" : ""} both in your vault list and in your résumé text. We're showing the version quoted from your material.`
    );
  }
  return { drafts, notes };
}

// ------------------------------------------------------------------- skills ---

const SKILL_GROUP_RE = /^([A-Za-z][A-Za-z &/+]{2,40}):\s*(\S.*)$/;
const SKILL_SPLIT_RE = /\s*[,;|·•]\s*|\s{2,}|\s+\/\s+/;

function skillItems(text: string): string[] {
  return text
    .split(SKILL_SPLIT_RE)
    .map((item) => squash(item.replace(/^[-–—*·•]\s*/, "").replace(/[.;]+$/, "")))
    .filter(Boolean);
}

function skillDrafts(doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const drafts: FactDraft[] = [];
  const skillsLines = doc.lines.filter((line) => line.section === "skills");
  if (skillsLines.length === 0) {
    if (doc.lines.length > 0) {
      notes.push(
        "Your résumé text has no skills heading, and we never lift a skill out of a sentence in the middle of a paragraph — a tool mentioned in passing is not a skill you have listed. Add a SKILLS section and we'll read it."
      );
    }
    return { drafts, notes };
  }
  for (const line of skillsLines) {
    let body = line.text;
    let groupNote = "";
    const groupMatch = SKILL_GROUP_RE.exec(line.text);
    if (groupMatch?.[1] && groupMatch[2]) {
      const label = squash(groupMatch[1]);
      const known = /^(programming|technical|tools|technologies|frameworks|languages|databases|design|software|platforms|cloud|other|core|additional|skills)/i.test(
        label
      );
      if (known && !containsAny(label, QUALIFICATION_WORDS)) {
        body = groupMatch[2];
        groupNote = `Grouped under “${label}” in your material.`;
      }
    }
    for (const item of skillItems(body)) {
      if (item.length < 2 || item.length > 40) continue;
      if (wordCount(item) > 6) continue;
      if (!/[A-Za-z]/.test(item)) continue;
      if (/[.!?]$/.test(item)) continue;
      if (findDateRange(item)) continue;
      if (looksLikeStudy(item)) continue;
      drafts.push(
        draft("skill", "Skill", { value: item }, lineSource(line), line.raw, groupNote)
      );
    }
  }
  return { drafts, notes };
}

// -------------------------------------------------------------- achievements ---

/** True when a line states a number that reads as a result. */
function achievementMetric(text: string): string {
  if (!hasDigit(text)) return "";
  const hasUnit = containsAny(text, RESULT_UNITS) || /[%$£€]/.test(text);
  const hasVerb = containsAny(text, RESULT_VERBS);
  const fromTo = /\bfrom\b[^.]{0,30}\b\d/.test(text.toLowerCase()) && /\bto\b[^.]{0,20}\d/.test(text.toLowerCase());
  if (!hasUnit && !/[%$£€]/.test(text)) return "";
  if (!hasVerb && !fromTo) return "";
  const numbers = text.match(/\d[\d,.]*\s*(?:%|x|k|m|bn)?/gi) ?? [];
  const metric = [...new Set(numbers.map((value) => squash(value).replace(/[.,;:]+$/, "")))]
    .slice(0, 4)
    .join(", ");
  return metric;
}

function achievementDrafts(doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const drafts: FactDraft[] = [];
  const allowed: SectionKind[] = ["summary", "experience", "projects", "achievements", "other"];
  let skippedUnquantified = 0;
  for (const line of doc.lines) {
    if (!allowed.includes(line.section)) continue;
    if (line.isHeading || isDateOnly(line.text)) continue;
    if (line.text.length > 240) continue;
    if (line.text.length < 12 || wordCount(line.text) < 6) continue;
    // A dated heading is a role, not a result.
    if (findDateRange(line.text) && line.text.length < 90) continue;
    const metric = achievementMetric(line.text);
    if (!metric) {
      if (hasDigit(line.text)) skippedUnquantified += 1;
      continue;
    }
    drafts.push(
      draft(
        "achievement",
        "Result",
        { value: line.text, metric },
        lineSource(line),
        line.raw,
        "Read straight from your line, with the number it states. Nothing here is calculated or estimated."
      )
    );
  }
  if (skippedUnquantified > 0) {
    notes.push(
      `${skippedUnquantified} line${skippedUnquantified === 1 ? "" : "s"} in your material mention${skippedUnquantified === 1 ? "s" : ""} a number but don't state a result we can read as one (no unit or change), so we left ${skippedUnquantified === 1 ? "it" : "them"} out. You can add ${skippedUnquantified === 1 ? "it" : "them"} yourself on this page once editing lands.`
    );
  }
  return { drafts, notes };
}

// ------------------------------------------------------------ certifications ---

function certificationDrafts(doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const drafts: FactDraft[] = [];
  const lines = doc.lines.filter((line) => line.section === "certifications");
  let previous: FactDraft | null = null;
  let previousLine: Line | null = null;

  for (const line of lines) {
    if (line.isHeading) continue;
    const text = line.text;
    if (!text) continue;
    // A line that is only a year belongs to the certification above it.
    if (/^(?:19|20)\d{2}$/.test(squash(text.replace(/[()]/g, "")))) {
      if (previous && previousLine && !previous.fields.year) {
        const year = findYear(text);
        previous.fields.year = year;
        previous.value = deriveFactValue("certification", previous.fields);
        previous.quote = `${previous.quote}  /  ${line.raw}`;
        if (year) {
          previous.note = `The year ${year} is on the next line of your material, under this certification.`;
        }
      }
      continue;
    }
    const year = findYear(text);
    const withoutYear = squash(text.replace(/[()]/g, " ").replace(/\b(?:19|20)\d{2}\b/g, " "));
    const pieces = withoutYear.includes(",") || withoutYear.includes(";")
      ? withoutYear.split(/\s*[;,]\s*/).map(squash).filter(Boolean)
      : [withoutYear];
    // Split a run-on list only when each piece plainly stands on its own.
    const splittable = pieces.every((piece) => wordCount(piece) <= 6 && piece.length <= 60);
    const items = pieces.length === 1 ? pieces : splittable ? pieces : [withoutYear];
    for (const item of items) {
      if (!item || item.length < 3 || item.length > 90) continue;
      const built = draft(
        "certification",
        "Certification",
        { value: item, year },
        lineSource(line),
        line.raw,
        year
          ? ""
          : "No year on this line — we left the year blank rather than take it from another entry."
      );
      drafts.push(built);
      previous = built;
      previousLine = line;
    }
  }
  if (lines.length === 0 && doc.lines.length > 0) {
    notes.push(
      "Your résumé text has no certifications heading, so we didn't look for certifications: we never guess one from a training provider mentioned elsewhere."
    );
  }
  return { drafts, notes };
}

// --------------------------------------------------------------- languages ---

const LEVEL_RE =
  /\b(native|bilingual|fluent|full professional|professional working|limited working|elementary|basic|intermediate|advanced|conversational|beginner|mother tongue|a1|a2|b1|b2|c1|c2|n[1-5]|hsk\s?[1-6]|ilr\s?[0-5])\b/i;

function languageDrafts(doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const drafts: FactDraft[] = [];
  const lines = doc.lines.filter((line) => line.section === "languages");
  for (const line of lines) {
    if (line.isHeading) continue;
    let body = line.text;
    const groupMatch = SKILL_GROUP_RE.exec(line.text);
    if (groupMatch?.[1] && groupMatch[2] && /^(languages|language|other languages)/i.test(squash(groupMatch[1]))) {
      body = groupMatch[2];
    }
    for (const item of skillItems(body)) {
      if (item.length < 2 || item.length > 60) continue;
      const levelMatch = LEVEL_RE.exec(item);
      const level = levelMatch ? squash(levelMatch[1]) : "";
      const value = squash(
        item
          .replace(/\([^)]*\)/g, " ")
          .split(/\s*[–—:|]\s*|\s+-\s+/)[0] ?? item
      ).replace(level ? new RegExp(`\\b${level.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : /$^/, "");
      const cleaned = squash(value.replace(/[()]/g, "").replace(/[,.;]+$/, ""));
      if (!cleaned || cleaned.length > 40 || wordCount(cleaned) > 3) continue;
      if (hasDigit(cleaned)) continue;
      if (!/[A-Za-z]/.test(cleaned)) continue;
      drafts.push(
        draft(
          "language",
          "Language",
          { value: cleaned, level },
          lineSource(line),
          line.raw,
          level ? `Level reads “${level}”, as your material states it.` : ""
        )
      );
    }
  }
  if (lines.length === 0 && doc.lines.length > 0) {
    notes.push(
      "Your résumé text has no languages heading, so no languages are listed here. Put them under a LANGUAGES heading (for example “English (native), Spanish (B2)”) and we'll read them."
    );
  }
  return { drafts, notes };
}

// -------------------------------------------------------------- work rights ---

const WORK_RIGHTS_RE =
  /\b(citizen|citizenship|permanent resident|permanent residency|work rights|working rights|work authorisation|work authorization|right to work|visa|sponsorship|sponsor|subclass\s?\d{3}|h-?1b|tier\s?[245]|green card|pr\b)\b/i;

function workRightsDrafts(input: QualificationInput, doc: ParsedDocument): { drafts: FactDraft[]; notes: string[] } {
  const notes: string[] = [];
  const drafts: FactDraft[] = [];
  if (input.workAuthorisation.trim()) {
    drafts.push(
      draft(
        "work_rights",
        "Work rights",
        { value: squash(input.workAuthorisation), note: squash(input.workAuthorisationNote) },
        profileSource("work_authorisation", "Work authorisation in your vault"),
        squash(input.workAuthorisation),
        input.workAuthorisationNote.trim()
          ? `Your own note: ${squash(input.workAuthorisationNote)}`
          : "The answer you chose in the vault."
      )
    );
  }
  const allowed: SectionKind[] = ["identity", "summary", "other", "achievements"];
  for (const line of doc.lines) {
    if (!allowed.includes(line.section)) continue;
    if (line.isHeading) continue;
    if (!WORK_RIGHTS_RE.test(line.text)) continue;
    if (line.text.length > 200 || wordCount(line.text) > 30) continue;
    drafts.push(
      draft(
        "work_rights",
        "Work rights",
        { value: line.text, note: "" },
        lineSource(line),
        line.raw,
        "Quoted from your résumé text. This is your own wording, not a legal determination — check it before it goes on any form."
      )
    );
  }
  return { drafts, notes };
}

// ------------------------------------------------------------- the extractor ---

/**
 * The whole extraction, in one deterministic pass.
 *
 * Order matters only for the report: categories come back in
 * `FACT_CATEGORY_ORDER`, and within a category in the order they were read —
 * résumé order, then vault fields, so the user can follow their own document.
 */
export function extractFacts(input: QualificationInput): {
  facts: Fact[];
  report: ExtractionReport;
} {
  const at = new Date().toISOString();
  const doc = parseDocument(input.resumeText);
  const notes: string[] = [...doc.notes];
  const resumeChars = input.resumeText.length;

  if (resumeChars === 0) {
    notes.push(
      "There's no résumé text on your profile yet, so everything below comes only from the fields you saved in the vault. Upload a résumé or paste the text and this list will grow."
    );
  } else if (resumeChars < 400) {
    notes.push(
      `Your résumé text is very short (${resumeChars.toLocaleString()} characters). That is normal when a PDF's text didn't come out cleanly. We only read what is there — nothing is filled in from elsewhere.`
    );
  }

  const identity = identityDrafts(input, doc);
  const roles = roleDrafts(doc);
  notes.push(...roles.notes);
  const profileRoles = profileRoleDrafts(input, roles.drafts);
  notes.push(...profileRoles.notes);
  const education = educationDrafts(input, doc);
  notes.push(...education.notes);
  const skills = skillDrafts(doc);
  notes.push(...skills.notes);
  const achievements = achievementDrafts(doc);
  notes.push(...achievements.notes);
  const certifications = certificationDrafts(doc);
  notes.push(...certifications.notes);
  const languages = languageDrafts(doc);
  notes.push(...languages.notes);
  const workRights = workRightsDrafts(input, doc);
  notes.push(...workRights.notes);

  const byCategory: Record<FactCategory, FactDraft[]> = {
    identity: dedupe(identity),
    role: dedupe([...roles.drafts, ...profileRoles.drafts]),
    education: dedupe(education.drafts),
    skill: dedupe(skills.drafts),
    achievement: dedupe(achievements.drafts),
    certification: dedupe(certifications.drafts),
    language: dedupe(languages.drafts),
    work_rights: dedupe(workRights.drafts),
  };

  const facts: Fact[] = [];
  for (const category of FACT_CATEGORY_ORDER) {
    facts.push(...finish(byCategory[category], at));
  }

  const counts = Object.fromEntries(
    FACT_CATEGORY_ORDER.map((category) => [category, byCategory[category].length])
  ) as Record<FactCategory, number>;

  const missing = FACT_CATEGORY_ORDER.filter((category) => counts[category] === 0).map(
    (category) => FACT_CATEGORY_COPY[category].empty
  );

  if (facts.length === 0) {
    notes.push(
      "We didn't find a single fact to show. That's not a failure on your side — it means the material we have doesn't state any of the things this page looks for. Adding a few real details to the vault is what makes it work."
    );
  }

  return {
    facts,
    report: {
      extractedAt: at,
      resumeChars,
      sections: doc.sections,
      counts,
      missing,
      notes: [...new Set(notes)],
    },
  };
}

// ---------------------------------------------------------------- persistence ---

/**
 * Bumped whenever the extractor changes in a way that would produce different
 * facts from the same material. Stored rows that predate it are recomputed on
 * the next read rather than shown stale.
 */
export const FACTS_VERSION = 1;

/** A stable fingerprint of exactly the inputs the extractor reads. */
export function inputFingerprint(input: QualificationInput): string {
  const payload = JSON.stringify([
    FACTS_VERSION,
    input.resumeText,
    input.fullName,
    input.email,
    input.phone,
    input.location,
    input.portfolioUrl,
    input.githubUrl,
    input.linkedinUrl,
    input.education,
    input.experience,
    input.workAuthorisation,
    input.workAuthorisationNote,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export type QualificationState = {
  facts: Fact[];
  report: ExtractionReport;
  computedAt: string;
  /** True when this read had to re-read the material (never stored, or changed). */
  recomputed: boolean;
};

function parseStored<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function looksLikeFacts(value: unknown): value is Fact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Fact).id === "string" &&
        typeof (item as Fact).category === "string" &&
        typeof (item as Fact).value === "string" &&
        typeof (item as Fact).quote === "string"
    )
  );
}

/**
 * The facts for this account, recomputed when the material has changed.
 *
 * The stored row carries a fingerprint of the résumé text and profile fields it
 * was read from. If the user edits their résumé — or uploads a new one — the
 * next visit sees a different fingerprint and re-reads, so this page can never
 * show facts from material that has since been replaced.
 */
export function ensureFacts(userId: string): QualificationState {
  const input = inputFromProfile(db.getProfile(userId));
  const fingerprint = inputFingerprint(input);
  const stored = db.getQualifications(userId);

  if (stored && stored.input_hash === fingerprint) {
    const facts = parseStored<unknown>(stored.facts_json, null);
    const report = parseStored<ExtractionReport | null>(stored.report_json, null);
    if (looksLikeFacts(facts) && report && Array.isArray(report.missing)) {
      return { facts, report, computedAt: stored.computed_at, recomputed: false };
    }
  }

  const { facts, report } = extractFacts(input);
  const computedAt = report.extractedAt;
  db.saveQualifications(userId, {
    factsJson: JSON.stringify(facts),
    reportJson: JSON.stringify(report),
    inputHash: fingerprint,
    computedAt,
  });
  return { facts, report, computedAt, recomputed: true };
}
