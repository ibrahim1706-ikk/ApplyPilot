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
import type { Application, Profile } from "~/db";
import type { Kit, KitAnswer, KitGap, KeywordGap, KeywordHit, KeywordMatch } from "~/types";

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

// ------------------------------------------------------------- profile mining ---

function profileCorpus(profile: Profile): string {
  const experience = profile.experience
    .map((entry) => [entry.title, entry.company, entry.start, entry.end, entry.description].join(" "))
    .join("\n");
  const education = profile.education
    .map((entry) => [entry.qualification, entry.school, entry.dates, entry.details].join(" "))
    .join("\n");
  return [
    profile.resume_text,
    experience,
    education,
    profile.work_authorisation,
    profile.work_authorisation_note,
    profile.location,
  ]
    .filter(Boolean)
    .join("\n");
}

function evidenceFor(lines: { raw: string; canon: string }[], skill: Skill): string {
  for (const line of lines) {
    if (containsKeyword(line.canon, skill.aliases)) return truncate(line.raw, 220);
  }
  return "";
}

function isCurrent(end: string): boolean {
  return /present|current|now|ongoing|today/i.test(end);
}

function dateRange(start: string, end: string): string {
  const bits = [start.trim(), end.trim()].filter(Boolean);
  if (bits.length === 0) return "";
  return bits.join("–");
}

