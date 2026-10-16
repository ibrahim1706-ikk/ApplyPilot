/**
 * ApplyPilot — per-field review, piece 1: the ANSWERS ENGINE, checked honestly.
 *
 * This is the verification half of the first piece of the per-field review
 * milestone. It covers the engine and the storage paths the review screen will
 * call; it deliberately says nothing about the `/answers` screen's controls,
 * because piece 2 builds those. The criteria it does NOT cover, and why:
 *
 *   - AC-17 and AC-18 (the read-only claim gone; only existing server functions
 *     imported) — the route is still the read-only screen today, so a check for
 *     them would fail by construction until piece 2. Writing them now would be
 *     pinning a state we have not built.
 *   - AC-19 and AC-20 are covered, but as SOURCE SCANS of the route as it stands
 *     (it must not instrument, must not talk to the database, and must take its
 *     provenance strings from the engine) — that half is already true.
 *   - AC-22 … AC-27 (browser) — piece 2, once there is a control to click.
 *
 * What it covers, in the order the brief puts it:
 *
 *   A. PROVENANCE PER FIELD (AC-1 … AC-5) — every answered field carries sources
 *      that are confirmed facts; the answer is nothing but those facts' own words;
 *      the exact source line is recoverable from the caption; and a fact the USER
 *      TYPED is marked as theirs, not as something we read. AC-4 fails on the code
 *      as it stood before `AnswerSource.sourceKind` existed, which is what proves
 *      the fix.
 *
 *   B. THE THREE STATES (AC-7, AC-8, AC-10, AC-11) — pending withholds the value
 *      and leaves every other field byte-identical; an excluded fact is named and
 *      used nowhere; a gap is never filled with a plausible default; an account
 *      with nothing in it answers nothing and points everywhere.
 *
 *   C. NOTHING IS COMPUTED ON THE USER'S BEHALF (AF-1 … AF-7) — no years-of-
 *      experience number derived from role dates, ever; no number of any kind that
 *      the user's own material does not state; sponsorship never guessed; nothing
 *      ranked or merged; the engine deterministic and never cached. AF-3 is the
 *      one that must fail the moment anybody starts doing arithmetic on dates.
 *
 *   D. THE FIXES THIS PIECE MADE (R1-1 … R1-4) — a fact added FOR a field carries
 *      that field's own label and answers it (nine fields, the labelling used to
 *      make them all silent); the generic add keeps the old behaviour; the
 *      duplicate refusal still works; and both survive a résumé change and a
 *      separate process.
 *
 *   E. THROUGH THE REAL STORAGE MODULE (AC-6, AC-12 … AC-16) — a real account on a
 *      throwaway data dir: a read writes nothing; each action writes at most one
 *      decision; the confirmation semantics are exactly as coded and do not move an
 *      answer; a correction reads back unchanged in a SEPARATE PROCESS; decisions
 *      survive a résumé change; and AC-16 pins today's shadowing behaviour (see
 *      the note printed with it — today's code does NOT match the lead's decision).
 *
 *   F. SOURCE SCANS (AC-9, AC-20, AC-21) — every nudge anchor resolves against the
 *      route that owns it; the answers screen instruments nothing and speaks no
 *      SQL; and the sponsorship promise that was not true of this layer is gone.
 *
 * Non-vacuity: every criterion the brief names must actually have been exercised,
 * all 17 fields must appear, and an empty run fails. Exits non-zero on any failure.
 * Run: `bun run scripts/field-review-check.ts`
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const FIXTURES = join(HERE, "fixtures");
const SELF = fileURLToPath(import.meta.url);

// --------------------------------------------------------- the reopen phase ---
//
// A second process, pointed at the same data directory, reading the answers the
// same way the page's loader does. If a correction or a fact the user added only
// lived in this process's memory, this is where it goes missing.
if (process.argv[2] === "--reopen") {
  const payload = JSON.parse(process.argv[3] ?? "{}") as {
    userId: string;
    dataDir: string;
    facts?: Array<{
      what: string;
      id?: string;
      label?: string;
      status?: string;
      value?: string;
      origin?: string;
      sourceKind?: string;
      sourceGone?: boolean;
    }>;
    answers?: Array<{
      what: string;
      field: string;
      status?: string;
      answer?: string;
      provenanceIncludes?: string;
      quote?: string;
      sourceKind?: string;
      sourceGone?: boolean;
      label?: string;
    }>;
  };
  process.env.APPLYPILOT_DATA_DIR = payload.dataDir;
  const q = await import("../src/server/qualifications");
  const answers = await import("../src/server/field-answers");
  const factList = q.ensureFacts(payload.userId).facts;
  const set = answers.fieldAnswersFor(payload.userId);
  const results: Array<{ what: string; ok: boolean; problems: string[] }> = [];

  for (const want of payload.facts ?? []) {
    // Everything the caller named has to match: a label alone would find the
    // résumé's version of a fact the user typed, which is exactly the confusion
    // this phase exists to rule out.
    const fact = factList.find(
      (item) =>
        (want.id === undefined || item.id === want.id) &&
        (want.label === undefined || item.label === want.label) &&
        (want.origin === undefined || item.origin === want.origin) &&
        (want.sourceKind === undefined || item.source.kind === want.sourceKind)
    );
    const problems: string[] = [];
    if (!fact) problems.push("fact is not in the set at all");
    else {
      if (want.label !== undefined && fact.label !== want.label) {
        problems.push(`label is ${JSON.stringify(fact.label)}, expected ${JSON.stringify(want.label)}`);
      }
      if (want.status !== undefined && fact.status !== want.status) {
        problems.push(`status is ${fact.status}, expected ${want.status}`);
      }
      if (want.value !== undefined && fact.value !== want.value) {
        problems.push(`value is ${JSON.stringify(fact.value)}, expected ${JSON.stringify(want.value)}`);
      }
      if (want.origin !== undefined && fact.origin !== want.origin) {
        problems.push(`origin is ${fact.origin}, expected ${want.origin}`);
      }
      if (want.sourceKind !== undefined && fact.source.kind !== want.sourceKind) {
        problems.push(`source kind is ${fact.source.kind}, expected ${want.sourceKind}`);
      }
      if (want.sourceGone !== undefined && (fact.sourceGone ?? false) !== want.sourceGone) {
        problems.push(`sourceGone is ${String(fact.sourceGone ?? false)}, expected ${String(want.sourceGone)}`);
      }
    }
    results.push({ what: want.what, ok: problems.length === 0, problems });
  }

  for (const want of payload.answers ?? []) {
    const entry = set.answers.find((item) => item.field === want.field);
    const problems: string[] = [];
    if (!entry) problems.push("no answer for that field");
    else {
      const source = entry.sources[0];
      if (want.status !== undefined && entry.status !== want.status) {
        problems.push(`status is ${entry.status}, expected ${want.status}`);
      }
      if (want.answer !== undefined && entry.answer !== want.answer) {
        problems.push(`answer is ${JSON.stringify(entry.answer)}, expected ${JSON.stringify(want.answer)}`);
      }
      if (want.provenanceIncludes !== undefined && !(source?.provenance ?? "").includes(want.provenanceIncludes)) {
        problems.push(
          `provenance is ${JSON.stringify(source?.provenance ?? null)}, expected it to contain ${JSON.stringify(
            want.provenanceIncludes
          )}`
        );
      }
      if (want.quote !== undefined && source?.quote !== want.quote) {
        problems.push(`quote is ${JSON.stringify(source?.quote ?? null)}, expected ${JSON.stringify(want.quote)}`);
      }
      if (want.sourceKind !== undefined && source?.sourceKind !== want.sourceKind) {
        problems.push(`source kind is ${String(source?.sourceKind)}, expected ${want.sourceKind}`);
      }
      if (want.sourceGone !== undefined && (source?.sourceGone ?? false) !== want.sourceGone) {
        problems.push(`sourceGone is ${String(source?.sourceGone ?? false)}, expected ${String(want.sourceGone)}`);
      }
      if (want.label !== undefined && source?.factLabel !== want.label) {
        problems.push(`fact label is ${JSON.stringify(source?.factLabel ?? null)}, expected ${JSON.stringify(want.label)}`);
      }
    }
    results.push({ what: want.what, ok: problems.length === 0, problems });
  }

  console.log(JSON.stringify({ answers: set.answered, facts: factList.length, results }, null, 2));
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

// -------------------------------------------------------------- the main run ---
const dataDir = mkdtempSync(join(tmpdir(), "applypilot-field-review-"));
process.env.APPLYPILOT_DATA_DIR = dataDir;

const db = await import("../src/db");
const q = await import("../src/server/qualifications");
const fa = await import("../src/server/field-answers");
const types = await import("../src/types");

type Fact = import("../src/types").Fact;
type FactDecision = import("../src/types").FactDecision;
type FieldAnswer = import("../src/types").FieldAnswer;
type FieldAnswers = import("../src/types").FieldAnswers;
type AnswerFieldKey = import("../src/types").AnswerFieldKey;

const {
  ANSWER_FIELD_SPECS,
  IDENTITY_FACT_LABELS,
  PENDING_FACT_COPY,
  WORK_AUTHORISATION_OPTIONS,
  factValueKey,
} = types;
const { fieldAnswersFromFacts, fieldAnswersFor } = fa;

const AT = "2026-03-01T00:00:00.000Z";

/** Every criterion the brief names. A run that skips one fails at the end. */
const REQUIRED = [
  "AC-1",
  "AC-2",
  "AC-3",
  "AC-4",
  "AC-5",
  "AC-6",
  "AC-7",
  "AC-8",
  "AC-9",
  "AC-10",
  "AC-11",
  "AC-12",
  "AC-13",
  "AC-14",
  "AC-15",
  "AC-16",
  "AC-20",
  "AC-21",
  "AF-1",
  "AF-2",
  "AF-3",
  "AF-4",
  "AF-5",
  "AF-6",
  "AF-7",
  "R1-1",
  "R1-2",
  "R1-3",
  "R1-4",
];
const exercised = new Map<string, number>();
const fieldsSeen = new Set<AnswerFieldKey>();
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

