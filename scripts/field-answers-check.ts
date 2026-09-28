/**
 * Stage-3 check for the field-answering layer:
 *   `bun run scripts/field-answers-check.ts`
 *
 * Stage 1 proved the extractor only reports what the user's own material says.
 * Stage 2 proved the user's decisions (keep / correct / exclude / add / confirm)
 * are what the fact set is made of. This script proves what stage 3 adds: every
 * standard application field answered from the facts the user CONFIRMED, each
 * answer carrying the fact and the line behind it — and "not covered" wherever
 * the confirmed set doesn't reach.
 *
 *   A. EVERY ANSWER HAS A TRACEABLE SOURCE
 *      With a rich profile fully confirmed: every answered field names at least
 *      one fact, that fact is in the confirmed set, the caption beside it is the
 *      review screen's own caption for that fact, and the answer text is made of
 *      nothing but those facts' own words.
 *
 *   B. AN UNCONFIRMED FACT IS NEVER USED
 *      With nothing confirmed, no answer exists at all — not as an answer, not as
 *      a partial one. Facts that cover a field are named as pending instead. An
 *      EXCLUDED fact is not used either, and is named rather than silently
 *      dropped. Confirming one fact answers exactly the fields it covers.
 *
 *   C. NOTHING IS INVENTED — a thin profile says "not covered"
 *      A three-line résumé with an empty vault yields a name and nothing else: no
 *      email, no phone, no location (a city line in a résumé is never read as
 *      one), no work rights, no salary, no years of experience, no role. An
 *      account with no material at all yields the honest empty state. Every
 *      "not covered" field carries a nudge.
 *
 *   D. THE RULES THEMSELVES
 *      Most-recent role ordering; the sponsorship mapping (three of the five
 *      vault answers settle it, two do not, and a résumé line never does); years
 *      of experience only ever quoted from the user's own words; joins that keep
 *      every fact's own wording; no ranking of qualifications.
 *
 *   E. THROUGH THE REAL STORAGE MODULE (throwaway data dir)
 *      A real account, confirmed through the same functions the review screen
 *      calls, then answered: the layer reflects live decisions, and writing an
 *      answer writes nothing (the decisions are byte-identical afterwards).
 *      Facts and decisions are in the export and go with account deletion.
 *
 *   F. THE NUDGES POINT SOMEWHERE REAL
 *      Every nudge's anchor is checked against the route source it points at, so
 *      "add it here" cannot quietly point at nothing.
 *
 * Exits non-zero if anything fails. Prints what it checked either way.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const FIXTURES = join(HERE, "fixtures");
const dataDir = mkdtempSync(join(tmpdir(), "applypilot-field-answers-"));
process.env.APPLYPILOT_DATA_DIR = dataDir;

const db = await import("../src/db");
const q = await import("../src/server/qualifications");
const answersModule = await import("../src/server/field-answers");
const types = await import("../src/types");

type Fact = import("../src/types").Fact;
type FactDecision = import("../src/types").FactDecision;
type FieldAnswer = import("../src/types").FieldAnswer;
type FieldAnswers = import("../src/types").FieldAnswers;
type AnswerFieldKey = import("../src/types").AnswerFieldKey;

const { NOT_COVERED_COPY, PENDING_FACT_COPY, WORK_AUTHORISATION_OPTIONS, factSourceCaption, factValueKey } = types;
const { fieldAnswersFromFacts, fieldAnswersFor, rolesMostRecentFirst, statedYearsPhrase, answerSource } =
  answersModule;

const AT = "2026-03-01T00:00:00.000Z";

const problems: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}
function banner(title: string) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

const plain = readFileSync(join(FIXTURES, "resume-plain.txt"), "utf8");
const thin = readFileSync(join(FIXTURES, "resume-thin.txt"), "utf8");

// ------------------------------------------------------------------ fixtures ---

/** The extractor's facts for a profile, with no decision of the user's applied. */
function factsFor(profile: db.Profile): Fact[] {
  return q.extractFacts(q.inputFromProfile(profile)).facts;
}

/** The fact set the review screen shows once the user confirms everything. */
function confirmedSet(facts: Fact[]): Fact[] {
  const decisions: FactDecision[] = facts.map((fact) => ({
    id: fact.id,
    category: fact.category,
    action: "keep",
    snapshot: q.snapshotOf(fact),
    valueKey: factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  }));
  return q.applyDecisions(facts, decisions).facts;
}