/** Union of the year ranges in the profile's experience entries (rough estimate). */
function estimateExperienceYears(experience: Profile["experience"], currentYear: number): number {
  const intervals: [number, number][] = [];
  for (const entry of experience) {
    const years = `${entry.start} ${entry.end}`.match(/\b(19|20)\d{2}\b/g);
    if (!years || years.length === 0) continue;
    const start = Number.parseInt(years[0] ?? "", 10);
    const endRaw = years[years.length - 1] ?? "";
    const end = isCurrent(entry.end) || years.length === 1 ? currentYear : Number.parseInt(endRaw, 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) intervals.push([start, end]);
  }
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = intervals[0] ?? [0, 0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  total += end - start;
  return total;
}

// ------------------------------------------------------------------- the kit ---

export type GenerateInput = {
  profile: Profile;
  application: Pick<Application, "title" | "company" | "url" | "posting_text">;
  now?: Date;
};

export function generateKit({ profile, application, now = new Date() }: GenerateInput): Kit {
  const posting = application.posting_text ?? "";
  const corpus = profileCorpus(profile);
  const hints = readPostingHints(posting, application.url);
  const roleTitle = application.title.trim() || hints.title || "";
  const company = application.company.trim() || hints.company || "";
  const gaps: KitGap[] = [];
  const factsUsed: string[] = [];

  const currentYear = now.getFullYear();
  const experienceYears = estimateExperienceYears(profile.experience, currentYear);
  const latest = profile.experience[0] ?? null;

  // -- keyword match -----------------------------------------------------------
  // Both sides are canonicalised once, then matched whole-token: wording,
  // apostrophes, hyphens and simple plurals stop mattering, while a keyword the
  // profile genuinely doesn't evidence still shows up as a gap.
  const postingSegments = segments(posting);
  const requiredSegments = postingSegments.filter((s) => REQUIREMENT_WORDS.test(s));
  const postingCanon = canonicalHaystack(posting);
  const requiredCanon = canonicalHaystack(requiredSegments.join("\n"));
  const corpusCanon = canonicalHaystack(corpus);
  const corpusLines = segments(corpus).map((line) => ({ raw: line, canon: canonicalHaystack(line) }));

  const scored = SKILLS.map((skill) => {
    const mentions = countKeyword(postingCanon, skill.aliases);
    const required = mentions > 0 && containsKeyword(requiredCanon, skill.aliases);
    return { skill, mentions, required, score: mentions + (required ? 2 : 0) };
  })
    .filter((entry) => entry.mentions > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const evidenced: KeywordHit[] = [];
  const missing: KeywordGap[] = [];
  for (const entry of scored) {
    const evidence = evidenceFor(corpusLines, entry.skill);
    if (evidence) {
      evidenced.push({
        keyword: entry.skill.name,
        evidence,
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
  const yearsRequired = extractYearsRequirement(posting);
  if (yearsRequired !== null) {
    if (experienceYears === 0) {
      gaps.push({
        text: `The posting asks for around ${yearsRequired}+ years of experience. Your profile has no dated roles yet, so nothing there evidences it.`,
        action: "Add your roles and dates under Experience",
        where: "profile",
        hash: "experience",
      });
    } else if (experienceYears < yearsRequired) {
      gaps.push({
        text: `The posting asks for around ${yearsRequired}+ years of experience; the roles in your profile add up to roughly ${experienceYears} years, and the kit won't round that up.`,
        action: "Check your roles and dates under Experience",
        where: "profile",
        hash: "experience",
      });
    } else {
      factsUsed.push(`Experience dates add up to about ${experienceYears} years`);
    }
  }

  for (const group of QUALIFICATION_GROUPS) {
    const asked = group.askedAs.find((term) => containsKeyword(postingCanon, [term]));
    if (!asked) continue;
    if (containsKeyword(corpusCanon, group.satisfiedBy)) continue;
    gaps.push({
      text: `The posting asks for ${group.label} ("${asked}") and your profile shows nothing that satisfies it. If you have it, record it — if you don't, read that requirement carefully before applying.`,
      action: "Add your qualification under Education & qualifications",
      where: "profile",
      hash: "education",
    });
  }

  const mentionsWorkRights =
    /\b(right to work|work rights|work authorisation|work authorization|eligible to work|sponsorship|sponsor|visa)\b/i.test(
      posting
    );
  const needsSponsorship = /sponsor/i.test(profile.work_authorisation);
  if (mentionsWorkRights && !profile.work_authorisation) {
    gaps.push({
      text: "The posting asks about work rights and your profile has no work authorisation status saved. Nothing here guesses at it.",
      action: "Save your work authorisation status",
      where: "profile",
      hash: "work-authorisation",
    });
  }
  if (needsSponsorship && /sponsor/i.test(posting) && /(not|unable|no|without)\s+(?:able to\s+)?sponsor/i.test(posting)) {
    gaps.push({
      text: "The posting states it cannot sponsor, and your profile says you would need sponsorship. Read that carefully before applying.",
      action: "Review your work authorisation status",
      where: "profile",
      hash: "work-authorisation",
    });
  }

  // -- profile completeness ----------------------------------------------------
  const checks: boolean[] = [
    Boolean(profile.full_name),
    Boolean(profile.email),
    Boolean(profile.phone),
    Boolean(profile.location),
    profile.resume_text.trim().length > 40,
    profile.experience.length > 0,
    profile.education.length > 0,
    Boolean(profile.work_authorisation),
    Boolean(profile.salary_expectation),
    Boolean(profile.notice_period),
    Boolean(profile.portfolio_url || profile.github_url || profile.linkedin_url),
  ];
  const profileCompleteness = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  if (!profile.resume_text.trim()) {
    gaps.push({
      text: "Your profile has no résumé text pasted in — the kit only had your other fields to work from.",
      action: "Paste your résumé text",
      where: "profile",
      hash: "resume",
    });
  }
  if (profile.experience.length === 0) {
    gaps.push({
      text: "Your profile lists no roles yet, so nothing here can show your work history.",
      action: "Add your roles",
      where: "profile",
      hash: "experience",
    });
  }
  if (!profile.salary_expectation) {
    gaps.push({
      text: "Salary expectation: nothing saved in your profile, so the drafted answer says so rather than guessing a number.",
      action: "Save your salary expectation",
      where: "profile",
      hash: "salary",
    });
  }
  if (!profile.notice_period) {
    gaps.push({
      text: "Notice period: nothing saved in your profile, so the drafted answer says so rather than guessing.",
      action: "Save your notice period",
      where: "profile",
      hash: "notice-period",
    });
  }
  if (keywordMatch.missing.length > 0) {
    const top = keywordMatch.missing.slice(0, 8).map((entry) => entry.keyword);
    gaps.push({
      text: `Your profile doesn't mention: ${list(top)}. The posting asks for them, and the kit won't claim them for you.`,
      action: "Add the real experience to your résumé text or a role",
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
  const opening: string[] = [];
  const roleLabel = roleTitle ? roleTitle : "this role";
  const atCompany = company ? ` at ${company}` : "";
  opening.push(
    `I'd like to apply for the ${roleLabel}${atCompany}.${application.url ? ` (${application.url})` : ""}`
  );

  if (latest) {
    const dates = dateRange(latest.start, latest.end);
    const verb = isCurrent(latest.end) ? "I'm currently working as" : "My most recent role was";
    const asWhat = [latest.title, latest.company].filter(Boolean).join(" at ");
    if (asWhat) {
      opening.push(`${verb} ${asWhat}${dates ? ` (${dates})` : ""}.`);
      factsUsed.push(`Experience: ${asWhat}${dates ? ` (${dates})` : ""}`);
    }
  } else if (profile.resume_text.trim()) {
    opening.push("My background is summarised in the résumé text I've kept in my ApplyPilot profile.");
  }

  const education = profile.education[0];
  if (education && (education.qualification || education.school)) {
    const bits = [education.qualification, education.school].filter(Boolean).join(" at ");
    opening.push(`I studied ${bits}${education.dates ? ` (${education.dates})` : ""}.`);
    factsUsed.push(`Education: ${bits}`);
  }

  if (profile.location) {
    factsUsed.push(`Location: ${profile.location}`);
  }
  if (profile.full_name) factsUsed.push(`Name: ${profile.full_name}`);

  const paragraphs: string[] = [opening.join(" ")];

  const topEvidence = evidenced.slice(0, 3);
  if (topEvidence.length > 0) {
    const asked = list(topEvidence.map((entry) => entry.keyword));
    const quotes = topEvidence.map((entry) => `"${entry.evidence}"`).join(" ");
    paragraphs.push(
      `Your posting asks for ${asked}. Here's what my own background shows for those: ${quotes}`
    );
    factsUsed.push(`Matched requirements: ${asked}`);
  } else if (missing.length > 0) {
    paragraphs.push(
      `I'll be straight with you: my background doesn't yet evidence ${list(
        missing.slice(0, 3).map((entry) => entry.keyword)
      )}, so I've left those out rather than overstate what I've done.`
    );
  }

  if (mentionsWorkRights && profile.work_authorisation) {
    paragraphs.push(
      `On work rights: ${profile.work_authorisation}${profile.work_authorisation_note ? ` — ${profile.work_authorisation_note}` : ""}.`
    );
  }

  const links = [profile.portfolio_url, profile.github_url, profile.linkedin_url].filter(Boolean);
  if (links.length > 0) {
    paragraphs.push(`You can see my work and background here: ${list(links)}.`);
  }

  paragraphs.push(
    `Thank you for considering my application — I'd welcome the chance to talk through any of the above.`
  );

  const signOffLines = [profile.full_name || "[your name — add it in your profile]"];
  const contactBits = [profile.email, profile.phone, profile.location].filter(Boolean).join(" · ");
  if (contactBits) signOffLines.push(contactBits);

  const coverLetter = [
    company ? `Dear ${company} hiring team,` : "Dear Hiring Manager,",
    ...paragraphs,
    `Kind regards,\n${signOffLines.join("\n")}`,
  ].join("\n\n");

  // -- drafted answers ---------------------------------------------------------
  const answers: KitAnswer[] = [];

  const roleAnswerSources: string[] = [];
  const roleAnswer: string[] = [];
  roleAnswer.push(`${roleLabel ? `You're hiring for ${roleLabel}` : "You're hiring"}${atCompany}.`);
  if (latest) {
    const asWhat = [latest.title, latest.company].filter(Boolean).join(" at ");
    const dates = dateRange(latest.start, latest.end);
    roleAnswer.push(`I'm applying from my current position as ${asWhat}${dates ? ` (${dates})` : ""}.`);
    roleAnswerSources.push(`Profile experience: ${asWhat}`);
  }
  if (topEvidence.length > 0) {
    roleAnswer.push(
      `The parts of the posting that line up with what my profile actually records are ${list(
        topEvidence.map((entry) => entry.keyword)
      )}. For example: ${topEvidence.map((entry) => `"${entry.evidence}"`).join(" ")}`
    );
    roleAnswerSources.push("Résumé / experience text in your profile");
  }
  if (missing.length > 0) {
    const missingTop = missing.slice(0, 4).map((entry) => entry.keyword);
    roleAnswer.push(
      `Two things to be aware of before I send this: your posting also asks for ${list(missingTop)}, and my profile doesn't cover ${
        missingTop.length > 1 ? "those" : "that"
      } yet. I'd rather flag that than pad the answer.`
    );
  }
  answers.push({
    question: "Why do you want this role?",
    answer: roleAnswer.join(" "),
    sources: roleAnswerSources.length > 0 ? roleAnswerSources : ["Profile (limited data)"],
    missingInput: roleAnswerSources.length === 0,
  });

  const aboutLines: string[] = [];
  const aboutSources: string[] = [];
  aboutLines.push(profile.full_name ? `I'm ${profile.full_name}.` : "Add your name to your profile and this answer will lead with it.");
  if (profile.location) aboutLines.push(`Based in ${profile.location}.`);
  if (latest) {
    const asWhat = [latest.title, latest.company].filter(Boolean).join(" at ");
    const dates = dateRange(latest.start, latest.end);
    aboutLines.push(
      `${isCurrent(latest.end) ? "I currently work" : "I most recently worked"} as ${asWhat}${dates ? ` (${dates})` : ""}.`
    );
    aboutSources.push(`Profile experience: ${asWhat}`);
  }
  if (education && (education.qualification || education.school)) {
    aboutLines.push(
      `Before that: ${[education.qualification, education.school].filter(Boolean).join(" at ")}${
        education.dates ? ` (${education.dates})` : ""
      }.`
    );
    aboutSources.push("Profile education");
  }
  if (evidenced.length > 0) {
    const top = evidenced.slice(0, 5).map((entry) => entry.keyword);
    aboutLines.push(`The skills my profile records are ${list(top)}.`);
    aboutSources.push("Profile résumé text / role descriptions");
  }
  if (profile.resume_text.trim()) {
    const firstLine = truncate(profile.resume_text.trim(), 240);
    aboutLines.push(`Straight from my profile: "${firstLine}"`);
    aboutSources.push("Résumé text you pasted in");
  }
  if (links.length > 0) aboutLines.push(`Links: ${list(links)}.`);
  answers.push({
    question: "Tell us about yourself",
    answer: aboutLines.join(" "),
    sources: aboutSources,
    missingInput: aboutSources.length === 0,
  });

  const strength = evidenced.find((entry) => entry.required) ?? evidenced[0] ?? null;
  answers.push({
    question: "What's your greatest strength?",
    answer: strength
      ? `My strongest match to this posting is ${strength.keyword}. Where that shows up in my own profile: "${strength.evidence}" That's the experience I'd lean on for ${
          roleLabel ? `this ${roleLabel} role` : "this role"
        }.`
      : "Your profile doesn't yet record a skill that this posting asks for, so there's no strength I can point at honestly. Add more of your résumé text and role detail, then regenerate.",
    sources: strength ? [`Profile text mentioning ${strength.keyword}`] : [],
    missingInput: !strength,
  });

  answers.push({
    question: "What are your salary expectations?",
    answer: profile.salary_expectation
      ? `My expectation is ${profile.salary_expectation}. I'm happy to discuss the range for this role.`
      : "You haven't saved a salary expectation in your ApplyPilot profile, so there's no honest number to put here. Add one (Profile vault → Salary expectation) and regenerate — or answer this one yourself.",
    sources: profile.salary_expectation ? ["Profile: salary expectation"] : [],
    missingInput: !profile.salary_expectation,
  });

  answers.push({
    question: "What's your notice period?",
    answer: profile.notice_period
      ? `My notice period is ${profile.notice_period}.`
      : "You haven't saved a notice period in your ApplyPilot profile. Add it (Profile vault → Notice period) and regenerate — or answer this one yourself.",
    sources: profile.notice_period ? ["Profile: notice period"] : [],
    missingInput: !profile.notice_period,
  });

  const workAuthAnswer = profile.work_authorisation
    ? [
        `My work authorisation status: ${profile.work_authorisation}.`,
        profile.work_authorisation_note ? `Additional detail from my profile: ${profile.work_authorisation_note}.` : "",
        mentionsWorkRights ? "Your posting raises work rights or sponsorship, so this is the point to confirm with the hiring team." : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "Your profile has no work authorisation status saved. Add it (Profile vault → Work authorisation) and regenerate — this is one question you don't want an app guessing at.";
  answers.push({
    question: "What's your work authorisation / visa status?",
    answer: workAuthAnswer,
    sources: profile.work_authorisation ? ["Profile: work authorisation"] : [],
    missingInput: !profile.work_authorisation,
  });

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
    profileFactsUsed: factsUsed,
    profileCompleteness,
  };
}