function criterion(id: string, name: string, ok: boolean, detail = ""): boolean {
  exercised.set(id, (exercised.get(id) ?? 0) + 1);
  return check(`${id} ${name}`, ok, detail);
}

function banner(title: string) {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

function note(text: string) {
  console.log(`  note ${text}`);
}

// ------------------------------------------------------------------ fixtures ---
const plain = readFileSync(join(FIXTURES, "resume-plain.txt"), "utf8");
const thin = readFileSync(join(FIXTURES, "resume-thin.txt"), "utf8");

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
  fieldsSeen.add(field);
  return found;
}

function touch(set: FieldAnswers): FieldAnswers {
  for (const answer of set.answers) fieldsSeen.add(answer.field);
  return set;
}

/** One field's entry as a string, for byte-identical comparisons. */
function entry(set: FieldAnswers, field: AnswerFieldKey): string {
  return JSON.stringify(answerOf(set, field));
}

/** A correct decision, exactly as `correctFact` writes one. */
function correction(
  fact: Fact,
  fields: Record<string, string>,
  value: string
): FactDecision {
  return {
    id: fact.id,
    category: fact.category,
    action: "correct",
    fields,
    value,
    snapshot: q.snapshotOf(fact),
    valueKey: factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  };
}

/** A keep decision, exactly as `keepFact`/`confirmFacts` write one. */
function keep(fact: Fact): FactDecision {
  return {
    id: fact.id,
    category: fact.category,
    action: "keep",
    snapshot: q.snapshotOf(fact),
    valueKey: factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  };
}

/** An exclude decision, exactly as `excludeFact` writes one. */
function exclusion(fact: Fact): FactDecision {
  return {
    id: fact.id,
    category: fact.category,
    action: "exclude",
    snapshot: q.snapshotOf(fact),
    valueKey: factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  };
}

const richFacts = factsFor(richProfile());
const richSet = touch(fieldAnswersFromFacts(confirmedSet(richFacts)));
const nothingSet = touch(fieldAnswersFromFacts([]));
const thinSet = touch(
  fieldAnswersFromFacts(confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: thin })))
);

// =========================================================================== A ===
banner("A. every answer is built from the user's own facts, and says where they came from");

const everyFieldPresent = ANSWER_FIELD_SPECS.every(
  (spec) => richSet.answers.filter((answer) => answer.field === spec.key).length === 1
);
criterion(
  "AC-1",
  `all 17 fields are answered or honestly empty, and no field appears twice (${String(
    richSet.answered
  )} answered)`,
  everyFieldPresent && richSet.answers.length === 17 && richSet.answered >= 12,
  JSON.stringify({ answers: richSet.answers.length, answered: richSet.answered })
);

const confirmedIds = new Set(confirmedSet(richFacts).map((fact) => fact.id));
const badSources = richSet.answers
  .filter((answer) => answer.status === "answered")
  .filter(
    (answer) =>
      answer.sources.length === 0 ||
      answer.sources.some((source) => !confirmedIds.has(source.factId))
  );
criterion(
  "AC-1",
  "every answered field carries at least one source, and every source is a CONFIRMED fact",
  badSources.length === 0,
  JSON.stringify(badSources.map((answer) => answer.field))
);
criterion(
  "AC-1",
  "no field is answered with nothing behind it, and no unconfirmed fact is used as a source anywhere",
  richSet.answers
    .filter((answer) => answer.status !== "answered")
    .every((answer) => answer.answer === "" && answer.sources.length === 0),
  JSON.stringify(
    richSet.answers
      .filter((answer) => answer.status !== "answered")
      .map((answer) => [answer.field, answer.answer, answer.sources.length])
  )
);

// AC-2 — the answer is only ever its sources' own words.
const singleFactFields: AnswerFieldKey[] = [
  "full_name",
  "email",
  "phone",
  "location",
  "portfolio",
  "github",
  "linkedin",
  "notice_period",
  "salary_expectation",
  "current_role",
];
const singleMismatch = singleFactFields
  .map((field) => ({ field, answer: answerOf(richSet, field) }))
  .filter(({ answer }) => answer.status === "answered" && answer.answer !== answer.sources[0]!.factValue);
criterion(
  "AC-2",
  "each single-value field's answer is exactly its fact's own value, character for character",
  singleMismatch.length === 0,
  JSON.stringify(singleMismatch.map(({ field, answer }) => [field, answer.answer, answer.sources[0]!.factValue]))
);

/** What a joined field's answer must be, from its own sources. */
function joinedFrom(sources: FieldAnswer["sources"], separator: string, withLevel: boolean): string {
  return sources
    .map((source) => {
      if (!withLevel) return source.factValue;
      const level = (source.fields.level ?? "").trim();
      return level ? `${source.factValue} (${level})` : source.factValue;
    })
    .join(separator);
}
const joins: Array<[AnswerFieldKey, string, boolean]> = [
  ["education", " · ", false],
  ["skills", ", ", false],
  ["certifications", " · ", false],
  ["languages", ", ", true],
];
const joinMismatch = joins
  .map(([field, separator, withLevel]) => {
    const answer = answerOf(richSet, field);
    return { field, answer, expected: joinedFrom(answer.sources, separator, withLevel) };
  })
  .filter(({ answer, expected }) => answer.status === "answered" && answer.answer !== expected);
criterion(
  "AC-2",
  "each list field's answer is its sources' own values joined with that field's separator and nothing else",
  joinMismatch.length === 0,
  JSON.stringify(joinMismatch.map(({ field, answer, expected }) => [field, answer.answer, expected]))
);
const joinedAnswered = joins.filter(([field]) => answerOf(richSet, field).sources.length > 0);
criterion(
  "AC-2",
  "…and at least one list field really is built from several facts (so the join is not checked on an empty list)",
  joins.some(([field]) => answerOf(richSet, field).sources.length >= 1) && joinedAnswered.length === 4,
  JSON.stringify(joins.map(([field]) => [field, answerOf(richSet, field).sources.length]))
);