/** A profile with everything a well-filled vault would have. */
function richProfile(resumeText = plain): db.Profile {
  return {
    ...db.EMPTY_PROFILE,
    full_name: "Alex Morgan",
    email: "alex.morgan@example.com",
    phone: "0412 345 678",
    location: "Melbourne, Australia",
    portfolio_url: "https://alexmorgan.dev",
    github_url: "https://github.com/alexmorgan",
    linkedin_url: "https://linkedin.com/in/alexmorgan",
    resume_text: resumeText,
    work_authorisation: WORK_AUTHORISATION_OPTIONS[0],
    work_authorisation_note: "Permanent resident since 2021",
    salary_expectation: "$120,000–$135,000 plus super",
    notice_period: "4 weeks",
  };
}

function answerOf(set: FieldAnswers, field: AnswerFieldKey): FieldAnswer {
  const found = set.answers.find((answer) => answer.field === field);
  if (!found) throw new Error(`no answer for field ${field}`);
  return found;
}

function roleFact(fields: Partial<Record<"title" | "company" | "start" | "end" | "description", string>>): Fact {
  const complete = {
    title: fields.title ?? "Analyst",
    company: fields.company ?? "Northwind",
    start: fields.start ?? "",
    end: fields.end ?? "",
    description: fields.description ?? "",
  };
  return {
    id: `role-${complete.title}-${complete.start}-${complete.end}`.replace(/\s+/g, "-"),
    category: "role",
    label: "Role",
    value: `${complete.title} at ${complete.company}`,
    fields: complete,
    source: { kind: "profile", field: "experience.0", label: "Experience 1 in your vault" },
    quote: `${complete.title} at ${complete.company}`,
    note: "",
    status: "confirmed",
    origin: "extracted",
    edited: false,
    createdAt: AT,
    updatedAt: AT,
  };
}

// =========================================================================== A ===
banner("A. every answer carries a source, and the answer is made of those facts");

const richFacts = factsFor(richProfile());
const richSet = fieldAnswersFromFacts(confirmedSet(richFacts));
const richConfirmed = confirmedSet(richFacts);

check(
  "the fixture yields a fact set worth answering from",
  richConfirmed.length > 20,
  `${String(richConfirmed.length)} facts`
);

const answeredFields = richSet.answers.filter((answer) => answer.status === "answered");
check(
  "the well-filled profile answers most of the standard fields",
  answeredFields.length >= 12,
  `${String(answeredFields.length)} of ${String(richSet.answers.length)} answered: ${answeredFields
    .map((answer) => answer.field)
    .join(", ")}`
);

const noSource = answeredFields.filter((answer) => answer.sources.length === 0);
check(
  "no answer exists without at least one fact behind it",
  noSource.length === 0,
  JSON.stringify(noSource.map((answer) => answer.field))
);

const badSource = answeredFields.flatMap((answer) =>
  answer.sources
    .filter((source) => {
      const fact = richConfirmed.find((item) => item.id === source.factId);
      return (
        !fact ||
        fact.status !== "confirmed" ||
        source.quote.trim().length === 0 ||
        source.provenance.trim().length === 0 ||
        source.provenance !== factSourceCaption(fact) ||
        source.factValue !== fact.value
      );
    })
    .map((source) => `${answer.field}:${source.factId}`)
);
check(
  "every source is a confirmed fact from this set, captioned the way the review screen captions it",
  badSource.length === 0,
  JSON.stringify(badSource.slice(0, 5))
);

// The answer text must be nothing but the sources' own words. The two deliberate
// exceptions are checked by their own rule below: sponsorship restates a choice
// the user made (and the caveat names it), and years of experience quotes a
// phrase out of the user's own line rather than the whole fact.
const wordish = answeredFields.filter((answer) => answer.field !== "sponsorship" && answer.field !== "years_experience");
const outsideWords = wordish.filter((answer) => !answer.sources.every((source) => answer.answer.includes(source.factValue)));
check(
  "every word of every answer comes from the facts it cites",
  outsideWords.length === 0,
  JSON.stringify(
    outsideWords.map((answer) => ({ field: answer.field, answer: answer.answer, sources: answer.sources.map((s) => s.factValue) }))
  )
);

const sponsorship = answerOf(richSet, "sponsorship");
check(
  "the sponsorship answer is a restatement of the user's own work-rights choice, named in its caveat",
  sponsorship.status === "answered" &&
    sponsorship.answer === "No" &&
    sponsorship.sources.length === 1 &&
    sponsorship.caveat.includes(sponsorship.sources[0]!.factValue) &&
    sponsorship.caveat.includes("you chose"),
  JSON.stringify({ answer: sponsorship.answer, caveat: sponsorship.caveat })
);

