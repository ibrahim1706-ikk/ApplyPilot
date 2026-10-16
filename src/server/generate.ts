/**
 * Rules-based application-kit generation.
 *
 * Two hard product rules live in this file:
 *
 * 1. Nothing is invented. Every sentence in the cover letter and every drafted
 *    answer is assembled from the user's own profile text plus the posting.
 *    Where the posting asks for something the profile does not cover, the kit
 *    says so out loud (see `gaps`) instead of filling the hole with plausible
 *    fiction.
 * 2. No submit path. This module only produces text for the user to review,
 *    copy and send themselves.
 *
 * The MVP runs with zero API keys: keyword extraction, matching, and the
 * templates below are all deterministic. There is no model call anywhere.
 */
import type { Application } from "~/db";
import { fieldAnswersFromFacts } from "~/server/field-answers";
import type {
  AnswerFieldKey,
  Fact,
  FieldAnswer,
  Kit,
  KitAnswer,
  KitGap,
  KeywordGap,
  KeywordHit,
  KeywordMatch,
} from "~/types";

// ------------------------------------------------------------------ utilities ---

/**
 * Matching against a posting and a profile has to survive wording differences:
 * "Bachelor's degree" vs "Bachelor of Commerce", "organised" vs "organisation",
 * "detail-oriented" vs "attention to detail". Both sides are put through
 * `canonical()` before comparison, so punctuation, apostrophes, hyphens, case
 * and simple morphology stop mattering. It stays conservative: only whole
 * canonical words/phrases count, so "Java" never matches "JavaScript".
 */
function stemWord(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:sses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  return word;
}