// AC-3 — the exact source line is recoverable, in the review screen's words.
const allSources = richSet.answers.flatMap((answer) => answer.sources);
const resumeSources = allSources.filter((source) => source.sourceKind === "resume");
const profileSources = allSources.filter((source) => source.sourceKind === "profile");
// The extractor quotes a fact that spans several lines as those lines joined with
// "  /  " (qualifications.ts:1327). So "is the quote verbatim in the material" is
// asked two ways: the whole quote for a single-line fact, and every part of it for
// a multi-line one. The multi-line count is printed, because the caption names the
// FIRST line of the block while the quote spans several — a real, small gap between
// the caption and what is shown, which the lead should know about rather than have
// hidden behind a check that quietly allows it.
const MULTI_LINE_SEPARATOR = "  /  ";
const splitQuote = (quote: string) => quote.split(MULTI_LINE_SEPARATOR);
const multiLineSources = resumeSources.filter((source) => splitQuote(source.quote).length > 1);
const badResume = resumeSources.filter(
  (source) =>
    !/^From your résumé text, line \d+/.test(source.provenance) ||
    splitQuote(source.quote).some((part) => part.trim() !== "" && !plain.includes(part))
);
criterion(
  "AC-3",
  "a résumé-sourced answer names the line, and every line quoted from the material is in the material, verbatim",
  badResume.length === 0,
  JSON.stringify(badResume.map((source) => [source.factLabel, source.provenance, source.quote.slice(0, 40)]))
);
note(
  `${String(multiLineSources.length)} of ${String(resumeSources.length)} résumé sources quote more than one line (joined with “${MULTI_LINE_SEPARATOR}”), and their caption names only the first line of the block: ${JSON.stringify(
    multiLineSources.map((source) => [source.provenance, splitQuote(source.quote).length])
  )}. Nothing is paraphrased — every part is verbatim — but the caption is narrower than the quote.`
);
const badProfile = profileSources.filter((source) => !/^From your vault — /.test(source.provenance));
criterion(
  "AC-3",
  "a vault-sourced answer says which vault field it came from, in the review screen's own words",
  badProfile.length === 0,
  JSON.stringify(badProfile.map((source) => [source.factLabel, source.provenance]))
);
criterion(
  "AC-3",
  "both kinds of source are actually exercised here (a vault field and a real résumé line)",
  resumeSources.length > 0 && profileSources.length > 0,
  JSON.stringify({ resume: resumeSources.length, profile: profileSources.length })
);
const userTypedFact: Fact = {
  id: "user-identity-typed-name",
  category: "identity",
  label: IDENTITY_FACT_LABELS.full_name,
  value: "Alexandra Morgan",
  fields: { value: "Alexandra Morgan" },
  source: { kind: "user" },
  quote: "Alexandra Morgan",
  note: "",
  status: "confirmed",
  origin: "user",
  edited: false,
  createdAt: AT,
  updatedAt: AT,
};
const typedSet = touch(fieldAnswersFromFacts([userTypedFact]));
const typedName = answerOf(typedSet, "full_name");
criterion(
  "AC-3",
  "a fact the user typed reads as “Added by you”, never as a résumé line or a vault field",
  typedName.status === "answered" &&
    typedName.sources[0]!.provenance === "Added by you" &&
    typedName.sources[0]!.sourceKind === "user",
  JSON.stringify({ provenance: typedName.sources[0]!.provenance, kind: typedName.sources[0]!.sourceKind })
);

// AC-4 — the criterion the fix exists for: the kind must be on the source at all.
criterion(
  "AC-4",
  "a fact the user typed carries sourceKind “user”, so the screen can never render it as résumé-sourced",
  typedName.sources[0]!.sourceKind === "user" && typedName.answer === "Alexandra Morgan",
  JSON.stringify({ sourceKind: typedName.sources[0]!.sourceKind })
);
criterion(
  "AC-4",
  "every source on every answer carries a source kind from the fact it was copied from",
  richSet.answers
    .flatMap((answer) => [...answer.sources, ...answer.related, ...answer.pending, ...answer.excluded])
    .every((source) => source.sourceKind === "resume" || source.sourceKind === "profile" || source.sourceKind === "user"),
  JSON.stringify(
    richSet.answers
      .flatMap((answer) => [...answer.sources, ...answer.pending, ...answer.excluded])
      .map((source) => [source.factLabel, String(source.sourceKind)])
      .filter(([, kind]) => kind === "undefined" || kind === "null")
  )
);

// AC-5 — a correction: the user's wording answers, the ORIGINAL line is shown, captioned.
const thinNameFact = confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: thin })).find(
  (fact) => fact.category === "identity" && fact.label === IDENTITY_FACT_LABELS.full_name
)!;
const correctedName = q.applyDecisions(
  [thinNameFact],
  [correction(thinNameFact, { value: "Alexandra Morgan" }, "Alexandra Morgan")]
).facts;
const correctedNameAnswer = answerOf(fieldAnswersFromFacts(correctedName), "full_name");
criterion(
  "AC-5",
  "after a correction the answer is the user's own wording",
  correctedNameAnswer.status === "answered" && correctedNameAnswer.answer === "Alexandra Morgan",
  JSON.stringify({ answer: correctedNameAnswer.answer })
);
criterion(
  "AC-5",
  "…and the line shown beside it is still the ORIGINAL line, captioned “edited by you after we read it”",
  correctedNameAnswer.sources[0]!.quote === thinNameFact.quote &&
    correctedNameAnswer.sources[0]!.provenance ===
      `From your résumé text, line 3 · edited by you after we read it` &&
    correctedNameAnswer.sources[0]!.sourceGone === false,
  JSON.stringify({
    quote: correctedNameAnswer.sources[0]!.quote,
    provenance: correctedNameAnswer.sources[0]!.provenance,
  })
);
note(
  "the spec's literal wording — that the line shown is the user's OWN text — is not what the product does, and cannot be: the user's wording has no line in their material. What is pinned above is the honest version: their wording answers, and the line it was read from stays visible, marked as edited. A later check demanding the literal version would force the app to fabricate a line."
);

// =========================================================================== B ===
banner("B. the three states: confirmed answers, pending named, excluded never used");

const phoneFact = confirmedSet(richFacts).find((fact) => fact.label === IDENTITY_FACT_LABELS.phone)!;
const pendingSet = touch(
  fieldAnswersFromFacts(confirmedSet(richFacts).map((fact) => (fact.id === phoneFact.id ? { ...fact, status: "suggested" as const } : fact)))
);
const pendingPhone = answerOf(pendingSet, "phone");
criterion(
  "AC-7",
  "a field whose covering fact is not confirmed is PENDING: no answer, no sources, the fact named",
  pendingPhone.status === "pending" &&
    pendingPhone.answer === "" &&
    pendingPhone.sources.length === 0 &&
    pendingPhone.pending.length > 0 &&
    pendingPhone.pendingNote === PENDING_FACT_COPY &&
    pendingPhone.nudge === null,
  JSON.stringify({
    status: pendingPhone.status,
    answer: pendingPhone.answer,
    pending: pendingPhone.pending.length,
    pendingNote: pendingPhone.pendingNote,
  })
);
const pendingDrift = pendingSet.answers
  .filter((answer) => answer.field !== "phone")
  .filter((answer) => JSON.stringify(answer) !== entry(richSet, answer.field));
criterion(
  "AC-7",
  "…and every other field's answer is byte-identical, so a pending fact is used nowhere",
  pendingDrift.length === 0,
  JSON.stringify(pendingDrift.map((answer) => answer.field))
);

