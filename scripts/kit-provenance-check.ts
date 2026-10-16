/**
 * The kit's provenance check — `bun run scripts/kit-provenance-check.ts`.
 *
 * The kit is the artefact a user copies into a real application form, so it answers
 * by the SAME standard as the answers screen: only facts the user confirmed, each
 * restated in their own words. This suite fails if that stops being true.
 *
 * What it proves, and how:
 *
 *   A. THE GATE (K-gate 1 … 7) — the kit is built from `fieldAnswersFromFacts`, so
 *      a fact the user EXCLUDED and a vault value they never confirmed are both
 *      absent from the whole serialized kit, and the drafts say so in words and
 *      point at the review screen. One exclusion case is deliberately blunt: a value
 *      that is not one of the posting's own keyword names must not appear ANYWHERE
 *      in the kit. With nothing confirmed the kit states nothing about the user at
 *      all and says that plainly instead of generating from raw text.
 *
 *   B. THE PANEL (K-panel 1 … 2) — "Material from your profile that the kit drew on"
 *      lists exactly what the kit drew on: every fact whose value appears in the
 *      letter, the answers or an evidence quote is listed, and every listed fact's
 *      value appears in the letter or the answers. Both directions are checked,
 *      because either one alone is trivial.
 *
 *   C. NO ARITHMETIC (K-dates 1 … 3) — nothing in the kit's text produces a
 *      years-of-experience figure that is not a phrase from the posting or from a
 *      fact the user confirmed; and the generator's own source reads no raw vault
 *      field, no profile array and no calendar year, so the arithmetic has nowhere
 *      to come back from.
 *
 *   D. THE SCREEN (K-copy 1 … 4) — the kit page no longer makes a completeness claim
 *      in words, no longer contradicts the "other questions" card, and every gap it
 *      renders links to an anchor that exists on the page it points at.
 *
 *   E. THROUGH THE REAL MODULE (K-storage 1 … 3) — on a throwaway data dir, the fact
 *      set the app hands the generator (`qualifications.ensureFacts`) is the one it
 *      gates on: a fresh account gets a kit with nothing confirmed in it, confirming
 *      everything fills the panel, and excluding one fact takes that value out of
 *      the kit.
 *
 * NON-VACUITY. Every criterion above is also run against deliberately broken copies
 * of the code — the tree is copied to a temp dir, one surgical edit is applied, and
 * the check is re-run there as a subprocess. Each mutation must be CAUGHT by the
 * criterion it targets (a crash or an unrelated failure does not count), and each
 * mutation must actually change the file. Same approach as the companion block in
 * `scripts/postgres-check.ts`. A final run with `--no-mutants` skips that phase.
 *
 * HONEST LIMITS. See the note printed at the end of the run: the blunt exclusion scan
 * cannot tell a leak from a posting keyword that happens to share a word with the
 * excluded value, which is why one named case is asserted separately; and this suite
 * says nothing about whether the kit is *useful*, only about what it is allowed to
 * state.
 *
 * Exits non-zero on any failure. Run: `bun run scripts/kit-provenance-check.ts`
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES = join(HERE, "fixtures");

// The storage tier needs its own data directory, set BEFORE the storage module is
// imported (see `scripts/field-review-check.ts`, which does the same).
const dataDir = mkdtempSync(join(tmpdir(), "applypilot-kit-provenance-"));
process.env.APPLYPILOT_DATA_DIR = dataDir;

const problems: string[] = [];
let checks = 0;
const exercised = new Map<string, number>();

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

// ------------------------------------------------------------------ fixtures ---

const plain = readFileSync(join(FIXTURES, "resume-plain.txt"), "utf8");
const AT = "2026-10-16T12:00:00.000Z";
const NOW = new Date("2026-10-16T12:00:00.000Z");

/** A posting that asks for years, skills, a degree, links and work rights. */
const POSTING = [
  "Senior Product Analyst — Northwind Financial",
  "We are looking for 5+ years of experience in product analytics.",
  "You will need SQL, Python, dbt and Looker, and experience running A/B testing.",
  "Experience with stakeholder management and Tableau is a plus.",
  "A bachelor's degree is required.",
  "You must have the right to work in Australia; we cannot sponsor.",
  "Apply with your portfolio or GitHub.",
].join("\n");

const db = await import("../src/db");
const q = await import("../src/server/qualifications");
const fa = await import("../src/server/field-answers");
const gen = await import("../src/server/generate");
const types = await import("../src/types");

type Fact = types.Fact;
type Decision = types.FactDecision;