/** Lowercase, drop apostrophes, turn punctuation into separators, stem words. */
function canonical(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2019'`\u00b4]/g, "")
    .replace(/[^a-z0-9+#/]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(stemWord)
    .join(" ");
}

/** Canonical form padded with spaces so " x " only matches whole tokens. */
function canonicalHaystack(value: string): string {
  const canonicalValue = canonical(value);
  return canonicalValue ? ` ${canonicalValue} ` : " ";
}

function countKeyword(canonHaystack: string, aliases: string[]): number {
  let total = 0;
  for (const alias of new Set(aliases.map(canonical))) {
    if (!alias) continue;
    const needle = ` ${alias} `;
    let index = canonHaystack.indexOf(needle);
    while (index !== -1) {
      total += 1;
      index = canonHaystack.indexOf(needle, index + 1);
    }
  }
  return total;
}

function containsKeyword(canonHaystack: string, aliases: string[]): boolean {
  return countKeyword(canonHaystack, aliases) > 0;
}

/** Rough sentence/line split — enough to pull quotable snippets. */
function segments(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}


function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function list(items: string[], conjunction = "and"): string {
  const unique = items.filter((item, index) => items.indexOf(item) === index);
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} ${conjunction} ${unique[unique.length - 1] ?? ""}`;
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 3 && word === word.toLowerCase() ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

// ------------------------------------------------------------------- keywords ---

type Skill = { name: string; aliases: string[] };

/**
 * Extra spellings for the skills whose wording wanders most between postings
 * and profiles — mostly soft skills and degrees. Kept deliberately short: a
 * synonym that is too loose would start claiming things the profile can't show.
 */
const SYNONYMS: Record<string, string[]> = {
  "Attention to detail": [
    "detail oriented",
    "detail-orientated",
    "eye for detail",
    "meticulous",
    "accurate",
    "accuracy",
    "thorough",
  ],
  Communication: ["communicating", "communicate", "verbal communication", "interpersonal skills"],
  "Written communication": ["writing", "report writing", "written reports", "written skills"],
  Teamwork: ["team player", "team environment", "collaborating", "collaborate"],
  Leadership: ["led a team", "leading a team", "supervising", "supervised", "line management"],
  "Problem solving": ["problem solver", "resolving issues", "resolve issues", "solution focused"],
  "Time management": ["meeting deadlines", "deadlines", "prioritising", "prioritizing", "multitasking"],
  "Organisational skills": ["organised", "organized", "organisation", "organization", "planning"],
  Adaptability: ["adaptable", "flexible", "flexibility", "fast learner"],
  "Self-motivated": ["self motivated", "initiative", "autonomy", "self-directed"],
  Mentoring: ["mentored", "mentoring", "coached", "training junior"],
  "Presentation skills": ["presented", "public speaking", "presentations"],
  "Critical thinking": ["analytical", "analytical skills", "analysis skills"],
  "Customer focus": ["client focused", "customer focused", "customer-centric"],
  "Stakeholder management": ["stakeholder engagement", "managing stakeholders"],
  "Bachelor's degree": [
    "bachelor",
    "bachelors degree",
    "bsc",
    "bsc hons",
    "bcom",
    "bachelor of",
    "undergraduate degree",
    "tertiary qualification",
  ],
  "Master's degree": [
    "master",
    "masters degree",
    "msc",
    "mba",
    "master of",
    "postgraduate degree",
    "postgraduate qualification",
  ],
};

const S = (name: string, ...aliases: string[]): Skill => ({
  name,
  aliases: [name.toLowerCase(), ...aliases, ...(SYNONYMS[name] ?? [])],
});

const SKILLS: Skill[] = [
  // languages
  S("JavaScript", "js", "es6"),
  S("TypeScript", "ts"),
  S("Python"),
  S("Java"),
  S("C++"),
  S("C#", "csharp", ".net c#"),
  S("Go", "golang"),
  S("Rust"),
  S("Ruby"),
  S("PHP"),
  S("Swift"),
  S("Kotlin"),
  S("Scala"),
  S("MATLAB"),
  S("R"),
  S("SQL", "sql queries"),
  S("Bash", "shell scripting"),
  S("HTML"),
  S("CSS"),
  // front end
  S("React", "react.js", "reactjs"),
  S("Next.js", "nextjs"),
  S("Vue", "vue.js"),
  S("Angular"),
  S("Svelte"),
  S("Redux"),
  S("Tailwind CSS", "tailwind"),
  S("SASS", "scss"),
  S("Webpack"),
  S("Vite"),
  S("Jest"),
  S("Cypress"),
  S("Playwright"),
  S("React Native"),
  S("Accessibility", "a11y", "wcag"),
  // back end / data stores
  S("Node.js", "nodejs", "node"),
  S("Express", "express.js"),
  S("NestJS"),
  S("Django"),
  S("Flask"),
  S("FastAPI"),
  S("Ruby on Rails", "rails"),
  S("Spring Boot", "spring"),
  S(".NET", "dotnet", "asp.net"),
  S("GraphQL"),
  S("REST APIs", "restful", "rest api"),
  S("gRPC"),
  S("Microservices"),
  S("PostgreSQL", "postgres"),
  S("MySQL"),
  S("SQL Server"),
  S("MongoDB"),
  S("Redis"),
  S("Elasticsearch"),
  S("Kafka"),
  S("RabbitMQ"),
  S("DynamoDB"),
  S("Prisma"),
  // cloud / devops
  S("AWS", "amazon web services"),
  S("Azure"),
  S("Google Cloud", "gcp"),
  S("Docker"),
  S("Kubernetes", "k8s"),
  S("Terraform"),
  S("CI/CD", "continuous integration", "continuous delivery"),
  S("GitHub Actions"),
  S("Jenkins"),
  S("GitLab"),
  S("Linux"),
  S("Serverless", "aws lambda"),
  S("Monitoring", "observability", "datadog", "grafana"),
  S("Git"),
  // data / ML
  S("Machine Learning", "ml models"),
  S("Deep Learning"),
  S("PyTorch"),
  S("TensorFlow"),
  S("scikit-learn", "sklearn"),
  S("pandas"),
  S("NumPy"),
  S("Spark", "pyspark"),
  S("Airflow"),
  S("dbt"),
  S("Snowflake"),
  S("BigQuery"),
  S("Redshift"),
  S("ETL", "elt"),
  S("Tableau"),
  S("Power BI"),
  S("Looker"),
  S("Excel", "advanced excel"),
  S("Google Sheets"),
  S("VBA"),
  S("Alteryx"),
  S("Statistics", "statistical analysis"),
  S("A/B testing", "ab testing", "experimentation"),
  S("NLP", "natural language processing"),
  S("LLMs", "generative ai", "large language models"),
  S("Data visualisation", "data visualization"),
  S("Data modelling", "data modeling"),
  // design
  S("Figma"),
  S("Sketch"),
  S("Adobe Creative Suite", "adobe"),
  S("Photoshop"),
  S("Illustrator"),
  S("InDesign"),
  S("Canva"),
  S("UX design", "user experience", "ux"),
  S("UI design", "user interface", "ui"),
  S("User research", "user interviews"),
  S("Prototyping", "prototypes"),
  S("Design systems"),
  S("Wireframes"),
  S("Video editing", "premiere pro", "after effects"),
  // product / project / business
  S("Product management", "product owner"),
  S("Roadmap", "roadmapping"),
  S("Stakeholder management", "stakeholders"),
  S("Agile", "scrum", "kanban"),
  S("Jira"),
  S("Confluence"),
  S("Project management"),
  S("PMP"),
  S("PRINCE2"),
  S("Business analysis", "business analyst"),
  S("Requirements gathering"),
  S("Process improvement", "lean", "six sigma"),
  S("Customer success"),
  S("Account management"),
  S("Salesforce"),
  S("HubSpot"),
  S("CRM"),
  S("SEO"),
  S("SEM", "ppc", "paid search"),
  S("Google Analytics", "ga4"),
  S("Google Ads", "adwords"),
  S("Meta Ads", "facebook ads"),
  S("Content marketing", "content strategy"),
  S("Social media management", "social media"),
  S("Email marketing", "mailchimp", "klaviyo"),
  S("Marketing automation", "marketo", "hubspot workflows"),
  S("Copywriting"),
  S("Branding", "brand strategy"),
  S("WordPress"),
  S("Shopify"),
  S("Ecommerce", "e-commerce"),
  // finance / accounting / legal / ops
  S("Financial modelling", "financial modeling"),
  S("Valuation", "dcf"),
  S("Forecasting"),
  S("Budgeting", "budget management"),
  S("Accounting", "bookkeeping"),
  S("IFRS"),
  S("GAAP"),
  S("Xero"),
  S("QuickBooks"),
  S("SAP"),
  S("Reconciliation", "reconciliations"),
  S("Audit", "external audit"),
  S("Tax", "taxation"),
  S("Risk management"),
  S("Compliance"),
  S("AML", "anti-money laundering"),
  S("KYC"),
  S("Bloomberg"),
  S("CFA"),
  S("CPA", "ca qualified", "acca"),
  S("Payroll"),
  S("Accounts payable", "accounts receivable"),
  S("Procurement"),
  S("Supply chain"),
  S("Logistics"),
  S("Inventory management"),
  S("Quality assurance", "qa testing"),
  S("Manufacturing"),
  // support / service / health / education
  S("Customer service", "customer support"),
  S("Call centre", "call center"),
  S("Zendesk"),
  S("ITIL"),
  S("Incident management"),
  S("Helpdesk", "service desk"),
  S("Troubleshooting"),
  S("Technical documentation", "documentation"),
  S("Onboarding"),
  S("Scheduling", "rostering"),
  S("Data entry"),
  S("Patient care"),
  S("Clinical", "clinical experience"),
  S("First Aid"),
  S("Nursing", "registered nurse"),
  S("Teaching", "classroom"),
  S("Curriculum development"),
  S("Research", "research skills"),
  S("Laboratory", "lab experience"),
  S("Public health"),
  S("Working with Children Check", "wwcc", "blue card"),
  S("Police check"),
  S("Security clearance", "baseline clearance", "nv1", "nv2"),
  // soft skills & ways of working
  S("Communication", "communication skills"),
  S("Written communication", "writing skills"),
  S("Teamwork", "collaboration", "collaborative"),
  S("Leadership", "leading teams"),
  S("Problem solving", "problem-solving"),
  S("Attention to detail"),
  S("Time management", "prioritisation", "prioritization"),
  S("Adaptability", "adaptable"),
  S("Mentoring", "coaching"),
  S("Critical thinking"),
  S("Organisational skills", "organizational skills"),
  S("Presentation skills", "presenting"),
  S("Negotiation"),
  S("Customer focus", "customer-centric"),
  S("Self-motivated", "self-starter", "proactive"),
  S("Fast-paced environment", "fast-paced"),
  S("Remote work", "hybrid working", "remote-first"),
  S("Cross-functional teams", "cross-functional"),
  S("Time zones", "global teams"),
  // education & credentials
  S("Bachelor's degree", "bachelor degree", "bachelors", "undergraduate degree"),
  S("Master's degree", "masters degree", "postgraduate degree"),
  S("PhD", "doctorate"),
  S("Diploma", "certificate iv", "cert iii"),
  S("Certification", "certified"),
  S("Driving licence", "driving license", "driver's licence", "driver's license"),
  S("Internship", "intern experience"),
  S("Graduate program", "graduate role"),
];

const REQUIREMENT_WORDS =
  /\b(must|must have|required|requirement|requirements|essential|minimum|at least|need to have|you have|you'll have|strong)\b/i;

/**
 * Qualification checks. Each group is one thing a posting can ask for, the
 * phrasings it might use, and the phrasings in a profile that genuinely satisfy
 * it — so "Bachelor's degree" is not flagged missing against a profile reading
 * "Bachelor of Commerce".
 */
type QualificationGroup = {
  /** How the posting might phrase the ask. */
  askedAs: string[];
  /** What in a profile honestly satisfies it. */
  satisfiedBy: string[];
  /** Plain-language label used in the nudge. */
  label: string;
};

const QUALIFICATION_GROUPS: QualificationGroup[] = [
  {
    askedAs: ["degree", "bachelor", "bachelors", "undergraduate degree", "tertiary qualification"],
    satisfiedBy: [
      "degree",
      "bachelor",
      "bsc",
      "bcom",
      "ba",
      "bs",
      "master",
      "msc",
      "mba",
      "phd",
      "doctorate",
      "diploma",
      "advanced diploma",
      "associate degree",
    ],
    label: "a degree",
  },
  {
    askedAs: ["bachelor", "bachelors", "undergraduate degree"],
    satisfiedBy: ["bachelor", "bsc", "bcom", "ba", "bs", "undergraduate"],
    label: "a bachelor's degree",
  },
  {
    askedAs: ["master", "masters", "postgraduate", "msc", "mba"],
    satisfiedBy: ["master", "msc", "mba", "postgraduate"],
    label: "a master's degree",
  },
  {
    askedAs: ["phd", "doctorate", "doctoral"],
    satisfiedBy: ["phd", "doctorate", "doctoral"],
    label: "a PhD",
  },
  {
    askedAs: ["diploma", "certificate iv", "cert iii", "certificate iii", "certificate iv"],
    satisfiedBy: ["diploma", "certificate iv", "cert iii", "certificate iii", "certificate iv", "cert 4", "cert 3"],
    label: "a diploma or certificate",
  },
  {
    askedAs: ["certification", "certified", "certification required"],
    satisfiedBy: ["certification", "certified", "certificate", "accredited", "accreditation"],
    label: "a certification",
  },
  {
    askedAs: ["driving licence", "driving license", "driver's licence", "driver's license", "full licence"],
    satisfiedBy: ["driving licence", "driving license", "driver's licence", "driver's license", "full licence"],
    label: "a driving licence",
  },
  {
    askedAs: ["cpa", "acca", "ca qualified", "chartered accountant"],
    satisfiedBy: ["cpa", "acca", "ca qualified", "chartered accountant"],
    label: "a CA/CPA qualification",
  },
  {
    askedAs: ["security clearance", "baseline clearance", "nv1", "nv2"],
    satisfiedBy: ["security clearance", "baseline clearance", "nv1", "nv2", "clearance"],
    label: "a security clearance",
  },
  {
    askedAs: ["police check", "background check", "criminal history check"],
    satisfiedBy: ["police check", "background check", "national police", "criminal history check"],
    label: "a police check",
  },
  {
    askedAs: ["working with children", "wwcc", "blue card"],
    satisfiedBy: ["working with children", "wwcc", "blue card", "wwvp"],
    label: "a working-with-children check",
  },
];


// ------------------------------------------------------------- posting parsing ---

const ATS_HOSTS: { match: RegExp; slugIndex: number; label: string }[] = [
  { match: /^boards\.greenhouse\.io$/i, slugIndex: 0, label: "Greenhouse" },
  { match: /^job-boards\.greenhouse\.io$/i, slugIndex: 0, label: "Greenhouse" },
  { match: /^jobs\.lever\.co$/i, slugIndex: 0, label: "Lever" },
  { match: /^jobs\.ashbyhq\.com$/i, slugIndex: 0, label: "Ashby" },
  { match: /^apply\.workable\.com$/i, slugIndex: 0, label: "Workable" },
  { match: /^careers\.smartrecruiters\.com$/i, slugIndex: 0, label: "SmartRecruiters" },
  { match: /^jobs\.smartrecruiters\.com$/i, slugIndex: 1, label: "SmartRecruiters" },
  { match: /\.myworkdayjobs\.com$/i, slugIndex: 0, label: "Workday" },
  { match: /^myworkdayjobs\.com$/i, slugIndex: 1, label: "Workday" },
  { match: /^www\.seek\.com\.au$/i, slugIndex: 1, label: "SEEK" },
  { match: /^www\.linkedin\.com$/i, slugIndex: 1, label: "LinkedIn" },
  { match: /^(www\.)?indeed\.[a-z.]+$/i, slugIndex: 1, label: "Indeed" },
  { match: /\.workable\.com$/i, slugIndex: 0, label: "Workable" },
  { match: /\.recruitee\.com$/i, slugIndex: 0, label: "Recruitee" },
  { match: /\.bamboohr\.com$/i, slugIndex: 0, label: "BambooHR" },
  { match: /\.jobadder\.com$/i, slugIndex: 0, label: "JobAdder" },
];

const SLUG_STOPWORDS = new Set([
  "jobs",
  "job",
  "careers",
  "career",
  "www",
  "boards",
  "board",
  "apply",
  "external",
  "en",
  "en-us",
  "en-gb",
  "job-boards",
  "view",
  "postings",
  "posting",
  "detail",
  "details",
  "opportunities",
]);

export type PostingHints = {
  title: string;
  company: string;
  ats: string;
};

/** A tail that is plainly a work mode, contract type or location, not a company. */
const NON_COMPANY_TAILS = new Set([
  "remote",
  "hybrid",
  "onsite",
  "on-site",
  "on site",
  "full time",
  "full-time",
  "part time",
  "part-time",
  "contract",
  "contractor",
  "permanent",
  "casual",
  "temporary",
  "temp",
  "fixed term",
  "fixed-term",
  "internship",
  "intern",
  "graduate",
  "junior",
  "senior",
  "mid level",
  "mid-level",
  "entry level",
  "entry-level",
  "sydney",
  "melbourne",
  "brisbane",
  "perth",
  "adelaide",
  "canberra",
  "hobart",
  "darwin",
  "gold coast",
  "auckland",
  "wellington",
  "london",
  "new york",
  "san francisco",
  "singapore",
  "dublin",
  "toronto",
  "australia",
  "new zealand",
  "united kingdom",
  "usa",
  "us",
  "uk",
  "nsw",
  "vic",
  "qld",
  "wa",
  "sa",
  "multiple locations",
  "various locations",
  "flexible",
  "anywhere",
]);

/** Words that mean the first line is prose about the job, not a heading. */
const PROSE_MARKERS =
  /\b(we|we're|our|you|you'll|your|looking for|seeking|apply|applying|join|hiring|opportunity|role is|will be|is looking)\b/i;

/** Words that mean the tail is a description of the job, not a company name. */
const NOT_A_COMPANY_WORDS = /\b(role|position|job|vacancy|opportunity|team|department|based)\b/i;

/** Words that mark a segment as a place rather than an employer. */
const PLACE_WORDS = new Set([
  "city",
  "area",
  "region",
  "office",
  "offices",
  "country",
  "campus",
  "hq",
  "headquarters",
  "metro",
  "downtown",
  "based",
]);

/** Two-or-three letter codes a posting uses for a state, province or country. */
const REGION_CODE = /^[a-z]{2,3}$/;

function isPlaceToken(word: string): boolean {
  return NON_COMPANY_TAILS.has(word) || PLACE_WORDS.has(word) || REGION_CODE.test(word);
}

/**
 * Is this segment a location or work-mode tail ("Sydney", "Remote", "Sydney, NSW",
 * "Remote (Australia)") rather than a company name? Deliberately narrow: every
 * word has to be location-words the lists above already know, so a real company
 * name is never thrown away on a hunch.
 */
function isLocationTail(value: string): boolean {
  const cleaned = value
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return false;
  if (NON_COMPANY_TAILS.has(cleaned)) return true;

  const segments = cleaned
    .split(/\s*[,/|]\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const words = segment.split(" ").filter(Boolean);
    return words.length > 0 && words.every(isPlaceToken);
  });
}

/** Would we be comfortable printing this as the company name? */
function isUsableCompany(candidate: string): boolean {
  const company = candidate.replace(/[.,;:]+$/, "").trim();
  if (company.length < 2 || company.length > 50) return false;
  if (!/^[A-Za-z0-9]/.test(company)) return false;
  if (/^\d+$/.test(company)) return false;
  if (NON_COMPANY_TAILS.has(company.toLowerCase())) return false;
  if (NOT_A_COMPANY_WORDS.test(company)) return false;
  if (PROSE_MARKERS.test(company)) return false;
  return true;
}

/**
 * Split a posting heading — "Role - Company", "Role – Company", "Role — Company",
 * "Role | Company", "Role at Company", "Role @ Company" — into role and company,
 * tolerating a trailing "(Location)" or "[Remote]" note, and a full
 * "Role - Company - Location" tail (the company is then the middle segment).
 * Returns null rather than guessing: the caller then leaves the company blank and
 * keeps its honest warning.
 */
function readHeading(line: string): { title: string; company: string } | null {
  const cleaned = line
    .replace(/^[\s*•·\-–—|]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
  if (cleaned.length < 5 || cleaned.length > 140) return null;
  if (cleaned.endsWith("?")) return null;
  if (PROSE_MARKERS.test(cleaned)) return null;

  // Drop a trailing "(Sydney)" / "[Remote]" note before splitting.
  const paren = /\s*[([{]\s*([^)\]}]{1,40})\s*[)\]}]\s*$/.exec(cleaned);
  const base = (paren ? cleaned.slice(0, paren.index) : cleaned).trim();

  const parts = base
    .split(/\s+(?:[-–—|·•]|\bat\b|@)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const build = (companyPart: string, roleParts: string[]): { title: string; company: string } | null => {
    const role = roleParts.join(" - ").trim();
    const company = companyPart.replace(/[.,;:]+$/, "").trim();
    if (!role || role.length > 90) return null;
    if (!isUsableCompany(company)) return null;
    return { title: role, company };
  };

  // "Role - Company - Location": the tail is a place or work mode, not the
  // employer, so walk back over the location tail(s) and try the first segment
  // that could be an employer. If that one doesn't look like a company either,
  // fall through to the conservative path and leave the company blank.
  const last = parts[parts.length - 1] ?? "";
  if (parts.length >= 3 && isLocationTail(last)) {
    let cut = parts.length - 1;
    while (cut >= 2 && isLocationTail(parts[cut] ?? "")) cut--;
    if (cut >= 1) {
      const headed = build(parts[cut] ?? "", parts.slice(0, cut));
      if (headed) return headed;
    }
  }

  return build(last, parts.slice(0, -1));
}

/** Best-effort role title + company from the posting text and/or its URL. */
export function readPostingHints(posting: string, url: string): PostingHints {
  let ats = "";
  let slugCompany = "";

  if (url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      const parts = parsed.pathname.split("/").filter(Boolean);
      for (const entry of ATS_HOSTS) {
        if (!entry.match.test(host)) continue;
        ats = entry.label;
        const candidate = parts[entry.slugIndex] ?? "";
        if (candidate && !SLUG_STOPWORDS.has(candidate.toLowerCase()) && !/^\d+$/.test(candidate)) {
          slugCompany = titleCaseSlug(candidate);
        }
        break;
      }
    } catch {
      // Not a parsable URL — the user can type the company in themselves.
    }
  }

  const lines = posting
    .split(/\n+/)
    .map((line) => line.replace(/^[\s*•\-–]+/, "").trim())
    .filter(Boolean);

  const labelled = (patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = pattern.exec(posting);
      if (match?.[1]) return truncate(match[1].replace(/[.,;:]+$/, ""), 90);
    }
    return "";
  };

  // Headings are the most reliable source of "which company is this?", and the
  // one a human wrote with proper wording — so it beats a URL slug.
  const heading = readHeading(lines[0] ?? "");

  let title = labelled([
    /^\s*(?:job\s+title|position|role|job|vacancy)\s*[:\-–]\s*(.+)$/im,
    /\bwe(?:'| a)re (?:looking for|seeking|hiring)\s+(?:an?\s+)?([A-Za-z0-9][A-Za-z0-9 ,/&'+-]{2,60}?)(?:\s+to\s+|\s+who\s+|\s+that\s+|[.,\n])/i,
    /\b(?:seeking|recruiting)\s+(?:an?\s+)?([A-Za-z0-9][A-Za-z0-9 ,/&'+-]{2,60}?)(?:\s+to\s+|\s+who\s+|[.,\n])/i,
  ]);

  if (!title && heading) title = heading.title;

  if (!title) {
    const first = lines[0] ?? "";
    if (
      first.length >= 4 &&
      first.length <= 70 &&
      !/[.!?]$/.test(first) &&
      !/\b(we|our|about us|company overview)\b/i.test(first)
    ) {
      title = first;
    }
  }

  let company = titleCaseSlug(
    labelled([
      /^\s*(?:company|organisation|organization|employer)\s*[:\-–]\s*(.+)$/im,
      /\bjoin\s+([A-Z][A-Za-z0-9&.'\- ]{1,40}?)(?:\s+as\s+|\s+in\s+|[.,\n])/,
    ])
  );

  if (!company && heading) company = heading.company;
  if (!company && slugCompany) company = slugCompany;

  if (!company) {
    const atMatch = /\bat\s+([A-Z][A-Za-z0-9&.'\-]*(?:\s+[A-Z][A-Za-z0-9&.'\-]*){0,3})/.exec(
      lines.slice(0, 4).join(" ")
    );
    if (atMatch?.[1]) {
      const candidate = atMatch[1].trim();
      if (!/^(least|the|our|a|an|all|any|your|this|that)\b/i.test(candidate) && candidate.length <= 40) {
        company = candidate;
      }
    }
  }

  return { title: title ?? "", company, ats };
}

function extractPostingQuestions(posting: string): string[] {
  const found: string[] = [];
  for (const line of posting.split(/\n+/)) {
    const clean = line.replace(/^[\s*•\-–\d.)]+/, "").trim();
    if (clean.length < 12 || clean.length > 220) continue;
    if (!clean.endsWith("?")) continue;
    if (!found.includes(clean)) found.push(clean);
    if (found.length >= 8) break;
  }
  return found;
}

function extractYearsRequirement(posting: string): number | null {
  const match = /(\d{1,2})\s*(?:\+|\s*plus)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*(?:years?|yrs?)\b[^.\n]{0,45}?(experience|industry|work|working)/i.exec(
    posting
  );
  if (!match?.[1]) return null;
  const years = Number.parseInt(match[1], 10);
  return Number.isFinite(years) && years > 0 && years < 40 ? years : null;
}

// --------------------------------------------------- the confirmed fact set ---
//
// Everything the kit is allowed to say about the user is here, and nowhere else.
//
// The kit used to read the raw vault and the résumé text directly (`db.getProfile`
// → `profileCorpus`), which meant a fact the user had EXCLUDED on the review screen
// was still stated in the letter, and a vault value they had never confirmed was
// quoted as settled. The kit is the artefact people copy into a real application
// form, so it now answers by the same standard as the answers screen: it is built
// from `fieldAnswersFromFacts`, from facts with `status === "confirmed"` restated
// in the user's own words, and where it would otherwise have used something else it
// says so and points at the review screen.
//
// Two invariants hold, and `scripts/kit-provenance-check.ts` fails if either breaks:
//
//   1. A fact whose status is not "confirmed" is never restated as the user's, and
//      its value never appears anywhere in the kit — not in the letter, not in a
//      drafted answer, not in a gap.
//   2. Everything the kit draws on is registered in `profileFactsUsed` by the code
//      that uses it, and nothing else is listed: the panel is exactly the facts the
//      kit drew on, no more and no less.
//
// There is deliberately no `profile` parameter. A raw profile is not something this
// module can be handed any more, so there is no path back to the leak.

/** A fact the kit drew on, named the way the panel at the bottom of the kit names it. */
type UsedFact = { id: string; label: string; value: string };

function usedFrom(source: { factId: string; factLabel: string; factValue: string }): UsedFact {
  return { id: source.factId, label: source.factLabel, value: source.factValue };
}

/** One line of the panel: the fact's own label and its own words, nothing added. */
function usedLine(fact: UsedFact): string {
  return `${fact.label}: ${fact.value}`;
}

/**
 * The state a drafted answer is in, taken from the fields it was built from: a
 * confirmed fact, material that is still unconfirmed, material the user excluded,
 * or nothing at all. The kit screen's badge reads this and nothing else.
 */
function basisOf(...answers: FieldAnswer[]): KitAnswer["basis"] {
  if (answers.some((answer) => answer.status === "answered")) return "confirmed";
  if (answers.some((answer) => answer.pending.length > 0)) return "pending";
  if (answers.some((answer) => answer.excluded.length > 0)) return "excluded";
  return "missing";
}

/** The "Drawn from:" lines for one answer: the facts behind it, named. */
function sourcesOf(answer: FieldAnswer): string[] {
  return answer.sources.map((source) => `${source.factLabel}: ${source.factValue}`);
}

/**
 * What the kit says about something it draws on but may not state. Three cases, and
 * the third is the only one where the material has nothing at all:
 *
 *  - unconfirmed — the material covers it, the user hasn't confirmed it, so it stays
 *    out and the link goes to the review screen, exactly as the answers screen does;
 *  - excluded — the user took it out on the review screen, so it stays out, and
 *    nothing is put back on their behalf;
 *  - not covered — nothing in the material covers it at all, so the kit reuses the
 *    answers engine's own nudge, which points at the exact place the detail belongs.
 *
 * Null means the field is answered: there is nothing to warn about.
 */
function wantedGap(answer: FieldAnswer, subject: string): KitGap | null {
  if (answer.status === "answered") return null;
  if (answer.pending.length > 0) {
    return {
      text: `The kit would have used ${subject}, but nothing you have confirmed covers it, so it stays out. Confirm it on the review screen and rebuild this kit.`,
      action: "Review and confirm your facts",
      where: "qualifications",
      hash: "",
    };
  }
  if (answer.excluded.length > 0) {
    return {
      text: `You excluded the fact behind ${subject} on the review screen, so the kit leaves it out — nothing is put back without you.`,
      action: "Bring it back on the review screen",
      where: "qualifications",
      hash: "",
    };
  }
  const nudge = answer.nudge;
  if (!nudge) return null;
  return { text: nudge.text, action: nudge.action, where: nudge.where, hash: nudge.hash };
}

/** The subjects the kit writes from, and what it calls each one in a gap. */
const KIT_SUBJECTS: Array<{ key: AnswerFieldKey; subject: string; always: boolean }> = [
  { key: "full_name", subject: "your name", always: false },
  { key: "email", subject: "your email address", always: false },
  { key: "phone", subject: "your phone number", always: false },
  { key: "location", subject: "where you are based", always: false },
  { key: "portfolio", subject: "your portfolio link", always: false },
  { key: "github", subject: "your GitHub link", always: false },
  { key: "linkedin", subject: "your LinkedIn link", always: false },
  // The four the kit cannot write its letter or its answers without: a gap appears
  // even when the material is silent, not only when the user hasn't confirmed it.
  { key: "current_role", subject: "your most recent role", always: true },
  { key: "education", subject: "your education", always: false },
  { key: "skills", subject: "your skills and tools", always: false },
  { key: "salary_expectation", subject: "your salary expectation", always: true },
  { key: "notice_period", subject: "your notice period", always: true },
  { key: "work_rights", subject: "your work authorisation status", always: true },
  { key: "years_experience", subject: "how many years of experience you have", always: false },
];

/** The three states a drafted answer can be in, in the kit's own words. */
type KitAnswerBasis = KitAnswer["basis"];

/**
 * One drafted answer built from the answers engine's own field answer — the same
 * value, the same "not confirmed yet" and "you excluded this" states, the same place
 * to fix it. The kit has no second opinion about any of these.
 */
function draftedFrom(
  answer: FieldAnswer,
  wording: { confirmed: (value: string) => string; subject: string; missing: string }
): { text: string; basis: KitAnswerBasis } {
  if (answer.status === "answered") return { text: wording.confirmed(answer.answer), basis: "confirmed" };
  if (answer.pending.length > 0) {
    return {
      text: `Nothing you've confirmed states ${wording.subject} yet. Your material covers it, and the kit won't state it until you confirm it on the review screen — then rebuild this kit.`,
      basis: "pending",
    };
  }
  if (answer.excluded.length > 0) {
    return {
      text: `You excluded the fact behind ${wording.subject} on the review screen, so the kit doesn't state it. Bring it back there if it should be used.`,
      basis: "excluded",
    };
  }
  return { text: wording.missing, basis: "missing" };
}