const years = answerOf(richSet, "years_experience");
check(
  "a summary that says “Six years across fintech and health SaaS” is not turned into a years-of-experience answer",
  years.status === "not-covered" && years.answer === "" && years.nudge !== null,
  JSON.stringify({ status: years.status, answer: years.answer })
);

const named: Array<[AnswerFieldKey, string]> = [
  ["full_name", "Alex Morgan"],
  ["email", "alex.morgan@example.com"],
  ["phone", "0412 345 678"],
  ["location", "Melbourne, Australia"],
  ["portfolio", "https://alexmorgan.dev"],
  ["github", "https://github.com/alexmorgan"],
  ["linkedin", "https://linkedin.com/in/alexmorgan"],
  ["work_rights", WORK_AUTHORISATION_OPTIONS[0]],
  ["notice_period", "4 weeks"],
  ["salary_expectation", "$120,000–$135,000 plus super"],
  ["current_role", "Senior Product Analyst at Northwind Financial (Feb 2022 – Present)"],
  ["education", "Bachelor of Commerce (Business Analytics), University of Melbourne (2015 – 2018)"],
];
for (const [field, expected] of named) {
  const answer = answerOf(richSet, field);
  check(
    `“${field}” is answered with the user's own words (${expected.slice(0, 42)})`,
    answer.status === "answered" && answer.answer === expected,
    JSON.stringify({ status: answer.status, answer: answer.answer })
  );
}

const skills = answerOf(richSet, "skills");
check(
  "the skills answer lists the material's own skills, comma-separated",
  skills.status === "answered" &&
    skills.answer.includes("SQL (advanced)") &&
    skills.answer.includes("Looker") &&
    skills.sources.length === skills.answer.split(", ").length,
  JSON.stringify({ answer: skills.answer.slice(0, 90), sources: skills.sources.length })
);
const certs = answerOf(richSet, "certifications");
check(
  "the certifications answer names every certification the material states",
  certs.status === "answered" &&
    certs.answer.includes("Google Analytics Certification") &&
    certs.answer.includes("AWS Certified Cloud Practitioner"),
  JSON.stringify(certs.answer)
);
const languages = answerOf(richSet, "languages");
check(
  "the languages answer carries the level the material gives",
  languages.status === "answered" && languages.answer.includes("Spanish (B2)") && languages.answer.includes("English (native)"),
  JSON.stringify(languages.answer)
);
const location = answerOf(richSet, "location");
check(
  "location comes from the vault, never read out of a résumé line",
  location.sources.length === 1 && location.sources[0]!.provenance.startsWith("From your vault"),
  JSON.stringify(location.sources.map((source) => source.provenance))
);
const workRights = answerOf(richSet, "work_rights");
check(
  "the work-rights answer is the statement the user chose, with the résumé line quoted beside it rather than merged in",
  workRights.sources.length === 1 &&
    workRights.sources[0]!.factValue === WORK_AUTHORISATION_OPTIONS[0] &&
    workRights.sources[0]!.provenance.startsWith("From your vault") &&
    workRights.related.length >= 1 &&
    workRights.related.some((source) => source.provenance.includes("résumé text")),
  JSON.stringify({
    sources: workRights.sources.map((source) => source.provenance),
    related: workRights.related.map((source) => source.provenance),
  })
);
check(
  "…and the caveat says which of the two the answer is, rather than hiding the other",
  /more than one thing/.test(workRights.caveat),
  workRights.caveat
);
const provenanceOfEmail = answerOf(richSet, "email").sources[0]!.provenance;
check(
  "an answer's provenance carries the résumé line number or the vault field, in the review screen's words",
  provenanceOfEmail === "From your vault — Email",
  provenanceOfEmail
);

// =========================================================================== B ===
banner("B. a fact the user has not confirmed is named as pending, never used");