/** The vault a well-filled account has, over the plain fixture résumé. */
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
    work_authorisation: types.WORK_AUTHORISATION_OPTIONS[0]!,
    work_authorisation_note: "Permanent resident since 2021",
    salary_expectation: "$120,000–$135,000 plus super",
    notice_period: "4 weeks",
  };
}

function baseFactsFor(profile: db.Profile): Fact[] {
  return q.extractFacts(q.inputFromProfile(profile)).facts;
}

function keepDecision(fact: Fact): Decision {
  return {
    id: fact.id,
    category: fact.category,
    action: "keep",
    snapshot: q.snapshotOf(fact),
    valueKey: types.factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  };
}

function excludeDecision(fact: Fact): Decision {
  return {
    id: fact.id,
    category: fact.category,
    action: "exclude",
    valueKey: types.factValueKey(fact.category, fact.originalValue ?? fact.value),
    at: AT,
  };
}

/** Everything in the set confirmed, except the facts the caller excludes. */
function confirmedExcept(base: Fact[], isExcluded: (fact: Fact) => boolean): Fact[] {
  const decisions = base
    .filter((fact) => !isExcluded(fact))
    .map((fact) => keepDecision(fact))
    .concat(base.filter(isExcluded).map(excludeDecision));
  return q.applyDecisions(base, decisions).facts;
}

/**
 * Everything confirmed except the matcher's facts, which get NO decision at all —
 * the state a vault field is really in before the user confirms it (a fact is
 * `suggested` until they do, not excluded by default).
 */
function withUntouched(base: Fact[], isUntouched: (fact: Fact) => boolean): Fact[] {
  const decisions = base.filter((fact) => !isUntouched(fact)).map((fact) => keepDecision(fact));
  return q.applyDecisions(base, decisions).facts;
}

/** The kit as the app builds it: the fact set in, the kit out. */
function kitFor(facts: Fact[], posting = POSTING, application = {}) {
  return gen.generateKit({
    facts,
    application: {
      title: "Senior Product Analyst",
      company: "Northwind Financial",
      url: "https://example.com/jobs/1",
      posting_text: posting,
      ...application,
    },
    now: NOW,
  });
}

/** Every surface of the kit that says something — used for leak scans. */
function kitSurfaces(kit: types.Kit): string[] {
  return [
    kit.coverLetter,
    ...kit.answers.map((answer) => answer.answer),
    ...kit.answers.map((answer) => answer.sources.join("\n")),
    ...kit.keywordMatch.evidenced.map((hit) => hit.evidence),
    ...kit.gaps.map((gap) => gap.text),
    ...kit.gaps.map((gap) => gap.action),
    ...kit.profileFactsUsed,
  ];
}

/**
 * The kit's own names for the posting's keywords. A value that is one of these can
 * legitimately appear in the kit as a *requirement the posting makes* — "the posting
 * asks for Looker and nothing you confirmed mentions it" is a statement about the
 * posting, not about the user. The leak scan removes these strings first; the case
 * that matters (K-gate 2) uses a value that is NOT one of them and is scanned bluntly.
 */
function postingTerms(kit: types.Kit): string[] {
  return [...kit.keywordMatch.evidenced.map((hit) => hit.keyword), ...kit.keywordMatch.missing.map((gap) => gap.keyword)];
}

function withoutPostingTerms(kit: types.Kit, text: string): string {
  let out = text;
  for (const term of postingTerms(kit)) out = out.split(term).join(" ");
  return out;
}

function answerOf(kit: types.Kit, question: string): types.KitAnswer {
  const found = kit.answers.find((answer) => answer.question === question);
  if (!found) throw new Error(`the kit drafted no answer for ${question}`);
  return found;
}

const SALARY_Q = "What are your salary expectations?";
const NOTICE_Q = "What's your notice period?";
const WORK_Q = "What's your work authorisation / visa status?";

// ======================================================================= A ===
banner("A. the kit answers only from facts the user confirmed");

const base = baseFactsFor(richProfile());
const allConfirmed = q.applyDecisions(base, base.map(keepDecision)).facts;
const fullKit = kitFor(allConfirmed);
const fullFactsUsed = fullKit.profileFactsUsed.join("\n");

criterion(
  "K-gate 1",
  `a fully confirmed account gets a kit built from real material (${String(fullKit.profileFactsUsed.length)} facts listed, ${String(fullKit.factBasis?.confirmed ?? -1)} confirmed)`,
  fullKit.profileFactsUsed.length >= 15 &&
    fullKit.factBasis?.confirmed === allConfirmed.length &&
    fullKit.coverLetter.includes("Alex Morgan") &&
    fullKit.coverLetter.includes("Northwind Financial"),
  JSON.stringify({ listed: fullKit.profileFactsUsed.length, basis: fullKit.factBasis })
);