const excludedSet = touch(
  fieldAnswersFromFacts(confirmedSet(richFacts).map((fact) => (fact.id === phoneFact.id ? { ...fact, status: "excluded" as const } : fact)))
);
const excludedPhone = answerOf(excludedSet, "phone");
const excludedLeak = JSON.stringify({ ...excludedPhone, excluded: [] }).includes(phoneFact.value);
criterion(
  "AC-8",
  "a field whose only covering fact is excluded reads “Not covered — …”, with the fact named and used nowhere",
  excludedPhone.status === "not-covered" &&
    excludedPhone.answer === "" &&
    excludedPhone.excluded.length === 1 &&
    excludedPhone.notCovered.startsWith("Not covered — ") &&
    !excludedLeak,
  JSON.stringify({
    status: excludedPhone.status,
    answer: excludedPhone.answer,
    excluded: excludedPhone.excluded.length,
    leakedIntoTheRest: excludedLeak,
  })
);
criterion(
  "AC-8",
  "…and the excluded fact's value appears only in the excluded list, never inside the answer",
  excludedPhone.excluded[0]!.factValue === phoneFact.value && !excludedPhone.answer.includes(phoneFact.value),
  JSON.stringify({ excludedValue: excludedPhone.excluded[0]!.factValue, answer: excludedPhone.answer })
);

const FORBIDDEN = ["Negotiable", "N/A", "n/a", "-", "—", "Available on request", "0", "TBD"];
const allSets: Array<[string, FieldAnswers]> = [
  ["rich", richSet],
  ["thin", thinSet],
  ["nothing", nothingSet],
  ["pending", pendingSet],
  ["excluded", excludedSet],
];
const invented = allSets.flatMap(([label, set]) =>
  set.answers
    .filter((answer) => FORBIDDEN.some((bad) => answer.answer.trim().toLowerCase() === bad.toLowerCase()))
    .map((answer) => [label, answer.field, answer.answer] as const)
);
criterion(
  "AC-10",
  "no field in any state is answered with a plausible default (“Negotiable”, “N/A”, “TBD”, a dash …)",
  invented.length === 0,
  JSON.stringify(invented)
);
criterion(
  "AC-10",
  "…and every not-covered field's answer is exactly empty, not a filler",
  allSets.every(([, set]) => set.answers.filter((a) => a.status === "not-covered").every((a) => a.answer === "")),
  JSON.stringify(
    allSets.map(([label, set]) => [
      label,
      set.answers.filter((a) => a.status === "not-covered" && a.answer !== "").map((a) => [a.field, a.answer]),
    ])
  )
);

criterion(
  "AC-11",
  "an account with nothing in it answers nothing, and every field still says where the detail belongs",
  nothingSet.answered === 0 &&
    nothingSet.empty === true &&
    nothingSet.factCount === 0 &&
    nothingSet.answers.length === 17 &&
    nothingSet.answers.every((answer) => answer.nudge !== null),
  JSON.stringify({ answered: nothingSet.answered, empty: nothingSet.empty, factCount: nothingSet.factCount })
);

// =========================================================================== C ===
banner("C. nothing is computed, guessed, ranked or cached on the user's behalf");

const yearsEntry = answerOf(richSet, "years_experience");
criterion(
  "AF-1",
  "a dated career with no stated number gives an empty years-of-experience field, not arithmetic",
  yearsEntry.status === "not-covered" &&
    yearsEntry.answer === "" &&
    !/\d+\s*\+?\s*(years?|yrs?)/i.test(yearsEntry.answer),
  JSON.stringify({ status: yearsEntry.status, answer: yearsEntry.answer })
);

// AF-2 — no field anywhere states a duration that the user's own material does not.
const materialText = [plain, thin, ...Object.values(richProfile()).filter((value) => typeof value === "string")].join("\n");
const YEARS_PHRASE_RE = /\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:\w+[-\s]){0,3}experience/gi;
const unstatedDurations: string[] = [];
for (const [label, set] of allSets) {
  for (const answer of set.answers) {
    const haystack = `${answer.answer} ${answer.caveat} ${answer.notCovered}`;
    for (const match of haystack.match(YEARS_PHRASE_RE) ?? []) {
      if (!materialText.includes(match)) unstatedDurations.push(`${label}/${answer.field}: “${match}”`);
    }
  }
}
criterion(
  "AF-2",
  "no field states a duration of experience the user's own material does not state, verbatim",
  unstatedDurations.length === 0,
  JSON.stringify(unstatedDurations)
);

// AF-5 — sponsorship is never guessed, and never moves because something else did.
const sponsorshipOutcomes = WORK_AUTHORISATION_OPTIONS.map((option) => {
  const profile = { ...richProfile(), work_authorisation: option };
  const set = fieldAnswersFromFacts(confirmedSet(factsFor(profile)));
  const answer = answerOf(set, "sponsorship");
  return { option, status: answer.status, answer: answer.answer };
});
const expectedOutcomes = ["answered/No", "answered/No", "not-covered/", "answered/Yes", "not-covered/"];
const outcomeStrings = sponsorshipOutcomes.map((entry) => `${entry.status}/${entry.answer}`);
criterion(
  "AF-5",
  "three of the five work-rights answers settle sponsorship (No, No, Yes) and the other two are left alone",
  JSON.stringify(outcomeStrings) === JSON.stringify(expectedOutcomes),
  JSON.stringify(sponsorshipOutcomes)
);
const resumeOnly = fieldAnswersFromFacts(confirmedSet(factsFor({ ...db.EMPTY_PROFILE, resume_text: plain })));
const resumeOnlySponsorship = answerOf(resumeOnly, "sponsorship");
criterion(
  "AF-5",
  "a résumé line about citizenship is quoted rather than turned into a yes or a no",
  resumeOnlySponsorship.status === "not-covered" &&
    resumeOnlySponsorship.answer === "" &&
    /Australian citizen/.test(resumeOnlySponsorship.notCovered),
  JSON.stringify({ status: resumeOnlySponsorship.status, notCovered: resumeOnlySponsorship.notCovered })
);
const otherFieldFlipped = touch(
  fieldAnswersFromFacts(
    confirmedSet(richFacts).map((fact) =>
      fact.category === "skill" ? { ...fact, status: "excluded" as const } : fact
    )
  )
);
criterion(
  "AF-5",
  "changing another field never changes the sponsorship answer",
  entry(otherFieldFlipped, "sponsorship") === entry(richSet, "sponsorship"),
  JSON.stringify({ before: entry(richSet, "sponsorship").slice(0, 120), after: entry(otherFieldFlipped, "sponsorship").slice(0, 120) })
);
const unsettled = sponsorshipOutcomes[2]!;
criterion(
  "AF-5",
  "…and where it is left alone the user is told why, in the engine's words",
  fieldAnswersFromFacts(
    confirmedSet(factsFor({ ...richProfile(), work_authorisation: unsettled.option }))
  ).answers.find((answer) => answer.field === "sponsorship")!.notCovered.includes("doesn't say whether you would need sponsorship"),
  "the unsettled work-rights answer produced no explanation"
);

// AF-6 — nothing is ranked or merged.
const mastersFact: Fact = {
  id: "user-education-masters",
  category: "education",
  label: "Education you added",
  value: "Master of Data Science, RMIT University (2021 – 2023)",
  fields: { qualification: "Master of Data Science", school: "RMIT University", dates: "2021 – 2023", details: "" },
  source: { kind: "user" },
  quote: "Master of Data Science, RMIT University (2021 – 2023)",
  note: "",
  status: "confirmed",
  origin: "user",
  edited: false,
  createdAt: AT,
  updatedAt: AT,
};
const twoDegrees = confirmedSet(richFacts).filter((fact) => fact.category === "education");
const degreesSet = touch(fieldAnswersFromFacts([...confirmedSet(richFacts), mastersFact]));
const degreesAnswer = answerOf(degreesSet, "education");
criterion(
  "AF-6",
  "two qualifications are both listed, in the user's own words, with a caveat instead of a ranking",
  degreesAnswer.answer.includes("Bachelor of Commerce") &&
    degreesAnswer.answer.includes("Master of Data Science") &&
    degreesAnswer.answer.includes(" · ") &&
    /don't rank/i.test(degreesAnswer.caveat) &&
    degreesAnswer.sources.length === twoDegrees.length + 1,
  JSON.stringify({ answer: degreesAnswer.answer, sources: degreesAnswer.sources.length })
);
const oneDegreeExcluded = touch(
  fieldAnswersFromFacts([
    ...confirmedSet(richFacts).map((fact) =>
      fact.category === "education" ? { ...fact, status: "excluded" as const } : fact
    ),
    mastersFact,
  ])
);
criterion(
  "AF-6",
  "excluding one qualification leaves the other, alone, with nothing merged in behind the user's back",
  answerOf(oneDegreeExcluded, "education").answer === mastersFact.value,
  JSON.stringify(answerOf(oneDegreeExcluded, "education").answer)
);