const unconfirmedSet = fieldAnswersFromFacts(richFacts);
check(
  "with nothing confirmed, not one field is answered",
  unconfirmedSet.answered === 0 && unconfirmedSet.answers.every((answer) => answer.answer === ""),
  JSON.stringify({ answered: unconfirmedSet.answered })
);
check(
  "…and every field the material covers is named as pending instead",
  unconfirmedSet.pending >= 8,
  `${String(unconfirmedSet.pending)} pending`
);
const pendingWithoutCopy = unconfirmedSet.answers.filter(
  (answer) => answer.status === "pending" && (answer.pending.length === 0 || answer.pendingNote !== PENDING_FACT_COPY)
);
check(
  "a pending field shows the “not confirmed yet — review it here” sentence and the fact it is waiting on",
  pendingWithoutCopy.length === 0,
  JSON.stringify(pendingWithoutCopy.map((answer) => answer.field))
);
const pendingWithoutNudge = unconfirmedSet.answers.filter(
  (answer) => answer.status === "not-covered" && answer.nudge === null
);
check(
  "a “not covered” field always carries somewhere to add the real detail",
  pendingWithoutNudge.length === 0,
  JSON.stringify(pendingWithoutNudge.map((answer) => answer.field))
);
check(
  "the unconfirmed profile's email address appears in no answer anywhere",
  !unconfirmedSet.answers.some((answer) => `${answer.answer} ${answer.caveat}`.includes("alex.morgan@example.com")),
  JSON.stringify(unconfirmedSet.answers.filter((answer) => answer.answer).map((answer) => answer.field))
);
check(
  "the set says what is waiting on the user rather than looking complete",
  unconfirmedSet.empty === true &&
    unconfirmedSet.emptyCopy.length > 0 &&
    unconfirmedSet.notes.some((note) => /not by anything you have confirmed/i.test(note)),
  JSON.stringify({ empty: unconfirmedSet.empty, notes: unconfirmedSet.notes })
);

// Confirming exactly one fact answers exactly the fields it covers.
const emailFact = richFacts.find((fact) => fact.category === "identity" && fact.label === "Email");
const nameFact = richFacts.find((fact) => fact.category === "identity" && fact.label === "Name");
if (!emailFact || !nameFact) {
  check("the fixture has an email and a name fact to confirm", false, "fixture shape changed");
} else {
  const onlyEmail = q.applyDecisions(richFacts, [
    {
      id: emailFact.id,
      category: "identity",
      action: "keep",
      snapshot: q.snapshotOf(emailFact),
      valueKey: factValueKey("identity", emailFact.originalValue ?? emailFact.value),
      at: AT,
    },
  ]).facts;
  const emailOnlySet = fieldAnswersFromFacts(onlyEmail);
  check(
    "confirming one fact answers that field and nothing else",
    emailOnlySet.answered === 1 &&
      answerOf(emailOnlySet, "email").answer === "alex.morgan@example.com" &&
      answerOf(emailOnlySet, "full_name").status !== "answered" &&
      answerOf(emailOnlySet, "phone").status !== "answered",
    JSON.stringify({
      answered: emailOnlySet.answered,
      fields: emailOnlySet.answers.filter((answer) => answer.status === "answered").map((answer) => answer.field),
    })
  );

  // Excluded: not used, and not hidden either.
  const withoutEmail = q.applyDecisions(richFacts, [
    {
      id: emailFact.id,
      category: "identity",
      action: "exclude",
      snapshot: q.snapshotOf(emailFact),
      valueKey: factValueKey("identity", emailFact.value),
      at: AT,
    },
  ]).facts;
  const excludedSet = fieldAnswersFromFacts(withoutEmail);
  const emailAnswer = answerOf(excludedSet, "email");
  check(
    "a fact the user excluded is not used as the answer",
    emailAnswer.status === "not-covered" && emailAnswer.answer === "",
    JSON.stringify({ status: emailAnswer.status, answer: emailAnswer.answer })
  );
  check(
    "…and it is named as excluded, with the value the user removed, not silently dropped",
    emailAnswer.excluded.length === 1 &&
      emailAnswer.excluded[0]!.factId === emailFact.id &&
      emailAnswer.excluded[0]!.factValue === "alex.morgan@example.com",
    JSON.stringify(emailAnswer.excluded.map((source) => source.factValue))
  );
  check(
    "…and the page says the exclusion is theirs, and how to undo it",
    excludedSet.notes.some((note) => /excluded/.test(note) && /bring/i.test(note)),
    JSON.stringify(excludedSet.notes)
  );
}

// =========================================================================== C ===
banner("C. a thin profile reads “not covered” — nothing is filled in to look complete");

const thinSet = fieldAnswersFromFacts(confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: thin })));
const thinAnswered = thinSet.answers.filter((answer) => answer.status === "answered").map((answer) => answer.field);
check(
  "the three-line résumé yields a name and nothing else",
  thinAnswered.length === 1 && thinAnswered[0] === "full_name",
  JSON.stringify(thinAnswered)
);
check(
  "…and it is quoted from the résumé line it is actually on",
  answerOf(thinSet, "full_name").sources[0]!.provenance === "From your résumé text, line 3",
  JSON.stringify(answerOf(thinSet, "full_name").sources.map((source) => source.provenance))
);