criterion(
  "K-gate 1",
  "the kit draws on facts, not on the raw vault: it stamps the basis it was allowed to use",
  fullKit.factBasis?.nothingConfirmed === false &&
    fullKit.factBasis?.factsInSet === base.length &&
    fullKit.factBasis?.excluded === 0,
  JSON.stringify(fullKit.factBasis)
);

// -- an excluded fact, bluntly -------------------------------------------------
// The education fact's value is not a posting keyword, so this one can be scanned
// against the WHOLE serialized kit with no allowances at all.
const educationFact = base.find((fact) => fact.category === "education")!;
const excludedEducation = confirmedExcept(base, (fact) => fact.id === educationFact.id);
const noEducationKit = kitFor(excludedEducation);
const noEducationJson = JSON.stringify(noEducationKit);

criterion(
  "K-gate 2",
  "a fact the user EXCLUDED appears nowhere in the kit — not in the letter, an answer, a gap, or the panel",
  !noEducationJson.includes(educationFact.value) && !noEducationJson.includes(educationFact.quote),
  JSON.stringify({ value: educationFact.value, inLetter: noEducationKit.coverLetter.includes(educationFact.value) })
);
criterion(
  "K-gate 2",
  "and the letter that would have quoted it is gone, rather than silently rewritten",
  !noEducationKit.coverLetter.includes("I studied"),
  noEducationKit.coverLetter
);
criterion(
  "K-gate 2",
  "the exclusion is named where it belongs — a gap that sends the user to the review screen",
  noEducationKit.gaps.some(
    (gap) => gap.text.includes("your education") && gap.where === "qualifications" && !gap.text.includes(educationFact.value)
  ),
  JSON.stringify(noEducationKit.gaps.filter((gap) => gap.text.includes("education")).map((gap) => gap.text))
);

// -- an excluded fact whose value is also a posting keyword --------------------
const lookerFact = base.find((fact) => fact.value === "Looker")!;
const excludedSkill = confirmedExcept(base, (fact) => fact.id === lookerFact.id);
const noLookerKit = kitFor(excludedSkill);
const stripped = withoutPostingTerms(noLookerKit, kitSurfaces(noLookerKit).join("\n"));

criterion(
  "K-gate 3",
  "an excluded fact whose value IS a posting keyword is never presented as something the user has",
  !stripped.includes(lookerFact.value) &&
    !noLookerKit.profileFactsUsed.some((line) => line.includes(lookerFact.value)) &&
    !noLookerKit.keywordMatch.evidenced.some((hit) => hit.evidence.includes(lookerFact.value)),
  JSON.stringify({
    evidenced: noLookerKit.keywordMatch.evidenced.map((hit) => hit.keyword),
    listed: noLookerKit.profileFactsUsed.filter((line) => line.includes("Looker")),
  })
);
criterion(
  "K-gate 3",
  "and the posting's requirement for it is still named as missing — the exclusion is not hidden, it is reported",
  noLookerKit.keywordMatch.missing.some((gap) => gap.keyword === "Looker"),
  JSON.stringify(noLookerKit.keywordMatch.missing.map((gap) => gap.keyword))
);

// -- an excluded role ----------------------------------------------------------
const newestRole = fa.rolesMostRecentFirst(base)[0]!;
const excludedRole = confirmedExcept(base, (fact) => fact.id === newestRole.id);
const noRoleKit = kitFor(excludedRole);

criterion(
  "K-gate 4",
  "excluding the most recent role takes it out of the letter and the drafts, and does not substitute an older one",
  !JSON.stringify(noRoleKit).includes(newestRole.value) &&
    !noRoleKit.coverLetter.includes("My most recent role is") &&
    !noRoleKit.profileFactsUsed.some((line) => line.includes(newestRole.value)),
  JSON.stringify({
    role: newestRole.value,
    rolesListed: noRoleKit.profileFactsUsed.filter((line) => line.startsWith("Role:")),
  })
);
criterion(
  "K-gate 4",
  "and the kit says the role is missing rather than writing around it",
  noRoleKit.gaps.some((gap) => gap.text.includes("your most recent role")),
  JSON.stringify(noRoleKit.gaps.map((gap) => gap.text.slice(0, 60)))
);