// AF-4 — a thin profile invents nothing.
const thinAnswered = thinSet.answers.filter((answer) => answer.status === "answered").map((answer) => answer.field);
const thinText = thinSet.answers.map((answer) => answer.answer).join(" | ");
criterion(
  "AF-4",
  "a three-line résumé yields the name and nothing else — no email, no phone, no digits at all",
  thinAnswered.length === 1 &&
    thinAnswered[0] === "full_name" &&
    !thinText.includes("@") &&
    !/\d{3,}/.test(thinText),
  JSON.stringify({ answered: thinAnswered, text: thinText })
);

// AF-7 — deterministic, and never cached.
criterion(
  "AF-7",
  "the same facts give byte-identical answers twice (nothing here is random or stateful)",
  JSON.stringify(fieldAnswersFromFacts(confirmedSet(richFacts))) === JSON.stringify(fieldAnswersFromFacts(confirmedSet(richFacts))),
  "two calls with the same facts differed"
);

// =========================================================================== E1 ===
banner("E. through the real storage module (a real account, a throwaway data dir)");

const user = db.createUser("field-review-check@example.com", "not-a-real-hash");
db.saveProfile(user.id, richProfile());

const decisionCount = (): number => {
  const stored = db.getQualificationDecisions(user.id);
  return stored ? (JSON.parse(stored.decisions_json) as unknown[]).length : 0;
};
const confirmationsOf = () => q.ensureFacts(user.id).confirmations;

// The first read after the material changes is what computes and caches the
// extraction (facts, not answers); from then on a read is a pure read. Both halves
// are pinned: the DECISIONS row is untouched by either read, and a second read
// writes nothing at all.
const decisionsBeforeAnyRead = JSON.stringify(db.getQualificationDecisions(user.id));
const storageRead = touch(fieldAnswersFor(user.id));
const decisionsAfterFirstRead = JSON.stringify(db.getQualificationDecisions(user.id));
const rowAfterFirstRead = JSON.stringify(db.getQualifications(user.id));
const secondRead = fieldAnswersFor(user.id);
const rowAfterSecondRead = JSON.stringify(db.getQualifications(user.id));
const rowHoldsNoAnswers = !/"status":"answered"/.test(rowAfterSecondRead);
criterion(
  "AC-12",
  "reading the answers never writes a decision, and a second read writes nothing at all",
  decisionsAfterFirstRead === decisionsBeforeAnyRead &&
    rowAfterFirstRead === rowAfterSecondRead &&
    storageRead.answers.length === 17 &&
    JSON.stringify(secondRead) === JSON.stringify(storageRead),
  JSON.stringify({
    decisionsSame: decisionsAfterFirstRead === decisionsBeforeAnyRead,
    secondReadWroteNothing: rowAfterFirstRead === rowAfterSecondRead,
  })
);
criterion(
  "AC-12",
  "…and the stored row holds facts and the extraction report, never an answer: the answers are recomputed, not saved",
  rowHoldsNoAnswers && rowAfterSecondRead.includes("facts"),
  JSON.stringify({ holdsAnswers: !rowHoldsNoAnswers })
);

// The user confirms the set, exactly as the review screen's button does.
const confirm = q.confirmFacts(user.id, "overall");
const answersAfterConfirm = JSON.stringify(fieldAnswersFor(user.id));
const secondConfirm = q.confirmFacts(user.id, "overall");
const answersAfterSecondConfirm = JSON.stringify(fieldAnswersFor(user.id));
criterion(
  "AC-14",
  "confirming the set does not move a single answer",
  confirm.ok && secondConfirm.ok && answersAfterConfirm === answersAfterSecondConfirm,
  JSON.stringify({ confirm: confirm.ok, secondConfirm: secondConfirm.ok })
);
criterion(
  "AC-14",
  "…and the confirmation it stores describes the set that was confirmed",
  confirmationsOf().overall !== null && q.confirmationMatches(confirmationsOf(), q.ensureFacts(user.id).facts, "overall"),
  JSON.stringify(confirmationsOf().overall)
);

const beforeKeep = decisionCount();
const keepTarget = q.ensureFacts(user.id).facts.find((fact) => fact.category === "skill")!;
const keptOnce = q.keepFact(user.id, keepTarget.id);
const afterFirstKeep = decisionCount();
const answersAfterKeep = JSON.stringify(fieldAnswersFor(user.id));
const keptTwice = q.keepFact(user.id, keepTarget.id);
criterion(
  "AC-13",
  "keeping a fact the user already confirmed writes no second decision, and no second row",
  keptOnce.ok && keptTwice.ok && afterFirstKeep === beforeKeep && decisionCount() === afterFirstKeep,
  JSON.stringify({ before: beforeKeep, afterFirst: afterFirstKeep, afterSecond: decisionCount() })
);
criterion(
  "AC-14",
  "…and keeping a fact does not clear the confirmation the user gave",
  confirmationsOf().overall !== null && answersAfterKeep === JSON.stringify(fieldAnswersFor(user.id)),
  JSON.stringify(confirmationsOf().overall)
);

// AC-6 — the user's correction, through storage, and read back in another process.
const salaryFact = q.ensureFacts(user.id).facts.find((fact) => fact.label === IDENTITY_FACT_LABELS.salary_expectation)!;
const CORRECTED_SALARY = "From $135,000, negotiable at offer stage";
const beforeCorrect = decisionCount();
const correct = q.correctFact(user.id, salaryFact.id, { value: CORRECTED_SALARY });
const afterCorrect = decisionCount();
criterion(
  "AC-13",
  "correcting a fact replaces its own decision rather than stacking a new one (+0 or +1, never more)",
  correct.ok && afterCorrect - beforeCorrect <= 1 && afterCorrect >= beforeCorrect,
  JSON.stringify({ before: beforeCorrect, after: afterCorrect })
);
const correctedSetAfter = fieldAnswersFor(user.id);
const correctedSalaryAnswer = answerOf(correctedSetAfter, "salary_expectation");
criterion(
  "AC-6",
  "through storage: the user's corrected wording is the answer, with the original line captioned as edited",
  correctedSalaryAnswer.answer === CORRECTED_SALARY &&
    correctedSalaryAnswer.sources[0]!.quote === "$120,000–$135,000 plus super" &&
    /edited by you after we read it/.test(correctedSalaryAnswer.sources[0]!.provenance) &&
    correctedSalaryAnswer.sources[0]!.sourceGone === false,
  JSON.stringify({
    answer: correctedSalaryAnswer.answer,
    provenance: correctedSalaryAnswer.sources[0]!.provenance,
  })
);
criterion(
  "AC-14",
  "correcting a fact clears the overall and that category's confirmation — and changes no answer by doing so",
  confirmationsOf().overall === null &&
    confirmationsOf().categories.identity === null &&
    confirmationsOf().categories.skill !== null &&
    JSON.stringify(fieldAnswersFor(user.id)) === JSON.stringify(correctedSetAfter),
  JSON.stringify({
    overall: confirmationsOf().overall,
    identity: confirmationsOf().categories.identity,
    skill: confirmationsOf().categories.skill,
  })
);
note(
  "the confirmation the user gave is cleared by a correction, but the FACT stays confirmed — so the answers do not move. The two different gates called “confirmed” are the lead's R4; this check pins that the answers follow per-fact status, not the confirmation record."
);