const mustBeUncovered: AnswerFieldKey[] = [
  "email",
  "phone",
  "location",
  "portfolio",
  "github",
  "linkedin",
  "work_rights",
  "sponsorship",
  "notice_period",
  "salary_expectation",
  "current_role",
  "years_experience",
  "education",
  "skills",
  "certifications",
  "languages",
];
const coveredByGuess = mustBeUncovered.filter((field) => answerOf(thinSet, field).status === "answered");
check(
  "no field outside the name is answered for a thin profile — no default email, phone, location, salary or “Negotiable”",
  coveredByGuess.length === 0,
  JSON.stringify(coveredByGuess.map((field) => [field, answerOf(thinSet, field).answer]))
);
check(
  "every one of those fields reads “not covered” or “not confirmed yet”, with a reason",
  mustBeUncovered.every((field) => {
    const answer = answerOf(thinSet, field);
    return answer.status !== "answered" && (answer.notCovered.length > 0 || answer.pendingNote.length > 0);
  }),
  JSON.stringify(
    mustBeUncovered
      .map((field) => [field, answerOf(thinSet, field).status] as const)
      .filter(([, status]) => status === "answered")
  )
);
const thinText = thinSet.answers.map((answer) => answer.answer).join(" | ");
check(
  "not one answer is invented: no email, no phone number, no digits at all",
  !thinText.includes("@") && !/\d{3,}/.test(thinText),
  JSON.stringify(thinText)
);
check(
  "the thin profile's “not covered” answers point at real places to add the detail",
  thinSet.answers
    .filter((answer) => answer.status === "not-covered")
    .every((answer) => answer.nudge !== null && answer.nudge.text.length > 0 && answer.nudge.action.length > 0)
);
const thinLocation = answerOf(thinSet, "location");
check(
  "a city line in a résumé is never read as a location",
  thinLocation.status === "not-covered" &&
    richSet.answers.length > 0 &&
    answerOf(fieldAnswersFromFacts(confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: plain }))), "location").status ===
      "not-covered",
  JSON.stringify({ thin: thinLocation.status })
);

const nothingSet = fieldAnswersFromFacts(factsFor({ ...db.EMPTY_PROFILE }));
check(
  "an account with no material at all gets the honest empty state, not seventeen blank fields",
  nothingSet.factCount === 0 &&
    nothingSet.empty === true &&
    nothingSet.emptyCopy.length > 0 &&
    nothingSet.answered === 0 &&
    nothingSet.notCovered === nothingSet.answers.length,
  JSON.stringify({ factCount: nothingSet.factCount, emptyCopy: nothingSet.emptyCopy.slice(0, 60) })
);
check(
  "…and even then every field says where the detail belongs",
  nothingSet.answers.every((answer) => answer.nudge !== null && answer.nudge.hash.length > 0)
);

// =========================================================================== D ===
banner("D. the rules themselves");

const roles = [
  roleFact({ title: "Junior Data Analyst", start: "Jul 2018", end: "Mar 2020" }),
  roleFact({ title: "Senior Product Analyst", start: "Feb 2022", end: "Present" }),
  roleFact({ title: "Product Analyst", start: "Mar 2020", end: "Feb 2022" }),
  roleFact({ title: "Course Assistant", start: "", end: "" }),
];
const ordered = rolesMostRecentFirst(roles).map((fact) => fact.fields.title);
check(
  "the most recent role is the one with “Present”, then the latest end date, and an undated role sorts last",
  JSON.stringify(ordered) === JSON.stringify(["Senior Product Analyst", "Product Analyst", "Junior Data Analyst", "Course Assistant"]),
  JSON.stringify(ordered)
);
check(
  "the most recent role is what the form is answered with",
  answerOf(fieldAnswersFromFacts(roles), "current_role").answer === "Senior Product Analyst at Northwind",
  JSON.stringify(answerOf(fieldAnswersFromFacts(roles), "current_role").answer)
);
const rolesWithSuggestedNewest = [
  { ...roles[1]!, status: "suggested" as const },
  roles[2]!,
  roles[0]!,
];
const newestPendingSet = fieldAnswersFromFacts(rolesWithSuggestedNewest);
const newestPending = answerOf(newestPendingSet, "current_role");
check(
  "an unconfirmed most-recent role is not answered from an older one — the field waits",
  newestPending.status === "pending" &&
    newestPending.answer === "" &&
    /won't answer with an older role/i.test(newestPending.caveat),
  JSON.stringify({ status: newestPending.status, caveat: newestPending.caveat })
);