// -- a vault value the user has not confirmed ---------------------------------
const unconfirmedVault = withUntouched(
  base,
  (fact) => fact.category === "work_rights" || ["$120,000–$135,000 plus super", "4 weeks"].includes(fact.value)
);
const unconfirmedKit = kitFor(unconfirmedVault);
const unconfirmedJson = JSON.stringify(unconfirmedKit);
const unconfirmedAnswers = fa.fieldAnswersFromFacts(unconfirmedVault);
const salaryAnswer = answerOf(unconfirmedKit, SALARY_Q);
const noticeAnswer = answerOf(unconfirmedKit, NOTICE_Q);
const workAnswer = answerOf(unconfirmedKit, WORK_Q);

criterion(
  "K-gate 5",
  "a vault value the user never confirmed is not stated anywhere in the kit (salary, notice, work rights)",
  !unconfirmedJson.includes("120,000") &&
    !unconfirmedJson.includes("4 weeks") &&
    !unconfirmedJson.includes(types.WORK_AUTHORISATION_OPTIONS[0]!),
  JSON.stringify({
    salary: unconfirmedJson.includes("120,000"),
    notice: unconfirmedJson.includes("4 weeks"),
    work: unconfirmedJson.includes(types.WORK_AUTHORISATION_OPTIONS[0]!),
  })
);
criterion(
  "K-gate 5",
  "and the three drafts say it is unconfirmed material rather than settled material",
  salaryAnswer.basis === "pending" &&
    noticeAnswer.basis === "pending" &&
    workAnswer.basis === "pending" &&
    salaryAnswer.missingInput &&
    /review screen/i.test(salaryAnswer.answer) &&
    salaryAnswer.sources.length === 0,
  JSON.stringify({ salary: salaryAnswer.basis, notice: noticeAnswer.basis, work: workAnswer.basis })
);
criterion(
  "K-gate 5",
  "the kit's gate and the answers screen's gate agree on every field of the same fact set",
  unconfirmedAnswers.answers
    .filter((answer) => ["salary_expectation", "notice_period", "work_rights"].includes(answer.field))
    .every((answer) => answer.status === "pending" && answer.answer === ""),
  JSON.stringify(
    unconfirmedAnswers.answers
      .filter((answer) => ["salary_expectation", "notice_period", "work_rights"].includes(answer.field))
      .map((answer) => [answer.field, answer.status, answer.answer])
  )
);
criterion(
  "K-gate 6",
  "a gap points at the review screen for each of them, naming what is waiting",
  ["salary expectation", "notice period", "work authorisation"].every((subject) =>
    unconfirmedKit.gaps.some((gap) => gap.text.includes(subject) && gap.where === "qualifications")
  ),
  JSON.stringify(unconfirmedKit.gaps.filter((gap) => gap.where === "qualifications").map((gap) => gap.text.slice(0, 70)))
);

// -- nothing confirmed at all --------------------------------------------------
const freshKit = kitFor(base);
const freshStripped = withoutPostingTerms(freshKit, kitSurfaces(freshKit).join("\n"));
const leakedOnFresh = base
  .filter((fact) => fact.value.length >= 6)
  .filter((fact) => freshStripped.includes(fact.value))
  .map((fact) => fact.value);

criterion(
  "K-gate 7",
  "with NOTHING confirmed the kit states nothing about the user at all",
  leakedOnFresh.length === 0 && freshKit.profileFactsUsed.length === 0,
  JSON.stringify(leakedOnFresh.slice(0, 5))
);
criterion(
  "K-gate 7",
  "and says so plainly, in the letter, in the answers and in a gap that sends them to the review screen",
  freshKit.factBasis?.nothingConfirmed === true &&
    /No cover letter yet/i.test(freshKit.coverLetter) &&
    freshKit.answers.every((answer) => answer.basis !== "confirmed") &&
    freshKit.gaps.some((gap) => gap.where === "qualifications" && /[Nn]othing you have confirmed has gone into this kit/.test(gap.text)),
  JSON.stringify({ basis: freshKit.factBasis, gaps: freshKit.gaps.length })
);

// ======================================================================= B ===
banner("B. the facts-used panel is exactly what the kit drew on");

// Direction (a): anything the kit said with a fact's own words is listed.
const voiceSurfaces = [
  fullKit.coverLetter,
  ...fullKit.answers.map((answer) => `${answer.answer}\n${answer.sources.join("\n")}`),
  ...fullKit.keywordMatch.evidenced.map((hit) => hit.evidence),
].join("\n");
const usedButUnlisted = allConfirmed
  .filter((fact) => fact.value.length >= 6 && voiceSurfaces.includes(fact.value))
  .filter((fact) => !fullFactsUsed.includes(fact.value))
  .map((fact) => fact.value);