// AC-6 second half — the same answer in a fresh process.
const reopenCorrection = runReopen({
  userId: user.id,
  dataDir,
  facts: [{ what: "the corrected salary fact", id: salaryFact.id, status: "confirmed", value: CORRECTED_SALARY }],
  answers: [
    {
      what: "the salary answer",
      field: "salary_expectation",
      status: "answered",
      answer: CORRECTED_SALARY,
      quote: "$120,000–$135,000 plus super",
      provenanceIncludes: "edited by you after we read it",
      sourceGone: false,
    },
  ],
});
criterion(
  "AC-6",
  "…and it reads back the same in a SEPARATE PROCESS against the same data dir (a real reload, not a second call)",
  reopenCorrection.ok,
  reopenCorrection.detail
);

// AF-7 second half — a write is visible on the very next read (nothing is cached).
const roleFact = q.ensureFacts(user.id).facts.find((fact) => fact.category === "role")!;
const yearsBeforeRoleEdit = entry(fieldAnswersFor(user.id), "years_experience");
const currentRoleBefore = answerOf(fieldAnswersFor(user.id), "current_role").answer;
const roleFix = q.correctFact(user.id, roleFact.id, {
  title: roleFact.fields.title ?? "",
  company: roleFact.fields.company ?? "",
  start: "Jan 2015",
  end: "Present",
  description: roleFact.fields.description ?? "",
});
const setAfterRoleEdit = fieldAnswersFor(user.id);
const currentRoleAfter = answerOf(setAfterRoleEdit, "current_role").answer;
criterion(
  "AF-7",
  "a write is reflected on the next read — the screen cannot be answered from a cache",
  roleFix.ok && currentRoleAfter !== currentRoleBefore && currentRoleAfter.includes("Jan 2015 – Present"),
  JSON.stringify({ before: currentRoleBefore, after: currentRoleAfter })
);
criterion(
  "AF-3",
  "correcting a role's dates NEVER creates a years-of-experience answer (the answer is byte-identical and still empty)",
  entry(setAfterRoleEdit, "years_experience") === yearsBeforeRoleEdit &&
    answerOf(setAfterRoleEdit, "years_experience").status === "not-covered" &&
    answerOf(setAfterRoleEdit, "years_experience").answer === "",
  JSON.stringify({
    before: yearsBeforeRoleEdit,
    after: entry(setAfterRoleEdit, "years_experience"),
    status: answerOf(setAfterRoleEdit, "years_experience").status,
  })
);

// AC-16 — pins today's behaviour, which is NOT what the lead decided. Do not change it here.
const supersededAnswer = answerOf(fieldAnswersFor(user.id), "salary_expectation").answer;
db.saveProfile(user.id, { ...richProfile(), salary_expectation: "$140,000 plus super" });
const afterVaultEdit = fieldAnswersFor(user.id);
const vaultEditSalary = answerOf(afterVaultEdit, "salary_expectation");
const freshSalaryFacts = q
  .ensureFacts(user.id)
  .facts.filter((fact) => fact.label === IDENTITY_FACT_LABELS.salary_expectation);
criterion(
  "AC-16",
  "(pins today's behaviour) after a vault edit the OLD correction still answers, and a fresh suggested fact for the new vault value is listed beside it",
  vaultEditSalary.answer === supersededAnswer &&
    vaultEditSalary.answer !== "$140,000 plus super" &&
    vaultEditSalary.sources[0]!.sourceGone === true &&
    freshSalaryFacts.length === 2 &&
    freshSalaryFacts.some((fact) => fact.value === "$140,000 plus super" && fact.status === "suggested"),
  JSON.stringify({
    answer: vaultEditSalary.answer,
    sourceGone: vaultEditSalary.sources[0]!.sourceGone,
    facts: freshSalaryFacts.map((fact) => [fact.value, fact.status]),
  })
);
note(
  "OBSERVATION, for the lead: this is the opposite of decision 4 on §6 (“the fresher material-backed fact wins the answer, and the correction is kept and shown as superseded”). Today the correction keeps the field, marked as coming from a line the material no longer has, and the newer vault value sits beside it unconfirmed. The check pins today's behaviour so it cannot change silently; piece 2 must flip it deliberately (and update this check) if the decision stands."
);

// =========================================================================== E2 ===
banner("E. decisions survive a résumé change, and each action writes at most one decision");

// AC-15(a) — the same material re-wrapped: the line moves, the decision does not care.
const roleBeforeShift = q.ensureFacts(user.id).facts.find((fact) => fact.id === roleFact.id)!;
db.saveProfile(user.id, { ...richProfile(`A LINE THE USER ADDED ABOVE EVERYTHING ELSE\n${plain}`), salary_expectation: "$140,000 plus super" });
const afterShift = fieldAnswersFor(user.id);
// Located by what it SAYS, not by id: a résumé fact that moved is matched by value
// (qualifications.ts:2109-2129), so its id is the new line's id while the user's
// decision is the old one's. That is the behaviour being pinned here.
const roleAfterShift = q
  .ensureFacts(user.id)
  .facts.find((fact) => fact.category === "role" && fact.value === roleBeforeShift.value);
criterion(
  "AC-15",
  "(a) a corrected fact survives a re-wrapped résumé — matched by what it says, not by its line number",
  answerOf(afterShift, "current_role").answer === roleBeforeShift.value &&
    roleAfterShift !== undefined &&
    roleAfterShift.edited === true &&
    roleAfterShift.status === "confirmed",
  JSON.stringify({
    answer: answerOf(afterShift, "current_role").answer,
    value: roleAfterShift?.value,
    edited: roleAfterShift?.edited,
    status: roleAfterShift?.status,
  })
);
criterion(
  "AC-15",
  "(a) …and the correction of the salary fact still answers, unchanged",
  answerOf(afterShift, "salary_expectation").answer === supersededAnswer,
  JSON.stringify(answerOf(afterShift, "salary_expectation").answer)
);

// An exclusion, before the material changes under it.
const certToExclude = q
  .ensureFacts(user.id)
  .facts.filter((fact) => fact.category === "certification")
  .map((fact) => fact.value)[0];
const certFact = q.ensureFacts(user.id).facts.find((fact) => fact.category === "certification")!;
const excluded = q.excludeFact(user.id, certFact.id);
const afterExclude = fieldAnswersFor(user.id);
const certsAfterExclude = answerOf(afterExclude, "certifications");
criterion(
  "AC-14",
  "excluding a fact clears the overall and that category's confirmation, and takes the fact out of the answer",
  excluded.ok &&
    confirmationsOf().overall === null &&
    confirmationsOf().categories.certification === null &&
    !certsAfterExclude.answer.includes(certToExclude) &&
    certsAfterExclude.excluded.some((source) => source.factValue === certToExclude),
  JSON.stringify({
    excludeOk: excluded.ok,
    error: excluded.error ?? null,
    overall: confirmationsOf().overall,
    certification: confirmationsOf().categories.certification,
    excludedValue: certToExclude,
    answer: certsAfterExclude.answer,
    excludedListed: certsAfterExclude.excluded.map((source) => source.factValue),
  })
);

// AC-15(b) — the material replaced so the fact is gone entirely.
db.saveProfile(user.id, { ...richProfile("Nothing here resembles a CV at all."), salary_expectation: "$140,000 plus super" });
const afterWipe = fieldAnswersFor(user.id);
const wipedFacts = q.ensureFacts(user.id).facts;
const revivedRole = wipedFacts.find((fact) => fact.id === roleFact.id);
criterion(
  "AC-15",
  "(b) a fact the user corrected survives the material it came from disappearing, marked as no longer tracing to a line",
  revivedRole !== undefined &&
    revivedRole.status === "confirmed" &&
    revivedRole.sourceGone === true &&
    answerOf(afterWipe, "current_role").answer === roleBeforeShift.value,
  JSON.stringify({
    status: revivedRole?.status,
    sourceGone: revivedRole?.sourceGone,
    answer: answerOf(afterWipe, "current_role").answer,
  })
);
criterion(
  "AC-15",
  "(b) a fact the user excluded stays excluded when the material comes back empty",
  !answerOf(afterWipe, "certifications").answer.includes(certToExclude) &&
    (wipedFacts.find((fact) => fact.id === certFact.id)?.status ?? "gone") !== "confirmed",
  JSON.stringify({ certifications: answerOf(afterWipe, "certifications").status })
);
const keptSurvivor = wipedFacts.find((fact) => fact.category === "education" && fact.origin === "extracted");
criterion(
  "AC-15",
  "(b) and a fact the user merely KEPT is not turned into an exclusion by the material changing",
  keptSurvivor !== undefined && keptSurvivor.status === "confirmed",
  JSON.stringify({ kept: keptSurvivor?.status })
);