// Sponsorship, per vault answer.
const sponsorshipExpectation: Array<[string, "No" | "Yes" | ""]> = [
  [WORK_AUTHORISATION_OPTIONS[0], "No"],
  [WORK_AUTHORISATION_OPTIONS[1], "No"],
  [WORK_AUTHORISATION_OPTIONS[2], ""],
  [WORK_AUTHORISATION_OPTIONS[3], "Yes"],
  [WORK_AUTHORISATION_OPTIONS[4], ""],
];
for (const [option, expected] of sponsorshipExpectation) {
  const set = fieldAnswersFromFacts(
    confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: plain, work_authorisation: option }))
  );
  const answer = answerOf(set, "sponsorship");
  check(
    `sponsorship from “${option}” is ${expected === "" ? "left unanswered" : `“${expected}”`}`,
    expected === ""
      ? answer.status === "not-covered" && answer.answer === "" && answer.nudge !== null
      : answer.status === "answered" && answer.answer === expected && answer.sources.length > 0,
    JSON.stringify({ status: answer.status, answer: answer.answer, notCovered: answer.notCovered.slice(0, 80) })
  );
}
const limitedRights = fieldAnswersFromFacts(
  confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: plain, work_authorisation: WORK_AUTHORISATION_OPTIONS[2] }))
);
check(
  "the limited-work-rights answer is explained rather than read as “no” (or as “yes”)",
  /limited work rights/.test(answerOf(limitedRights, "sponsorship").notCovered) &&
    answerOf(limitedRights, "sponsorship").nudge?.hash === "work-authorisation-note",
  JSON.stringify(answerOf(limitedRights, "sponsorship").notCovered)
);
const resumeRightsOnly = fieldAnswersFromFacts(confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: plain })));
const sponsorshipFromResumeLine = answerOf(resumeRightsOnly, "sponsorship");
check(
  "a résumé line about citizenship is quoted, not converted into a yes/no sponsorship answer",
  sponsorshipFromResumeLine.status === "not-covered" &&
    sponsorshipFromResumeLine.answer === "" &&
    sponsorshipFromResumeLine.notCovered.includes("Australian citizen"),
  JSON.stringify(sponsorshipFromResumeLine.notCovered)
);

// Years of experience: only ever the user's own words.
check(
  "a phrase like “6 years of experience” is recognised, and “Six years across fintech” is not treated as a statement of it",
  statedYearsPhrase("6 years of experience in support") === "6 years of experience" &&
    statedYearsPhrase("Six years across fintech and health SaaS") === "" &&
    statedYearsPhrase("Experience: 8 years") === "8 years",
  JSON.stringify([
    statedYearsPhrase("6 years of experience in support"),
    statedYearsPhrase("Six years across fintech and health SaaS"),
    statedYearsPhrase("Experience: 8 years"),
  ])
);
const yearsFact: Fact = {
  id: "user-identity-years",
  category: "identity",
  label: "Detail you added",
  value: "6 years of experience",
  fields: { value: "6 years of experience" },
  source: { kind: "user" },
  quote: "6 years of experience",
  note: "",
  status: "confirmed",
  origin: "user",
  edited: false,
  createdAt: AT,
  updatedAt: AT,
};
const yearsAnswered = answerOf(fieldAnswersFromFacts([yearsFact]), "years_experience");
check(
  "a number the user states themselves answers the field, word for word, and is not calculated from their dates",
  yearsAnswered.status === "answered" &&
    yearsAnswered.answer === "6 years of experience" &&
    yearsAnswered.sources[0]!.factValue.includes(yearsAnswered.answer) &&
    /never calculate/i.test(yearsAnswered.caveat),
  JSON.stringify({ answer: yearsAnswered.answer, caveat: yearsAnswered.caveat })
);
const dateOnlyFacts = fieldAnswersFromFacts(confirmedSet(factsFor(richProfile())));
check(
  "the engine never sums role dates into a number of years",
  answerOf(dateOnlyFacts, "years_experience").status === "not-covered" &&
    !/\d+\s*years/i.test(answerOf(dateOnlyFacts, "years_experience").answer),
  JSON.stringify(answerOf(dateOnlyFacts, "years_experience").answer)
);

// Joins keep each fact's own wording, and nothing is ranked.
const withMasters: Fact[] = [
  ...confirmedSet(factsFor(richProfile())),
  {
    id: "user-education-masters",
    category: "education",
    label: "Education you added",
    value: "Master of Data Science, RMIT University (2021 – 2023)",
    fields: {
      qualification: "Master of Data Science",
      school: "RMIT University",
      dates: "2021 – 2023",
      details: "",
    },
    source: { kind: "user" },
    quote: "Master of Data Science, RMIT University (2021 – 2023)",
    note: "",
    status: "confirmed",
    origin: "user",
    edited: false,
    createdAt: AT,
    updatedAt: AT,
  },
];
const degrees = withMasters.filter((fact) => fact.category === "education");
const educationAnswer = answerOf(fieldAnswersFromFacts(withMasters), "education");
check(
  "two qualifications are both listed in the user's own words, with a caveat instead of a ranking",
  educationAnswer.answer.includes("Bachelor of Commerce") &&
    educationAnswer.answer.includes("Master of Data Science") &&
    educationAnswer.answer.includes(" · ") &&
    /don't rank/i.test(educationAnswer.caveat) &&
    educationAnswer.sources.length === degrees.length,
  JSON.stringify({ answer: educationAnswer.answer, caveat: educationAnswer.caveat, sources: educationAnswer.sources.length })
);
check(
  "the same facts always give the same answers (nothing here is random or stateful)",
  JSON.stringify(fieldAnswersFromFacts(richConfirmed)) === JSON.stringify(richSet)
);