// ------------------------------------------------------------------- the kit ---

export type GenerateInput = {
  /**
   * The account's facts with the user's own decisions applied — exactly what the
   * answers screen answers from (`qualifications.ensureFacts`). There is no raw
   * profile in this input on purpose: the kit has no other view of the user.
   */
  facts: Fact[];
  application: Pick<Application, "title" | "company" | "url" | "posting_text">;
  now?: Date;
};

export function generateKit({ facts, application, now = new Date() }: GenerateInput): Kit {
  const posting = application.posting_text ?? "";
  const set = fieldAnswersFromFacts(facts);
  const confirmedFacts = facts.filter((fact) => fact.status === "confirmed");
  const nothingConfirmed = confirmedFacts.length === 0;

  const fieldAnswer = (key: AnswerFieldKey): FieldAnswer => {
    const found = set.answers.find((answer) => answer.field === key);
    if (!found) throw new Error(`the answers engine has no field ${key}`);
    return found;
  };
  const isAnswered = (key: AnswerFieldKey): boolean => fieldAnswer(key).status === "answered";
  const valueOf = (key: AnswerFieldKey): string => (isAnswered(key) ? fieldAnswer(key).answer : "");

  // -- what the kit drew on ----------------------------------------------------
  // Every use of a fact goes through `use`, which is what makes the panel at the
  // bottom of the kit screen exactly what it claims to be.
  const used: UsedFact[] = [];
  function use(source: { factId: string; factLabel: string; factValue: string }): void {
    if (!used.some((entry) => entry.id === source.factId)) used.push(usedFrom(source));
  }
  /** Registers every fact an answer was built from, and hands the answer back. */
  function useAnswer(answer: FieldAnswer): FieldAnswer {
    for (const source of answer.sources) use(source);
    return answer;
  }

  const hints = readPostingHints(posting, application.url);
  const roleTitle = application.title.trim() || hints.title || "";
  const company = application.company.trim() || hints.company || "";
  const gaps: KitGap[] = [];

  // -- keyword match, against confirmed facts only -----------------------------
  // The haystack is the confirmed facts' own text. It used to be the whole profile
  // corpus, so a posting keyword could be "evidenced" by a résumé line whose fact the
  // user had excluded — and the line was then quoted in the letter.
  const postingCanon = canonicalHaystack(posting);
  const requiredCanon = canonicalHaystack(
    segments(posting)
      .filter((s) => REQUIREMENT_WORDS.test(s))
      .join("\n")
  );
  const confirmedCanon = canonicalHaystack(confirmedFacts.map((fact) => fact.value).join("\n"));
  const factLines = confirmedFacts.map((fact) => ({ fact, canon: canonicalHaystack(fact.value) }));

  const scored = SKILLS.map((skill) => {
    const mentions = countKeyword(postingCanon, skill.aliases);
    const required = mentions > 0 && containsKeyword(requiredCanon, skill.aliases);
    return { skill, mentions, required, score: mentions + (required ? 2 : 0) };
  })
    .filter((entry) => entry.mentions > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const evidenced: KeywordHit[] = [];
  const missing: KeywordGap[] = [];
  const evidenceOwner = new Map<string, Fact>();
  for (const entry of scored) {
    const line = factLines.find((item) => containsKeyword(item.canon, entry.skill.aliases));
    if (line) {
      // The evidence is the confirmed fact's own words — the whole of them, so the
      // panel below can show the same text the kit showed.
      use({ factId: line.fact.id, factLabel: line.fact.label, factValue: line.fact.value });
      evidenceOwner.set(entry.skill.name, line.fact);
      evidenced.push({
        keyword: entry.skill.name,
        evidence: line.fact.value,
        mentions: entry.mentions,
        required: entry.required,
      });
    } else {
      missing.push({ keyword: entry.skill.name, mentions: entry.mentions, required: entry.required });
    }
  }

  const totalKeywords = evidenced.length + missing.length;
  const keywordMatch: KeywordMatch = {
    evidenced,
    missing,
    coverage: totalKeywords === 0 ? 0 : Math.round((evidenced.length / totalKeywords) * 100),
  };

  // -- posting-derived checks --------------------------------------------------
  // None of these computes anything about the user. The years check used to add up
  // their role dates; it no longer exists anywhere in this file.
  const yearsRequired = extractYearsRequirement(posting);
  if (yearsRequired !== null && !isAnswered("years_experience")) {
    const gap = wantedGap(fieldAnswer("years_experience"), "how many years of experience you have");
    if (gap) {
      gaps.push({
        ...gap,
        text: `The posting asks for around ${String(yearsRequired)}+ years of experience. ${gap.text}`,
      });
    }
  }

  // A posting requirement nothing confirmed covers. Suppressed while the user has
  // unconfirmed education facts, because the per-subject gap below already says so.
  const education = fieldAnswer("education");
  const educationUnsettled = education.pending.length > 0 || education.excluded.length > 0;
  if (!educationUnsettled) {
    for (const group of QUALIFICATION_GROUPS) {
      const asked = group.askedAs.find((term) => containsKeyword(postingCanon, [term]));
      if (!asked) continue;
      if (containsKeyword(confirmedCanon, group.satisfiedBy)) continue;
      gaps.push({
        text: `The posting asks for ${group.label} ("${asked}") and nothing you have confirmed covers it. If you have it, record it and confirm it — if you don't, read that requirement carefully before applying.`,
        action: "Add your qualification under Education & qualifications",
        where: "profile",
        hash: "education",
      });
    }
  }

  const mentionsWorkRights =
    /\b(right to work|work rights|work authorisation|work authorization|eligible to work|sponsorship|sponsor|visa)\b/i.test(
      posting
    );
  // Sponsorship is read from the answers engine's own mapping of the guaranteed
  // work-rights answer — never from a regex over the user's wording. A "Yes" here is
  // one the user's own chosen answer plainly settles.
  const sponsorship = fieldAnswer("sponsorship");
  const needsSponsorship = sponsorship.status === "answered" && sponsorship.answer.trim() === "Yes";
  if (needsSponsorship && /(not|unable|no|without)\s+(?:able to\s+)?sponsor/i.test(posting)) {
    gaps.push({
      text: "The posting states it cannot sponsor, and the work-rights answer you confirmed says you would need sponsorship. Read that carefully before applying.",
      action: "Review your work authorisation status",
      where: "profile",
      hash: "work-authorisation",
    });
  }

  // -- what the kit can and cannot write from ----------------------------------
  if (nothingConfirmed) {
    // One clear statement rather than fourteen: with nothing confirmed there is no
    // material in the kit at all, and that is the thing to say.
    gaps.push({
      text: "Nothing you have confirmed has gone into this kit. Every fact we read from your material is still waiting on the review screen — the kit writes only from facts you confirm, so there is nothing about you in it yet.",
      action: "Review and confirm your facts",
      where: "qualifications",
      hash: "",
    });
  } else {
    if (!confirmedFacts.some((fact) => fact.source.kind === "resume")) {
      gaps.push({
        text: "Nothing you have confirmed came from résumé text — the kit only had your other confirmed facts to work from.",
        action: "Add or confirm what we read from your résumé text",
        where: "profile",
        hash: "resume",
      });
    }
    for (const subject of KIT_SUBJECTS) {
      const answer = fieldAnswer(subject.key);
      if (answer.status === "answered") continue;
      const unsettled = answer.pending.length > 0 || answer.excluded.length > 0;
      if (!unsettled && !subject.always) continue;
      const gap = wantedGap(answer, subject.subject);
      if (gap) gaps.push(gap);
    }
  }

  if (missing.length > 0) {
    const top = missing.slice(0, 8).map((entry) => entry.keyword);
    gaps.push({
      text: `Nothing you have confirmed mentions: ${list(top)}. The posting asks for them, and the kit won't claim them for you.`,
      action: "Record the real experience in your résumé text or a role, then confirm it",
      where: "profile",
      hash: "resume",
    });
  }
  if (!roleTitle) {
    gaps.push({
      text: "Couldn't tell which role this posting is for — set the role title so the letter names it correctly.",
      action: "Fill in the role title",
      where: "kit",
      hash: "role-details",
    });
  }
  if (!company) {
    gaps.push({
      text: "Couldn't tell which company this posting is for — set the company name so the letter addresses it correctly.",
      action: "Fill in the company name",
      where: "kit",
      hash: "role-details",
    });
  }

  // -- cover letter ------------------------------------------------------------
  const roleLabel = roleTitle ? roleTitle : "this role";
  const atCompany = company ? ` at ${company}` : "";
  const greeting = company ? `Dear ${company} hiring team,` : "Dear Hiring Manager,";

  let coverLetter: string;
  if (nothingConfirmed) {
    coverLetter = [
      greeting,
      "[No cover letter yet: none of the facts we read from your material has been confirmed by you, and this kit writes only from facts you confirm. Review and confirm your facts, then rebuild this kit — nothing about you has been written in the meantime.]",
    ].join("\n\n");
  } else {
    const opening: string[] = [
      `I'd like to apply for the ${roleLabel}${atCompany}.${application.url ? ` (${application.url})` : ""}`,
    ];
    const role = fieldAnswer("current_role");
    if (role.status === "answered") {
      useAnswer(role);
      opening.push(`My most recent role is ${role.answer}.`);
    }
    const educationValue = valueOf("education");
    if (educationValue) {
      useAnswer(education);
      opening.push(`I studied ${educationValue}.`);
    }

    const paragraphs: string[] = [opening.join(" ")];
    const letterEvidence = evidenced.slice(0, 3);
    if (letterEvidence.length > 0) {
      const asked = list(letterEvidence.map((entry) => entry.keyword));
      const quotes = letterEvidence.map((entry) => `"${entry.evidence}"`).join(" ");
      paragraphs.push(
        `Your posting asks for ${asked}. Here's what my own confirmed facts show for those: ${quotes}`
      );
    } else if (missing.length > 0) {
      paragraphs.push(
        `I'll be straight with you: nothing I've confirmed yet evidences ${list(
          missing.slice(0, 3).map((entry) => entry.keyword)
        )}, so I've left those out rather than overstate what I've done.`
      );
    }

    if (mentionsWorkRights && isAnswered("work_rights")) {
      useAnswer(fieldAnswer("work_rights"));
      paragraphs.push(`On work rights: ${valueOf("work_rights")}.`);
    }

    const links = (["portfolio", "github", "linkedin"] as const)
      .filter((key) => isAnswered(key))
      .map((key) => {
        useAnswer(fieldAnswer(key));
        return valueOf(key);
      });
    if (links.length > 0) {
      paragraphs.push(`You can see my work and background here: ${list(links)}.`);
    }

    paragraphs.push(
      "Thank you for considering my application — I'd welcome the chance to talk through any of the above."
    );

    const signOffLines: string[] = [];
    if (isAnswered("full_name")) {
      useAnswer(fieldAnswer("full_name"));
      signOffLines.push(valueOf("full_name"));
    } else {
      signOffLines.push("[your name — add it on the review screen]");
    }
    const contactBits = (["email", "phone", "location"] as const)
      .filter((key) => isAnswered(key))
      .map((key) => {
        useAnswer(fieldAnswer(key));
        return valueOf(key);
      });
    if (contactBits.length > 0) signOffLines.push(contactBits.join(" · "));

    coverLetter = [greeting, ...paragraphs, `Kind regards,\n${signOffLines.join("\n")}`].join("\n\n");
  }

  // -- drafted answers ---------------------------------------------------------
  const answers: KitAnswer[] = [];
  const topEvidence = evidenced.slice(0, 3);
  const role = fieldAnswer("current_role");
  const pushAnswer = (
    question: string,
    text: string,
    basis: KitAnswerBasis,
    sources: string[]
  ): void => {
    answers.push({ question, answer: text, sources, missingInput: basis !== "confirmed", basis });
  };

  // 1. Why do you want this role?
  const roleAnswer: string[] = [`${roleLabel ? `You're hiring for ${roleLabel}` : "You're hiring"}${atCompany}.`];
  const roleSources: string[] = [];
  if (role.status === "answered") {
    useAnswer(role);
    roleAnswer.push(`I'm applying from my most recent role: ${role.answer}.`);
    roleSources.push(...sourcesOf(role));
  }
  if (topEvidence.length > 0) {
    roleAnswer.push(
      `The parts of the posting that line up with what I've confirmed are ${list(
        topEvidence.map((entry) => entry.keyword)
      )}. For example: ${topEvidence.map((entry) => `"${entry.evidence}"`).join(" ")}`
    );
    for (const entry of topEvidence) {
      const owner = evidenceOwner.get(entry.keyword);
      if (owner) roleSources.push(`${owner.label}: ${owner.value}`);
    }
  }
  if (missing.length > 0) {
    const missingTop = missing.slice(0, 4).map((entry) => entry.keyword);
    roleAnswer.push(
      `Two things to be aware of before I send this: your posting also asks for ${list(missingTop)}, and nothing I've confirmed covers ${
        missingTop.length > 1 ? "those" : "that"
      } yet. I'd rather flag that than pad the answer.`
    );
  }
  pushAnswer("Why do you want this role?", roleAnswer.join(" "), basisOf(role), roleSources);

  // 2. Tell us about yourself
  const aboutLines: string[] = [];
  const aboutSources: string[] = [];
  const name = fieldAnswer("full_name");
  if (name.status === "answered") {
    useAnswer(name);
    aboutLines.push(`I'm ${name.answer}.`);
    aboutSources.push(...sourcesOf(name));
  } else {
    aboutLines.push("Add your name on the review screen and this answer will lead with it.");
  }
  const location = fieldAnswer("location");
  if (location.status === "answered") {
    useAnswer(location);
    aboutLines.push(`Based in ${location.answer}.`);
    aboutSources.push(...sourcesOf(location));
  }
  if (role.status === "answered") {
    aboutLines.push(`My most recent role: ${role.answer}.`);
    aboutSources.push(...sourcesOf(role));
  }
  if (education.status === "answered") {
    useAnswer(education);
    aboutLines.push(`Education: ${education.answer}.`);
    aboutSources.push(...sourcesOf(education));
  }
  const skills = fieldAnswer("skills");
  if (skills.status === "answered") {
    useAnswer(skills);
    aboutLines.push(`The skills my confirmed facts list: ${skills.answer}.`);
    aboutSources.push(...sourcesOf(skills));
  }
  const years = fieldAnswer("years_experience");
  const yearsSource = years.sources[0];
  if (years.status === "answered" && yearsSource) {
    use(yearsSource);
    aboutLines.push(`My material states my experience as “${yearsSource.factValue}”.`);
    aboutSources.push(`${yearsSource.factLabel}: ${yearsSource.factValue}`);
  }
  const aboutLinks = (["portfolio", "github", "linkedin"] as const).filter((key) => isAnswered(key));
  if (aboutLinks.length > 0) {
    const values = aboutLinks.map((key) => {
      useAnswer(fieldAnswer(key));
      return valueOf(key);
    });
    aboutLines.push(`Links: ${list(values)}.`);
    for (const key of aboutLinks) aboutSources.push(...sourcesOf(fieldAnswer(key)));
  }
  pushAnswer(
    "Tell us about yourself",
    aboutLines.join(" "),
    basisOf(name, location, role, education, skills, years),
    aboutSources
  );

  // 3. Greatest strength
  const strength = evidenced.find((entry) => entry.required) ?? evidenced[0] ?? null;
  const strengthOwner = strength ? evidenceOwner.get(strength.keyword) : undefined;
  pushAnswer(
    "What's your greatest strength?",
    strength
      ? `My strongest match to this posting is ${strength.keyword}. Where that shows up in my own confirmed facts: "${strength.evidence}" That's the experience I'd lean on for ${
          roleLabel ? `this ${roleLabel} role` : "this role"
        }.`
      : "Nothing you have confirmed records a skill this posting asks for, so there's no strength here I can point at honestly. Confirm the facts we read from your résumé text and roles, then rebuild the kit.",
    strength ? "confirmed" : basisOf(skills),
    strengthOwner ? [`${strengthOwner.label}: ${strengthOwner.value}`] : []
  );

  // 4. Salary expectation — the answers screen's own answer for this field.
  const salary = fieldAnswer("salary_expectation");
  const salaryText = draftedFrom(salary, {
    subject: "a salary expectation",
    confirmed: (value) => `My expectation is ${value}. I'm happy to discuss the range for this role.`,
    missing:
      "You haven't saved a salary expectation in your vault, so there's no honest number to put here. Add one (Profile vault → Salary expectation), confirm it, and rebuild — or answer this one yourself.",
  });
  pushAnswer(
    "What are your salary expectations?",
    salaryText.text,
    salaryText.basis,
    salaryText.basis === "confirmed" ? sourcesOf(useAnswer(salary)) : []
  );

  // 5. Notice period
  const notice = fieldAnswer("notice_period");
  const noticeText = draftedFrom(notice, {
    subject: "a notice period",
    confirmed: (value) => `My notice period is ${value}.`,
    missing:
      "You haven't saved a notice period in your vault. Add it (Profile vault → Notice period), confirm it, and rebuild — or answer this one yourself.",
  });
  pushAnswer(
    "What's your notice period?",
    noticeText.text,
    noticeText.basis,
    noticeText.basis === "confirmed" ? sourcesOf(useAnswer(notice)) : []
  );

  // 6. Work authorisation
  const workRights = fieldAnswer("work_rights");
  const workRightsText = draftedFrom(workRights, {
    subject: "your work authorisation status",
    confirmed: (value) =>
      `My work authorisation status: ${value}.${
        mentionsWorkRights
          ? " Your posting raises work rights or sponsorship, so this is the point to confirm with the hiring team."
          : ""
      }`,
    missing:
      "Your vault has no work authorisation status saved. Add it (Profile vault → Work authorisation), confirm it, and rebuild — this is one question you don't want an app guessing at.",
  });
  pushAnswer(
    "What's your work authorisation / visa status?",
    workRightsText.text,
    workRightsText.basis,
    workRightsText.basis === "confirmed" ? sourcesOf(useAnswer(workRights)) : []
  );

  // -- how much of the kit's basis is actually in place ------------------------
  // Eleven basics, each one either covered by a fact the user confirmed or not. This
  // used to be a count over the raw vault, which said nothing about whether the kit
  // could use any of it.
  const basics: boolean[] = [
    isAnswered("full_name"),
    isAnswered("email"),
    isAnswered("phone"),
    isAnswered("location"),
    confirmedFacts.some((fact) => fact.source.kind === "resume"),
    isAnswered("current_role"),
    isAnswered("education"),
    isAnswered("work_rights"),
    isAnswered("salary_expectation"),
    isAnswered("notice_period"),
    isAnswered("portfolio") || isAnswered("github") || isAnswered("linkedin"),
  ];
  const profileCompleteness = Math.round((basics.filter(Boolean).length / basics.length) * 100);

  return {
    generatedAt: now.toISOString(),
    generator: "rules",
    roleTitle: roleLabel === "this role" ? "" : roleLabel,
    company,
    postingUrl: application.url,
    coverLetter,
    answers,
    keywordMatch,
    gaps,
    postingQuestions: extractPostingQuestions(posting),
    profileFactsUsed: used.map(usedLine),
    profileCompleteness,
    factBasis: {
      confirmed: confirmedFacts.length,
      pending: facts.filter((fact) => fact.status === "suggested").length,
      excluded: facts.filter((fact) => fact.status === "excluded").length,
      factsInSet: facts.length,
      nothingConfirmed,
    },
  };
}