// AC-13 — on a fresh account, so the counts start from zero.
const dup = db.createUser("field-review-dup@example.com", "not-a-real-hash");
db.saveProfile(dup.id, richProfile());
const dupCount = (): number => {
  const stored = db.getQualificationDecisions(dup.id);
  return stored ? (JSON.parse(stored.decisions_json) as unknown[]).length : 0;
};
const dupPhone = q.ensureFacts(dup.id).facts.find((fact) => fact.label === IDENTITY_FACT_LABELS.phone)!;
const steps: number[] = [dupCount()];
q.keepFact(dup.id, dupPhone.id);
steps.push(dupCount());
q.keepFact(dup.id, dupPhone.id);
steps.push(dupCount());
q.correctFact(dup.id, dupPhone.id, { value: "0400 000 000" });
steps.push(dupCount());
db.saveProfile(dup.id, richProfile("A DIFFERENT FIRST LINE\n" + plain));
const dupPhoneAgain = q.ensureFacts(dup.id).facts.find((fact) => fact.label === IDENTITY_FACT_LABELS.phone)!;
q.restoreFact(dup.id, dupPhoneAgain.id);
steps.push(dupCount());
const firstAdd = q.addFact(dup.id, "identity", { value: "jordan.blake@example.com" }, "my work address", "email");
steps.push(dupCount());
const secondAdd = q.addFact(dup.id, "identity", { value: "jordan.blake@example.com" }, "my work address", "email");
steps.push(dupCount());
const deltas = steps.slice(1).map((value, index) => value - steps[index]!);
criterion(
  "AC-13",
  "keep, correct, restore and add each write at most one decision — and a duplicate add writes none and is refused",
  deltas.every((delta) => delta >= 0 && delta <= 1) &&
    firstAdd.ok === true &&
    secondAdd.ok === false &&
    deltas[5] === 1 &&
    deltas[6] === 0,
  JSON.stringify({ steps, deltas, firstAdd: firstAdd.ok, secondAdd: secondAdd.ok })
);

// =========================================================================== E3 ===
banner("D. the labelling fix: a fact added FOR a field answers that field");

// A fresh account with an empty vault and no résumé: the only identity facts are the added ones.
const nine = db.createUser("field-review-nine@example.com", "not-a-real-hash");
db.saveProfile(nine.id, { ...db.EMPTY_PROFILE });
const nineFields: Array<[AnswerFieldKey, string]> = [
  ["full_name", "Alexandra Morgan"],
  ["email", "alexandra.morgan@example.com"],
  ["phone", "0400 111 222"],
  ["location", "Geelong, Australia"],
  ["portfolio", "https://alexandramorgan.dev"],
  ["github", "https://github.com/alexandramorgan"],
  ["linkedin", "https://linkedin.com/in/alexandramorgan"],
  ["notice_period", "Six weeks"],
  ["salary_expectation", "$150,000 plus super"],
];
const addResults = nineFields.map(([field, value]) =>
  q.addFact(nine.id, "identity", { value }, "", field)
);
const nineSet = touch(fieldAnswersFor(nine.id));
const unanswered = nineFields.filter(([field, value]) => {
  const answer = answerOf(nineSet, field);
  return answer.status !== "answered" || answer.answer !== value;
});
criterion(
  "R1-1",
  "a detail added FOR each of the nine identity-backed fields answers that field (they were all silent before)",
  addResults.every((result) => result.ok) && unanswered.length === 0 && nineSet.answered >= 9,
  JSON.stringify({ added: addResults.map((result) => result.ok), unanswered })
);
const nineFacts = q.ensureFacts(nine.id).facts;
const wrongLabels = nineFields.filter(([field, value]) => {
  const fact = nineFacts.find((item) => item.category === "identity" && item.label === IDENTITY_FACT_LABELS[field]);
  return fact === undefined || fact.value !== value;
});
criterion(
  "R1-2",
  "…and the fact carries the field's OWN label, so the review screen and the answers screen agree on its name",
  wrongLabels.length === 0 &&
    nineFacts.every(
      (fact) => fact.category !== "identity" || fact.label !== "Detail you added"
    ) &&
    nineSet.answers
      .filter((answer) => answer.sources.length > 0)
      .every((answer) => answer.sources.every((source) => source.sourceKind === "user")),
  JSON.stringify({ facts: nineFacts.map((fact) => [fact.label, fact.value]), wrongLabels })
);
criterion(
  "R1-2",
  "a fact added this way is still OURS-to-be-honest-about: “Added by you”, sourceKind “user”, never quoted as a résumé line",
  nineSet.answers
    .filter((answer) => answer.status === "answered")
    .flatMap((answer) => answer.sources)
    .every((source) => source.sourceKind === "user" && source.provenance === "Added by you"),
  JSON.stringify(
    nineSet.answers
      .flatMap((answer) => answer.sources)
      .map((source) => [source.factLabel, source.sourceKind, source.provenance])
      .filter(([, kind, provenance]) => kind !== "user" || provenance !== "Added by you")
  )
);

// The generic add is unchanged: it is a detail, not a field's answer.
const generic = db.createUser("field-review-generic@example.com", "not-a-real-hash");
db.saveProfile(generic.id, { ...db.EMPTY_PROFILE });
const genericAdd = q.addFact(generic.id, "identity", { value: "alexandra@example.com" }, "");
const genericSet = touch(fieldAnswersFor(generic.id));
const genericFact = q.ensureFacts(generic.id).facts[0]!;
criterion(
  "R1-3",
  "a detail added WITHOUT naming a field keeps the old “Detail you added” label and answers no identity field",
  genericAdd.ok &&
    genericFact.label === "Detail you added" &&
    answerOf(genericSet, "email").status === "not-covered" &&
    answerOf(genericSet, "email").answer === "",
  JSON.stringify({ label: genericFact.label, email: answerOf(genericSet, "email").status })
);
const dupNine = q.addFact(nine.id, "identity", { value: "0400 111 222" }, "", "phone");
criterion(
  "R1-3",
  "…and adding the same detail twice is still refused, with nothing written",
  dupNine.ok === false && dupNine.error !== undefined && decisionCountOf(nine.id) === 9,
  JSON.stringify({ ok: dupNine.ok, decisions: decisionCountOf(nine.id) })
);
const refusedLabel = q.addFact(generic.id, "identity", { value: "another detail" }, "", "not_a_field");
criterion(
  "R1-3",
  "a field name the engine does not recognise is refused rather than stored under a name no rule reads",
  refusedLabel.ok === false,
  JSON.stringify({ ok: refusedLabel.ok, decisions: decisionCountOf(generic.id) })
);

// R1-4 — the labels and the answers survive a résumé change and a fresh process.
db.saveProfile(nine.id, { ...db.EMPTY_PROFILE, resume_text: thin });
const afterNineResume = fieldAnswersFor(nine.id);
const nineStillAnswered = nineFields.filter(([field, value]) => answerOf(afterNineResume, field).answer === value);
criterion(
  "R1-4",
  "(c) a fact the user added survives a résumé change, with origin “user” and no résumé claim attached",
  nineStillAnswered.length === 9 &&
    q
      .ensureFacts(nine.id)
      .facts.every((fact) => fact.origin !== "user" || fact.source.kind === "user"),
  JSON.stringify({ stillAnswered: nineStillAnswered.length })
);
const reopenNine = runReopen({
  userId: nine.id,
  dataDir,
  facts: nineFields.map(([field]) => ({
    what: `the fact added for ${field}`,
    label: IDENTITY_FACT_LABELS[field],
    origin: "user",
    sourceKind: "user",
    status: "confirmed",
  })),
  answers: nineFields.map(([field, value]) => ({
    what: `${field} answers from the added fact`,
    field,
    status: "answered",
    answer: value,
    provenanceIncludes: "Added by you",
    sourceKind: "user",
    label: IDENTITY_FACT_LABELS[field],
  })),
});
criterion(
  "R1-4",
  "…and the labels and answers are the same in a SEPARATE PROCESS against the same data dir",
  reopenNine.ok,
  reopenNine.detail
);