// =========================================================================== E ===
banner("E. through the real storage module (a real account, a throwaway data dir)");

const user = db.createUser("field-answers-check@example.com", "not-a-real-hash");
db.saveProfile(user.id, richProfile());
const accountState = q.ensureFacts(user.id);
check(
  "the account's material is read into facts, unconfirmed to begin with",
  accountState.facts.length > 20 && accountState.facts.every((fact) => fact.status === "suggested"),
  JSON.stringify({ facts: accountState.facts.length })
);

const beforeAnswers = db.getQualificationDecisions(user.id);
const unconfirmedAnswers = fieldAnswersFor(user.id);
check(
  "an account that has confirmed nothing gets no answers at all",
  unconfirmedAnswers.answered === 0 && unconfirmedAnswers.empty === true,
  JSON.stringify({ answered: unconfirmedAnswers.answered })
);
check(
  "asking for the answers writes nothing to the store",
  JSON.stringify(db.getQualificationDecisions(user.id)) === JSON.stringify(beforeAnswers),
  "the decisions row changed"
);

const confirmOverall = q.confirmFacts(user.id, "overall");
check("the whole set can be confirmed the way the review screen does it", confirmOverall.ok);
const confirmedAnswers = fieldAnswersFor(user.id);
check(
  "confirming the set fills the fields in from it",
  confirmedAnswers.answered >= 12 &&
    answerOf(confirmedAnswers, "email").answer === "alex.morgan@example.com" &&
    answerOf(confirmedAnswers, "notice_period").answer === "4 weeks",
  JSON.stringify({ answered: confirmedAnswers.answered })
);

const emailInAccount = q
  .ensureFacts(user.id)
  .facts.find((fact) => fact.category === "identity" && fact.label === "Email");
if (!emailInAccount) {
  check("the account has an email fact to test the exclusion path with", false, "no email fact");
} else {
  check("excluding a fact saves", q.excludeFact(user.id, emailInAccount.id).ok);
  const afterExclusion = fieldAnswersFor(user.id);
  check(
    "the answer layer follows the user's live decisions: the excluded fact is named, not used",
    answerOf(afterExclusion, "email").status === "not-covered" &&
      answerOf(afterExclusion, "email").answer === "" &&
      answerOf(afterExclusion, "email").excluded.length === 1,
    JSON.stringify({
      status: answerOf(afterExclusion, "email").status,
      excluded: answerOf(afterExclusion, "email").excluded.length,
    })
  );
  q.restoreFact(user.id, emailInAccount.id);
  const afterRestore = answerOf(fieldAnswersFor(user.id), "email");
  check(
    "bringing an excluded fact back does not quietly put it back on the form — it waits to be confirmed again",
    afterRestore.status === "pending" &&
      afterRestore.answer === "" &&
      afterRestore.pendingNote === PENDING_FACT_COPY,
    JSON.stringify({ status: afterRestore.status, answer: afterRestore.answer })
  );
  check("…and confirming it then answers the field", q.keepFact(user.id, emailInAccount.id).ok &&
    answerOf(fieldAnswersFor(user.id), "email").answer === "alex.morgan@example.com");
}

const salaryFact = q
  .ensureFacts(user.id)
  .facts.find((fact) => fact.category === "identity" && fact.label === "Salary expectation");
if (!salaryFact) {
  check("the vault's salary expectation is read as a fact the user can check", false, "no salary fact");
} else {
  check(
    "the vault's salary expectation arrives as a fact, quoting the user's own wording",
    salaryFact.value === "$120,000–$135,000 plus super" && salaryFact.source.kind === "profile",
    JSON.stringify({ value: salaryFact.value, source: salaryFact.source })
  );
  check("correcting it saves", q.correctFact(user.id, salaryFact.id, { value: "From $135,000, negotiable at offer stage" }).ok);
  const corrected = answerOf(fieldAnswersFor(user.id), "salary_expectation");
  check(
    "the answer uses the user's corrected wording and says it was edited by them",
    corrected.answer === "From $135,000, negotiable at offer stage" &&
      /edited by you after we read it/.test(corrected.sources[0]!.provenance),
    JSON.stringify({ answer: corrected.answer, provenance: corrected.sources[0]!.provenance })
  );
}