criterion(
  "K-panel 1",
  `every fact the kit used is listed in the panel (${String(fullKit.profileFactsUsed.length)} listed)`,
  usedButUnlisted.length === 0,
  JSON.stringify(usedButUnlisted.slice(0, 5))
);

// The evidence quotes are the one place a fact can be used with nothing else naming
// it, so they are asserted directly rather than left to the scan above.
const evidenceNotListed = fullKit.keywordMatch.evidenced
  .filter((hit) => !fullFactsUsed.includes(hit.evidence))
  .map((hit) => hit.keyword);
criterion(
  "K-panel 1",
  `the fact behind every evidence quote is listed as well (${String(fullKit.keywordMatch.evidenced.length)} quotes)`,
  evidenceNotListed.length === 0,
  JSON.stringify(evidenceNotListed)
);

// Direction (b): every listed fact was actually used, and nothing else is claimed.
const listedButUnused = [fullKit, unconfirmedKit, noLookerKit]
  .flatMap((kit) => kit.profileFactsUsed)
  .filter((line) => {
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (value.length < 4) return false;
    const owner = [fullKit, unconfirmedKit, noLookerKit].find((kit) => kit.profileFactsUsed.includes(line))!;
    return !`${owner.coverLetter}\n${owner.answers.map((answer) => answer.answer).join("\n")}`.includes(value);
  });

criterion(
  "K-panel 2",
  "and nothing is listed that the kit did not draw on",
  listedButUnused.length === 0,
  JSON.stringify(listedButUnused.slice(0, 5))
);
criterion(
  "K-panel 2",
  "the panel and the answers' own 'Drawn from' lines name the same facts",
  fullKit.answers
    .filter((answer) => answer.basis === "confirmed")
    .every((answer) => answer.sources.every((source) => fullFactsUsed.includes(source))),
  JSON.stringify(fullKit.answers.filter((answer) => answer.basis === "confirmed" && answer.sources.some((source) => !fullFactsUsed.includes(source))).map((answer) => answer.question))
);

// ======================================================================= C ===
banner("C. no arithmetic over dates, anywhere in the kit path");

const allText = kitSurfaces(fullKit).concat(kitSurfaces(unconfirmedKit)).join("\n");
// The statements themselves: the letter, the drafted answers and the gap texts. Gap
// ACTIONS are left out on purpose — they are instructions to the user ("add it as a
// detail, for example “6 years of experience”"), not claims about them.
const statedText = [
  fullKit.coverLetter,
  ...fullKit.answers.map((answer) => answer.answer),
  ...unconfirmedKit.coverLetter ? [unconfirmedKit.coverLetter] : [],
  ...unconfirmedKit.answers.map((answer) => answer.answer),
  ...[fullKit, unconfirmedKit].flatMap((kit) => kit.gaps.map((gap) => gap.text)),
].join("\n");
const yearsPhrases = statedText.match(/\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\b[^.]{0,40}/gi) ?? [];
const userStated = [...base.map((fact) => fact.value), plain, POSTING].join("\n");
const invented = yearsPhrases
  .filter((phrase) => !userStated.includes(phrase.trim().replace(/[.,;:]$/, "")))
  .filter((phrase) => !userStated.includes(phrase.split("\n")[0]!.replace(/[.,;:]$/, "")));

criterion(
  "K-dates 1",
  "no years-of-experience figure appears in the kit that the posting or the user's own material does not state",
  invented.length === 0,
  JSON.stringify({ phrases: yearsPhrases.slice(0, 6), invented: invented.slice(0, 3) })
);
criterion(
  "K-dates 1",
  "with dated roles from 2018 and a posting asking for 5+ years, the kit still states no computed number",
  fullKit.answers.every((answer) => !/\b\d{1,2}\s+years\b/i.test(answer.answer)) &&
    !/\badd (?:up|s up) to\b/i.test(allText),
  JSON.stringify(fullKit.answers.filter((answer) => /\b\d{1,2}\s+years\b/i.test(answer.answer)).map((answer) => answer.answer))
);
criterion(
  "K-dates 1",
  "and a posting's years requirement is answered by asking for the user's own words, never by comparing numbers",
  fullKit.gaps.some(
    (gap) => /posting asks for around 5\+ years/.test(gap.text) && /how many years of experience you have/.test(gap.text)
  ) &&
    !/\b(?:adds? up to|add up|totals?|amounts? to|meets?|satisf(?:y|ies)|falls? short|more than enough)\b/i.test(
      allText
    ),
  JSON.stringify(fullKit.gaps.filter((gap) => /years/.test(gap.text)).map((gap) => gap.text))
);