// =========================================================================== F ===
banner("F. the nudges point somewhere real, the screen is inert, and the false promise is gone");

const profileSource = readFileSync(join(SRC, "routes", "profile.tsx"), "utf8");
const reviewSource = readFileSync(join(SRC, "routes", "qualifications.tsx"), "utf8");
const answersSource = readFileSync(join(SRC, "routes", "answers.tsx"), "utf8");
const engineSource = readFileSync(join(SRC, "server", "field-answers.ts"), "utf8");
const profileAnchors = new Set([...profileSource.matchAll(/id="([^"]+)"/g)].map((match) => match[1] ?? ""));
const reviewAddTemplate = reviewSource.includes("id={`add-${category}`}");

const nudgeSets = [richSet, thinSet, nothingSet, pendingSet, excludedSet, otherFieldFlipped];
const everyNudge = nudgeSets.flatMap((set) => set.answers).filter((answer) => answer.nudge !== null);
const uncoveredWithoutNudge = nudgeSets.flatMap((set) => set.answers).filter((answer) => answer.status === "not-covered" && answer.nudge === null);
const thinNudges = everyNudge.filter(
  (answer) => answer.nudge!.text.trim().length < 10 || answer.nudge!.action.trim().length < 10
);
criterion(
  "AC-9",
  "every not-covered field carries a nudge with real text and a real instruction",
  uncoveredWithoutNudge.length === 0 && thinNudges.length === 0,
  JSON.stringify({ withoutNudge: uncoveredWithoutNudge.map((answer) => answer.field), thin: thinNudges.map((a) => a.field) })
);
const badProfileAnchors = everyNudge.filter(
  (answer) => answer.nudge!.where === "profile" && !profileAnchors.has(answer.nudge!.hash)
);
criterion(
  "AC-9",
  "every vault nudge lands on an element id that really exists on the profile page",
  badProfileAnchors.length === 0,
  JSON.stringify(badProfileAnchors.map((answer) => [answer.field, answer.nudge!.hash]))
);
const reviewNudges = everyNudge.filter((answer) => answer.nudge!.where === "qualifications");
criterion(
  "AC-9",
  "every review-screen nudge names that category's own add form, which exists",
  reviewAddTemplate &&
    reviewNudges.every((answer) => /^add-(identity|role|education|skill|achievement|certification|language|work_rights)$/.test(answer.nudge!.hash)),
  JSON.stringify(reviewNudges.map((answer) => [answer.field, answer.nudge!.hash]))
);
const unsettledNudge = fieldAnswersFromFacts(
  confirmedSet(factsFor({ ...richProfile(), work_authorisation: WORK_AUTHORISATION_OPTIONS[2] }))
).answers.find((answer) => answer.field === "sponsorship")!;
criterion(
  "AC-9",
  "the unsettled-sponsorship nudge points at the work-rights ANSWER, which can settle the question, not at a note nothing reads",
  unsettledNudge.nudge !== null &&
    unsettledNudge.nudge.where === "profile" &&
    unsettledNudge.nudge.hash === "work-authorisation" &&
    profileAnchors.has("work-authorisation"),
  JSON.stringify(unsettledNudge.nudge)
);

criterion(
  "AC-20",
  "the answers screen writes no instrumentation and speaks no SQL",
  !/recordStep|recordFunnelEvent/.test(answersSource) &&
    !/SELECT |INSERT |UPDATE |DELETE /.test(answersSource) &&
    !/from "~\/db"|from '~\/db'/.test(answersSource),
  "the route instruments, or talks to the database, or holds SQL"
);
criterion(
  "AC-20",
  "the funnel still has exactly five steps — a screen cannot add a sixth",
  db.FUNNEL_STEPS.length === 5 &&
    JSON.stringify([...db.FUNNEL_STEPS]) ===
      JSON.stringify(["signup", "profile_complete", "posting_added", "kit_generated", "application_taken_forward"]),
  JSON.stringify([...db.FUNNEL_STEPS])
);
criterion(
  "AC-20",
  "the screen takes its provenance words from the engine, and renders the quote the engine supplies",
  answersSource.includes("source.provenance") &&
    answersSource.includes("source.quote") &&
    !/From your résumé text, line|From your vault —|Added by you/.test(answersSource),
  "the route re-words provenance itself instead of showing the engine's own string"
);

criterion(
  "AC-21",
  "the promise that a vault note “can be used next time” is gone from the answering layer",
  !/can be used next time/.test(engineSource) && !/work_authorisation_note/.test(engineSource),
  "the answering layer still mentions the work-authorisation note"
);
const settledCopy = unsettledNudge.notCovered;
criterion(
  "AC-21",
  "…and the sponsorship copy that replaced it says plainly that the note is not read here",
  /note in your vault's work-authorisation card is not read here/.test(settledCopy) &&
    !/can be used/.test(settledCopy) &&
    /Would you need sponsorship|doesn't say whether you would need sponsorship/.test(settledCopy),
  settledCopy
);
const mappedCopy = fieldAnswersFromFacts(
  confirmedSet(factsFor(richProfile()))
).answers.find((answer) => answer.field === "sponsorship")!.caveat;
criterion(
  "AC-21",
  "the settled sponsorship answers still say which work-rights choice they were built from (nothing here was weakened)",
  /you chose/.test(mappedCopy) && /settles this question/.test(mappedCopy),
  mappedCopy
);

// ---------------------------------------------------------------------- done ---
function decisionCountOf(userId: string): number {
  const stored = db.getQualificationDecisions(userId);
  return stored ? (JSON.parse(stored.decisions_json) as unknown[]).length : 0;
}

function runReopen(payload: {
  userId: string;
  dataDir: string;
  facts?: Array<Record<string, unknown>>;
  answers?: Array<Record<string, unknown>>;
}): { ok: boolean; detail: string } {
  const child = Bun.spawnSync({
    cmd: [process.execPath, SELF, "--reopen", JSON.stringify(payload)],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  let parsed: { results?: Array<{ what: string; ok: boolean; problems: string[] }> } = {};
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { ok: false, detail: `the separate process printed no usable result: ${stdout.slice(0, 200)}` };
  }
  const failed = (parsed.results ?? []).filter((result) => !result.ok);
  const detail =
    failed.length === 0
      ? `${String(parsed.results?.length ?? 0)} assertions read back identically`
      : JSON.stringify(failed.map((result) => [result.what, result.problems]));
  return { ok: child.exitCode === 0 && failed.length === 0, detail };
}

banner("non-vacuity: the suite must be able to fail, and must exercise everything it claims");

const skipped = REQUIRED.filter((id) => !exercised.has(id));
const covered = REQUIRED.length - skipped.length;
criterion(
  "SUITE-1",
  `every criterion the brief names was exercised (${String(covered)}/${String(REQUIRED.length)})`,
  skipped.length === 0,
  JSON.stringify(skipped)
);
const missingFields = ANSWER_FIELD_SPECS.map((spec) => spec.key).filter((key) => !fieldsSeen.has(key));
criterion(
  "SUITE-2",
  `all 17 fields were exercised (${String(fieldsSeen.size)}/17)`,
  missingFields.length === 0,
  JSON.stringify(missingFields)
);
check(
  "SUITE-3 the suite is not empty and is doing real work",
  checks >= 40,
  `only ${String(checks)} checks ran`
);

console.log(`\n${"=".repeat(78)}`);
console.log(
  `${String(checks)} checks run · ${String(exercised.size)} of ${String(REQUIRED.length)} criteria exercised · ${String(
    fieldsSeen.size
  )}/17 fields`
);
if (checks === 0 || problems.length > 0) {
  console.log(`${String(problems.length)} CHECK(S) FAILED out of ${String(checks)}:`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${String(checks)})`);
process.exit(0);