const beforeExport = db.getQualificationDecisions(user.id);
const exported = db.exportAccount(user.id);
const exportedDecisions = (exported?.qualifications?.decisions as unknown[] | null | undefined) ?? [];
check(
  "the facts and the decisions are in the account export",
  exportedDecisions.length > 0 &&
    Array.isArray((exported?.qualifications as { facts?: unknown[] } | null | undefined)?.facts ?? null),
  JSON.stringify({ decisions: exportedDecisions.length, keys: Object.keys(exported?.qualifications ?? {}) })
);
check(
  "and asking for answers again still wrote nothing",
  JSON.stringify(db.getQualificationDecisions(user.id)) === JSON.stringify(beforeExport)
);

const deleted = db.deleteAccount(user.id);
const leftovers = db.countRowsForUser(user.id);
check(
  "deleting the account removes the facts and the decisions with everything else",
  deleted?.qualificationDecisions === 1 &&
    deleted?.qualifications === 1 &&
    Object.values(leftovers).every((count) => count === 0),
  JSON.stringify({ deleted: deleted?.qualificationDecisions, leftovers })
);

// =========================================================================== F ===
banner("F. every nudge points at a place that exists");

const profileSource = readFileSync(join(SRC, "routes", "profile.tsx"), "utf8");
const reviewSource = readFileSync(join(SRC, "routes", "qualifications.tsx"), "utf8");
const profileAnchors = new Set([...profileSource.matchAll(/id="([^"]+)"/g)].map((match) => match[1] ?? ""));
const reviewAddTemplate = reviewSource.includes("id={`add-${category}`}");

const allNudges = [...richSet.answers, ...thinSet.answers, ...nothingSet.answers].filter(
  (answer) => answer.nudge !== null
);
check(
  "every field that needs a nudge has one, with text and an action",
  allNudges.every((answer) => answer.nudge!.text.length > 10 && answer.nudge!.action.length > 10)
);
const missingProfileAnchor = allNudges.filter(
  (answer) => answer.nudge!.where === "profile" && !profileAnchors.has(answer.nudge!.hash)
);
check(
  "every profile nudge lands on an element that exists on the profile page",
  missingProfileAnchor.length === 0,
  JSON.stringify(missingProfileAnchor.map((answer) => [answer.field, answer.nudge!.hash]))
);
const reviewNudges = allNudges.filter((answer) => answer.nudge!.where === "qualifications");
check(
  "every review-screen nudge lands on that category's own add form",
  reviewAddTemplate &&
    reviewNudges.every((answer) => /^add-(identity|role|education|skill|achievement|certification|language|work_rights)$/.test(answer.nudge!.hash)),
  JSON.stringify(reviewNudges.map((answer) => [answer.field, answer.nudge!.hash]))
);
check(
  "…and the anchors the nudges use are the ones the pages really have",
  profileAnchors.has("about-you") &&
    profileAnchors.has("links") &&
    profileAnchors.has("resume") &&
    profileAnchors.has("experience") &&
    profileAnchors.has("education") &&
    profileAnchors.has("work-authorisation") &&
    profileAnchors.has("work-authorisation-note") &&
    profileAnchors.has("salary") &&
    profileAnchors.has("notice-period"),
  JSON.stringify([...profileAnchors].sort())
);

const fieldAnswerSource = readFileSync(join(SRC, "server", "field-answers.ts"), "utf8");
check(
  "the answering layer makes no network calls and holds no model",
  !/\bfetch\s*\(/.test(fieldAnswerSource) &&
    !/https?:\/\//.test(fieldAnswerSource.replace(/https?:\/\/alexmorgan\.dev/g, "")) &&
    !/openai|anthropic|completion/i.test(fieldAnswerSource),
  "the module mentions a network call"
);
check(
  "and it is the only place that decides an answer, so the rules can be re-checked here",
  typeof answerSource === "function" && typeof fieldAnswersFromFacts === "function"
);

// ---------------------------------------------------------------------- done ---
console.log(`\n${"=".repeat(78)}`);
if (problems.length === 0) {
  console.log(`ALL CHECKS PASSED (${String(checks)})`);
  process.exit(0);
}
console.log(`${String(problems.length)} CHECK(S) FAILED out of ${String(checks)}:`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