const generateSource = readFileSync(join(ROOT, "src", "server", "generate.ts"), "utf8");
const actionsSource = readFileSync(join(ROOT, "src", "server", "actions.ts"), "utf8");

/**
 * The source-level invariants behind C. Kept as a function of the source text so the
 * control block below can plant each forbidden pattern and prove each is caught.
 */
function sourceComplaints(generateText: string, actionsText: string): string[] {
  const found: string[] = [];
  for (const match of generateText.matchAll(/\bprofile\.[a-z_]+/g)) {
    found.push(`generate.ts reads a raw vault field: ${match[0]}`);
  }
  if (/\bprofileCorpus\s*\(/.test(generateText)) found.push("generate.ts still builds a corpus from the raw profile");
  if (/estimateExperienceYears/.test(generateText)) found.push("generate.ts still has the years arithmetic");
  if (/getFullYear\s*\(/.test(generateText)) found.push("generate.ts reads a calendar year — a duration could be computed from it");
  if (/:\s*Profile\b/.test(generateText)) found.push("generate.ts still takes a raw Profile");
  if (/\bprofile\s*:\s*db\.getProfile/.test(actionsText)) found.push("actions.ts still hands the generator the raw profile");
  if (!/generateKit\(\{\s*facts:/.test(actionsText)) found.push("actions.ts does not pass a fact set to generateKit");
  return found;
}

const complaints = sourceComplaints(generateSource, actionsSource);
criterion(
  "K-dates 2",
  "the generator's source cannot reach the raw vault, the profile arrays or a calendar year",
  complaints.length === 0,
  JSON.stringify(complaints)
);
criterion(
  "K-dates 3",
  "and the code that calls it hands over the same confirmed fact set the answers screen uses",
  /generateKit\(\{ facts: qualifications\.ensureFacts\(user\.id\)\.facts/.test(actionsSource),
  actionsSource.includes("generateKit({ profile") ? "still passes the raw profile" : ""
);

// ======================================================================= D ===
banner("D. the kit screen says only what the code now does");

const kitSource = readFileSync(join(ROOT, "src", "routes", "kit.$id.tsx"), "utf8");
const profileSource = readFileSync(join(ROOT, "src", "routes", "profile.tsx"), "utf8");
const reviewSource = readFileSync(join(ROOT, "src", "routes", "qualifications.tsx"), "utf8");

criterion(
  "K-copy 1",
  "the panel's completeness claim in words is gone, replaced by the heading the lead decided",
  !kitSource.includes("Everything the kit used came from here") &&
    kitSource.includes("Material from your profile that the kit drew on"),
  "old hint or new heading missing"
);
criterion(
  "K-copy 2",
  "the empty-gaps card no longer claims every requirement was checked, and no longer contradicts the other-questions card",
  !kitSource.includes("every requirement this posting mentions") &&
    kitSource.includes("Nothing flagged in what the kit checked") &&
    /doesn&apos;t check the rest of the posting/.test(kitSource),
  "old claim still present"
);
criterion(
  "K-copy 3",
  "the screen tells the user when nothing is confirmed instead of showing a kit that looks real",
  kitSource.includes("Nothing to write from yet") && kitSource.includes("factBasis?.nothingConfirmed"),
  "no nothing-confirmed state on the kit screen"
);
criterion(
  "K-copy 4",
  "the cover letter and answers cards no longer claim a basis the kit doesn't have",
  !kitSource.includes("Written from your profile text and this posting only") &&
    !kitSource.includes("Nothing saved for this yet") &&
    kitSource.includes("Written from the facts you confirmed"),
  "stale copy on the kit screen"
);

// Every gap the kit produced must land somewhere that exists.
const gapsWithBadAnchor = [fullKit, unconfirmedKit, noLookerKit, freshKit]
  .flatMap((kit) => kit.gaps)
  .filter((gap) => {
    if (gap.where === "qualifications") {
      if (gap.hash === "") return false; // no anchor: the review screen itself is the target
      // The review screen builds this id by interpolation (`id={`add-${category}`}`),
      // so the anchor resolves when the hash names a real category and that button
      // exists — not when the literal string appears in the source.
      const category = gap.hash.replace(/^add-/, "");
      const known = /^(?:identity|role|education|skill|achievement|certification|language|work_rights)$/.test(category);
      return !(known && reviewSource.includes("id={`add-${category}`}"));
    }
    if (gap.where === "profile") {
      return !profileSource.includes(`id="${gap.hash}"`) && !profileSource.includes(`id={\`${gap.hash}\`}`);
    }
    return !kitSource.includes(`id="${gap.hash}"`);
  });

criterion(
  "K-copy 4",
  `every gap anchor exists on the page it points at (${String([fullKit, unconfirmedKit, noLookerKit, freshKit].flatMap((kit) => kit.gaps).length)} gaps checked)`,
  gapsWithBadAnchor.length === 0,
  JSON.stringify(gapsWithBadAnchor.map((gap) => `${gap.where}#${gap.hash}`).slice(0, 5))
);

// ======================================================================= E ===
banner("E. through the real storage module, on a throwaway data dir");

const account = db.createUser("kit-provenance-check@example.com", "not-a-real-hash");
db.saveProfile(account.id, richProfile());

const freshState = q.ensureFacts(account.id).facts;
const storageFreshKit = gen.generateKit({
  facts: freshState,
  application: { title: "Senior Product Analyst", company: "Northwind Financial", url: "", posting_text: POSTING },
  now: NOW,
});
criterion(
  "K-storage 1",
  "a real account that has confirmed nothing gets a kit with nothing confirmed in it",
  storageFreshKit.factBasis?.nothingConfirmed === true &&
    storageFreshKit.profileFactsUsed.length === 0 &&
    freshState.length > 20,
  JSON.stringify({ facts: freshState.length, basis: storageFreshKit.factBasis })
);

// Confirm the whole set through the real decision path, then exclude the salary fact.
for (const fact of freshState) q.keepFact(account.id, fact.id);
const keptState = q.ensureFacts(account.id).facts;
const salaryFact = keptState.find((fact) => fact.category === "identity" && fact.label === "Salary expectation")!;
q.excludeFact(account.id, salaryFact.id);
const afterExclude = q.ensureFacts(account.id).facts;
const storageKit = gen.generateKit({
  facts: afterExclude,
  application: { title: "Senior Product Analyst", company: "Northwind Financial", url: "", posting_text: POSTING },
  now: NOW,
});
const storageAnswer = fa.fieldAnswersFor(account.id);

criterion(
  "K-storage 2",
  "confirming everything through the real path fills the panel, and the kit and the answers screen list the same basis",
  storageKit.factBasis?.confirmed === afterExclude.filter((fact) => fact.status === "confirmed").length &&
    storageKit.profileFactsUsed.length > 15 &&
    afterExclude.filter((fact) => fact.status === "confirmed").length === keptState.filter((fact) => fact.status === "confirmed").length - 1,
  JSON.stringify({ basis: storageKit.factBasis, listed: storageKit.profileFactsUsed.length })
);
criterion(
  "K-storage 3",
  "and excluding one fact through the real path takes its value out of the kit, while the answers screen agrees",
  !JSON.stringify(storageKit).includes(salaryFact.value) &&
    storageAnswer.answers.find((answer) => answer.field === "salary_expectation")?.status === "not-covered",
  JSON.stringify({
    value: salaryFact.value,
    answersStatus: storageAnswer.answers.find((answer) => answer.field === "salary_expectation")?.status,
  })
);

// ============================================================== non-vacuity ===
//
// Each mutation is applied to a COPY of the tree, and the check is re-run there as a
// subprocess. The named criterion must FAIL in that run: a crash or a different
// failure does not count. `find` must appear exactly once, so a stale mutation (one
// that no longer matches the code) fails loudly instead of passing silently.

type Mutation = { name: string; file: string; find: string; replace: string; caughtBy: string };

const MUTATIONS: Mutation[] = [
  {
    name: "unconfirmed-salary-stated-as-settled",
    file: join("src", "server", "generate.ts"),
    find: "      text: `Nothing you've confirmed states ${wording.subject} yet. Your material covers it, and the kit won't state it until you confirm it on the review screen — then rebuild this kit.`,",
    replace: "      text: wording.confirmed(answer.pending[0]!.factValue),",
    caughtBy: "K-gate 5",
  },
  {
    name: "excluded-facts-treated-as-confirmed",
    file: join("src", "server", "generate.ts"),
    find: 'const confirmedFacts = facts.filter((fact) => fact.status === "confirmed");',
    replace: "const confirmedFacts = facts;",
    caughtBy: "K-gate 2",
  },
  {
    // The evidence quotes and the skills list both draw on the same skill facts in
    // this fixture, so removing the REGISTRATION of the skills answer is the edit
    // that genuinely leaves used facts out of the panel.
    name: "used-fact-left-out-of-the-panel",
    file: join("src", "server", "generate.ts"),
    find: "    useAnswer(skills);",
    replace: "    void skills;",
    caughtBy: "K-panel 1",
  },
  {
    name: "panel-lists-a-fact-the-kit-never-used",
    file: join("src", "server", "generate.ts"),
    find: "    profileFactsUsed: used.map(usedLine),",
    replace: '    profileFactsUsed: [...used.map(usedLine), "Certification: Dog grooming, 2019"],',
    caughtBy: "K-panel 2",
  },
  {
    name: "years-arithmetic-returns",
    file: join("src", "server", "generate.ts"),
    find: '  const posting = application.posting_text ?? "";',
    replace: '  const posting = application.posting_text ?? "";\n  const currentYear = new Date().getFullYear();\n  void currentYear;',
    caughtBy: "K-dates 2",
  },
  {
    name: "raw-vault-field-read-returns",
    file: join("src", "server", "generate.ts"),
    find: '  const posting = application.posting_text ?? "";',
    replace: '  const posting = application.posting_text ?? "";\n  if (posting === "\\u0000never") { console.log(profile.salary_expectation); }',
    caughtBy: "K-dates 2",
  },
  {
    name: "nothing-confirmed-papered-over",
    file: join("src", "server", "generate.ts"),
    find: "  const nothingConfirmed = confirmedFacts.length === 0;",
    replace: "  const nothingConfirmed = false;",
    caughtBy: "K-gate 7",
  },
  {
    name: "completeness-claim-restored-on-the-screen",
    file: join("src", "routes", "kit.$id.tsx"),
    find: "Material from your profile that the kit drew on",
    replace: "Facts used from your profile",
    caughtBy: "K-copy 1",
  },
  {
    name: "caller-hands-over-the-raw-profile",
    file: join("src", "server", "actions.ts"),
    find: "generateKit({ facts: qualifications.ensureFacts(user.id).facts, application })",
    replace:
      "generateKit({ facts: qualifications.ensureFacts(user.id).facts, application, profile: db.getProfile(user.id) } as never)",
    caughtBy: "K-dates 2",
  },
];

function runMutations(): void {
  banner("non-vacuity: deliberately broken copies of the code, each one must be caught");
  for (const mutation of MUTATIONS) {
    const copy = mkdtempSync(join(tmpdir(), "applypilot-kit-mutant-"));
    try {
      cpSync(join(ROOT, "src"), join(copy, "src"), { recursive: true });
      cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true });
      cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
      cpSync(join(ROOT, "tsconfig.json"), join(copy, "tsconfig.json"));
      const modules = join(ROOT, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(copy, "node_modules"), "dir");

      const target = join(copy, mutation.file);
      const before = readFileSync(target, "utf8");
      const occurrences = before.split(mutation.find).length - 1;
      if (occurrences !== 1) {
        check(`MUT ${mutation.name}: the edit still matches the code exactly once`, false, `matched ${String(occurrences)} times`);
        continue;
      }
      const after = before.replace(mutation.find, mutation.replace);
      writeFileSync(target, after);

      const run = spawnSync(process.execPath, ["run", "scripts/kit-provenance-check.ts", "--no-mutants"], {
        cwd: copy,
        env: { ...process.env, APPLYPILOT_DATA_DIR: "" },
        encoding: "utf8",
        timeout: 240000,
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const caught = run.status !== 0 && output.includes(`FAIL ${mutation.caughtBy}`);
      check(
        `MUT ${mutation.name}: caught by ${mutation.caughtBy}`,
        caught,
        caught
          ? "caught"
          : `NOT CAUGHT (exit ${String(run.status)}) — ${
              output
                .split("\n")
                .filter((line) => line.includes("FAIL"))
                .slice(0, 3)
                .join(" | ") || output.split("\n").slice(-4).join(" | ")
            }`
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
}

if (!process.argv.includes("--no-mutants")) runMutations();

// ==================================================================== result ===
banner("result");
console.log(`  ${String(checks)} checks, ${String(problems.length)} failed`);
console.log(`  criteria exercised: ${[...exercised.keys()].join(", ")}`);
console.log(
  "  note: the blunt exclusion scan (K-gate 2) cannot distinguish a leak from a posting\n" +
    "        keyword that happens to share a word with the excluded value, which is why the\n" +
    "        named case (K-gate 3) is asserted separately and the blunt case is the one used\n" +
    "        for values that are not posting keywords. Nothing here says the kit is useful —\n" +
    "        only what it is allowed to state."
);

if (problems.length > 0) {
  console.log(`\nFAILED:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dataDir, { recursive: true, force: true });
console.log("\nAll kit-provenance checks passed.");
