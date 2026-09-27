/**
 * Stage-2 check for the qualifications review: `bun run scripts/qualifications-review-check.ts`.
 *
 * Stage 1 proved the extractor only reports what the user's own material says.
 * This script proves the thing stage 2 adds, in three parts:
 *
 *   A. WHAT A DECISION DOES (pure, no storage)
 *      keep / correct / exclude / add, and the rule that matters most here:
 *      provenance survives editing. A corrected fact still carries the original
 *      line beside it, marked as edited; a fact the user typed is labelled as
 *      theirs and is never quoted as if it came out of the résumé.
 *
 *   B. WHAT A RÉSUMÉ CHANGE DOES
 *      The documented behaviour, tested rather than asserted in prose:
 *        - the same material re-read never invents anything and never changes a
 *          line it already read;
 *        - when the user's material is replaced, the facts are re-read, and their
 *          decisions come with them — matched by value, so a line that merely
 *          moved keeps its decision;
 *        - a correction whose source line is gone entirely is KEPT, marked as
 *          coming from a line the material no longer has;
 *        - an exclusion stays excluded (it is remembered by value, so a re-upload
 *          cannot quietly bring it back);
 *        - the thin, badly-structured résumé still invents nothing, and a
 *          category the material is silent about still says so — with the user's
 *          own added fact labelled as theirs, not as something we found.
 *
 *   C. WHAT PERSISTS (the real storage module, against a throwaway data dir)
 *      Signup-shaped user, decisions written through the same functions the page
 *      calls, then read back in a SEPARATE PROCESS (`--reopen`): a genuine
 *      reload, not a second call in the same memory. Then confirmations (time
 *      stored, and the set they describe), export, and account deletion.
 *
 * Exits non-zero if anything fails. Prints what it checked either way.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SELF = fileURLToPath(import.meta.url);

// --------------------------------------------------------- the reopen phase ---
//
// A second process, pointed at the same data directory, reading the facts the
// same way the page's loader does. If a decision only lived in memory, this is
// where it goes missing.
if (process.argv[2] === "--reopen") {
  const payload = JSON.parse(process.argv[3] ?? "{}") as {
    userId: string;
    dataDir: string;
    expect: Array<{ what: string; id: string; status: string; value?: string; edited?: boolean }>;
  };
  process.env.APPLYPILOT_DATA_DIR = payload.dataDir;
  const db = await import("../src/db");
  const q = await import("../src/server/qualifications");
  const state = q.ensureFacts(payload.userId);
  const results = payload.expect.map((want) => {
    const fact = state.facts.find((item) => item.id === want.id);
    const problems: string[] = [];
    if (!fact) problems.push("fact is gone");
    else {
      if (fact.status !== want.status) problems.push(`status is ${fact.status}, expected ${want.status}`);
      if (want.value !== undefined && fact.value !== want.value) {
        problems.push(`value is ${JSON.stringify(fact.value)}, expected ${JSON.stringify(want.value)}`);
      }
      if (want.edited !== undefined && fact.edited !== want.edited) {
        problems.push(`edited is ${String(fact.edited)}, expected ${String(want.edited)}`);
      }
    }
    return { what: want.what, ok: problems.length === 0, problems };
  });
  const stored = db.getQualificationDecisions(payload.userId);
  const decisionCount = stored ? (JSON.parse(stored.decisions_json) as unknown[]).length : 0;
  console.log(
    JSON.stringify({ decisionCount, decisionsUpdatedAt: stored?.updated_at ?? null, results }, null, 2)
  );
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

// -------------------------------------------------------------- the main run ---

const dataDir = mkdtempSync(join(tmpdir(), "applypilot-facts-review-"));
process.env.APPLYPILOT_DATA_DIR = dataDir;

const db = await import("../src/db");
const q = await import("../src/server/qualifications");
const { FACT_CATEGORY_COPY, FACT_CATEGORY_ORDER, factValueKey } = await import("../src/types");
type Fact = import("../src/types").Fact;
type FactDecision = import("../src/types").FactDecision;

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
const shifted = `A LINE THE USER ADDED ABOVE EVERYTHING ELSE\n${plain}`;

function profileWith(resumeText: string, fullName = "Alex Morgan"): import("../src/db").Profile {
  return { ...db.EMPTY_PROFILE, full_name: fullName, email: "alex.morgan@example.com", resume_text: resumeText };
}
/**
 * The pure-extraction helper deliberately passes NO vault fields: the thin
 * résumé check below has to fail if anything at all appears that only the vault
 * (or a stray default) could have supplied.
 */
function extract(resumeText: string) {
  return q.extractFacts(q.inputFromProfile({ ...db.EMPTY_PROFILE, resume_text: resumeText }));
}
function decide(fact: Fact, action: FactDecision["action"], extra: Partial<FactDecision> = {}): FactDecision {
  return {
    id: fact.id,
    category: fact.category,
    action,
    valueKey: factValueKey(fact.category, fact.value),
    snapshot: { label: fact.label, value: fact.value, quote: fact.quote, note: fact.note, source: fact.source },
    at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}
function applied(base: Fact[], decisions: FactDecision[]) {
  return q.applyDecisions(base, decisions);
}

// ---------------------------------------------------------- A. a decision ---

banner("A. what keep / correct / exclude / add do (pure, no storage)");

const plainBase = extract(plain).facts;
const skill = plainBase.find((fact) => fact.category === "skill");
const cert = plainBase.find((fact) => fact.category === "certification");
const rights = plainBase.find((fact) => fact.category === "work_rights");
check("the plain résumé yields a skill, a certification and a work-rights fact", Boolean(skill && cert && rights));

if (skill && cert && rights) {
  const kept = applied(plainBase, [decide(skill, "keep")]).facts.find((f) => f.id === skill.id);
  check(
    "keep: the fact reads as confirmed and its quoted line is untouched",
    kept?.status === "confirmed" && kept.quote === skill.quote && kept.edited === false,
    JSON.stringify({ status: kept?.status, edited: kept?.edited })
  );

  const corrected = applied(plainBase, [
    decide(skill, "correct", { fields: { value: "My own wording for this skill" }, value: "My own wording for this skill" }),
  ]).facts.find((f) => f.id === skill.id);
  check(
    "correct: the user's wording wins",
    corrected?.value === "My own wording for this skill",
    JSON.stringify(corrected?.value)
  );
  check(
    "correct: the original résumé line is still shown beside it, marked edited by you",
    corrected?.quote === skill.quote && corrected.edited === true && corrected.originalValue === skill.value,
    JSON.stringify({ quote: corrected?.quote, edited: corrected?.edited, original: corrected?.originalValue })
  );
  check(
    "correct: a corrected fact counts as confirmed (the user's own word stands behind it)",
    corrected?.status === "confirmed",
    String(corrected?.status)
  );

  const excluded = applied(plainBase, [decide(skill, "exclude")]).facts.find((f) => f.id === skill.id);
  check(
    "exclude: the fact is still listed, just not usable",
    excluded?.status === "excluded" && excluded.quote === skill.quote,
    String(excluded?.status)
  );

  const excludedEdited = applied(plainBase, [
    decide(skill, "exclude", { fields: { value: "Kept words" }, value: "Kept words" }),
  ]).facts.find((f) => f.id === skill.id);
  check(
    "exclude: an exclusion does not throw away words the user had typed for that fact",
    excludedEdited?.fields?.value === "Kept words",
    JSON.stringify(excludedEdited?.fields)
  );

  const addedDecision: FactDecision = {
    id: "user-skill-added",
    category: "skill",
    action: "add",
    fields: { value: "Kubernetes" },
    value: "Kubernetes",
    userNote: "Used at my last job.",
    valueKey: factValueKey("skill", "Kubernetes"),
    at: "2026-01-01T00:00:00.000Z",
  };
  const addedFact = applied(plainBase, [addedDecision]).facts.find((f) => f.id === "user-skill-added");
  check(
    "add: the fact is stored as the user's own, with no résumé line claimed for it",
    addedFact?.origin === "user" && addedFact.source.kind === "user" && addedFact.status === "confirmed",
    JSON.stringify({ origin: addedFact?.origin, source: addedFact?.source })
  );
  check(
    "add: it is labelled as something they added, not as something we found",
    /added/i.test(addedFact?.label ?? ""),
    JSON.stringify(addedFact?.label)
  );
  check(
    "add: nothing about it is inferred — an optional note aside, only what they typed is stored",
    addedFact?.value === "Kubernetes" && addedFact.userNote === "Used at my last job.",
    JSON.stringify({ value: addedFact?.value, note: addedFact?.userNote })
  );

  // A decision on a fact that belongs to a category the material never covered
  // must not make the extractor claim it found something.
  const thinRun = extract(thin);
  check(
    "the thin résumé's own report still says nothing was found for languages",
    thinRun.report.counts.language === 0,
    JSON.stringify(thinRun.report.counts.language)
  );
  const thinWithAdd = applied(thinRun.facts, [
    {
      id: "user-language-added",
      category: "language",
      action: "add",
      fields: { value: "German", level: "A2" },
      value: "German",
      valueKey: factValueKey("language", "German"),
      at: "2026-01-01T00:00:00.000Z",
    },
  ]).facts.find((f) => f.id === "user-language-added");
  check(
    "a fact the user adds to an uncovered category is theirs, and the empty-category answer still exists",
    thinWithAdd?.origin === "user" &&
      thinWithAdd.value === "German" &&
      FACT_CATEGORY_COPY.language.empty.length > 0,
    JSON.stringify(thinWithAdd?.value)
  );
}

// ------------------------------------------------ B. what a résumé change does ---

banner("B. what happens when the user's material changes");

const shiftedBase = extract(shifted).facts;
if (skill && cert) {
  const decisions: FactDecision[] = [
    decide(cert, "keep"),
    decide(skill, "correct", { fields: { value: "SQL and dbt" }, value: "SQL and dbt" }),
  ];
  const movedRun = applied(shiftedBase, decisions);
  const movedCorrected = movedRun.facts.find(
    (fact) => fact.category === "skill" && fact.value === "SQL and dbt"
  );
  check(
    "material re-read with every line moved: the correction still applies, on the new line",
    Boolean(movedCorrected) &&
      movedCorrected?.edited === true &&
      movedCorrected.source.kind === "resume" &&
      movedCorrected.source.line !== skill.source.line,
    JSON.stringify({ line: movedCorrected?.source, originalLine: skill.source.line })
  );
  check(
    "and the user is told the line moved rather than left guessing",
    movedRun.notes.some((note) => /different line/i.test(note)),
    JSON.stringify(movedRun.notes)
  );

  const keptMoved = movedRun.facts.find((fact) => fact.category === "certification" && fact.value === cert.value);
  check(
    "a kept fact travels with the same material too",
    keptMoved?.status === "confirmed",
    JSON.stringify(keptMoved?.status)
  );

  // The exact line the corrected fact came from is removed from the material.
  const lines = plain.replace(/\r\n?/g, "\n").split("\n");
  const lineIndex = skill.source.kind === "resume" ? skill.source.line - 1 : -1;
  const withoutLine = lines.filter((_, index) => index !== lineIndex).join("\n");
  const goneRun = applied(extract(withoutLine).facts, decisions);
  const goneCorrected = goneRun.facts.find((fact) => fact.category === "skill" && fact.value === "SQL and dbt");
  check(
    "correction whose source line is gone: the user's version is kept",
    goneCorrected?.value === "SQL and dbt" && goneCorrected.status === "confirmed",
    JSON.stringify(goneCorrected?.value)
  );
  check(
    "…and it is marked as coming from a line the material no longer has, with the original quoted",
    goneCorrected?.sourceGone === true && goneCorrected.quote === skill.quote,
    JSON.stringify({ sourceGone: goneCorrected?.sourceGone, quote: goneCorrected?.quote })
  );
  check(
    "…and the user is never shown it as if the résumé still said it",
    goneCorrected?.edited === true,
    String(goneCorrected?.edited)
  );

  // An exclusion must not come back just because the line moved or the file was
  // uploaded again.
  const excludeSkill = plainBase.find((fact) => fact.category === "skill" && fact.value !== skill.value);
  if (excludeSkill) {
    const excludedDecision = decide(excludeSkill, "exclude");
    const afterShift = applied(extract(shifted).facts, [...decisions, excludedDecision]).facts.find(
      (fact) => fact.category === "skill" && fact.value === excludeSkill.value
    );
    check(
      "an excluded fact stays excluded after the material is re-read, even though its line number changed",
      afterShift?.status === "excluded",
      String(afterShift?.status)
    );
  } else {
    check("an excluded fact stays excluded after the material is re-read", false, "no second skill to exclude");
  }

  // Nothing a decision does may invent a fact.
  const shiftedValues = new Set(shiftedBase.map((fact) => fact.value));
  const invented = applied(shiftedBase, decisions).facts.filter(
    (fact) => fact.origin !== "user" && !shiftedValues.has(fact.originalValue ?? fact.value)
  );
  check(
    "applying decisions never adds an extracted fact that the material does not have",
    invented.length === 0,
    JSON.stringify(invented.map((fact) => fact.value))
  );
}

// The thin résumé still invents nothing (same rules stage 1 asserted).
const thinFacts = extract(thin).facts;
const forbiddenThin: Array<[string, (fact: Fact) => boolean]> = [
  ["a skill", (fact) => fact.category === "skill"],
  ["a role", (fact) => fact.category === "role"],
  ["education", (fact) => fact.category === "education"],
  ["a quantified achievement", (fact) => fact.category === "achievement"],
  ["a certification", (fact) => fact.category === "certification"],
  ["a language", (fact) => fact.category === "language"],
  ["work rights", (fact) => fact.category === "work_rights"],
  ["an email address", (fact) => fact.category === "identity" && fact.label === "Email"],
  ["a phone number", (fact) => fact.category === "identity" && fact.label === "Phone"],
];
const thinInventions = thinFacts.filter((fact) => forbiddenThin.some(([, test]) => test(fact)));
check(
  "the thin résumé still produces nothing it does not contain",
  thinInventions.length === 0,
  JSON.stringify(thinInventions.map((fact) => fact.value))
);
const thinEmpty = FACT_CATEGORY_ORDER.filter((category) => !thinFacts.some((fact) => fact.category === category));
check(
  "every category it is silent about still has its honest \"we couldn't find\" answer",
  thinEmpty.every((category) => FACT_CATEGORY_COPY[category].empty.trim().length > 0),
  JSON.stringify(thinEmpty)
);

// ------------------------------------------------------------ C. persistence ---

banner("C. what persists (real storage module, throwaway data dir)");

const user = db.createUser("facts-review-check@example.com", "not-a-real-hash");
db.saveProfile(user.id, profileWith(plain));

const first = q.ensureFacts(user.id);
check("first read builds the fact set from the material", first.recomputed === true && first.facts.length > 0);
const second = q.ensureFacts(user.id);
check(
  "a second read is the same set, unchanged and not recomputed",
  second.recomputed === false &&
    JSON.stringify(second.facts.map((fact) => [fact.id, fact.value, fact.status])) ===
      JSON.stringify(first.facts.map((fact) => [fact.id, fact.value, fact.status]))
);

const keepMe = second.facts.find((fact) => fact.category === "skill");
const fixMe = second.facts.find((fact) => fact.category === "certification");
const dropMe = second.facts.find((fact) => fact.category === "identity" && fact.label !== "Name");
const secondSkill = second.facts.filter((fact) => fact.category === "skill")[1];

if (!keepMe || !fixMe || !dropMe || !secondSkill) {
  check("the fixture yields the facts this part of the check needs", false, "fixture shape changed");
} else {
  check("keep saves", q.keepFact(user.id, keepMe.id).ok);
  const correctOutcome = q.correctFact(user.id, fixMe.id, {
    value: "Google Analytics Certification (passed 2021)",
    year: "2021",
  });
  check("correct saves", correctOutcome.ok);
  check("exclude saves", q.excludeFact(user.id, dropMe.id).ok);
  const addOutcome = q.addFact(user.id, "language", { value: "German", level: "A2" }, "Night school, 2023.");
  check("add saves", addOutcome.ok && typeof addOutcome.id === "string");

  const afterDecisions = q.ensureFacts(user.id);
  const kept = afterDecisions.facts.find((fact) => fact.id === keepMe.id);
  const fixed = afterDecisions.facts.find((fact) => fact.id === fixMe.id);
  const dropped = afterDecisions.facts.find((fact) => fact.id === dropMe.id);
  const added = afterDecisions.facts.find((fact) => fact.id === addOutcome.id);
  check("keep is reflected on the next read", kept?.status === "confirmed", String(kept?.status));
  check(
    "correct is reflected, with the original line kept beside it",
    fixed?.value === "Google Analytics Certification (passed 2021)" &&
      fixed?.edited === true &&
      fixed?.quote === fixMe.quote,
    JSON.stringify({ value: fixed?.value, quote: fixed?.quote })
  );
  check("exclude is reflected", dropped?.status === "excluded", String(dropped?.status));
  check(
    "add is reflected, as the user's own",
    added?.origin === "user" &&
      added?.value === "German" &&
      added?.fields?.level === "A2" &&
      added?.source.kind === "user",
    JSON.stringify({ origin: added?.origin, value: added?.value })
  );

  const rawRow = db.getQualificationDecisions(user.id);
  const rawDecisions = rawRow ? (JSON.parse(rawRow.decisions_json) as FactDecision[]) : [];
  check(
    "the decisions are in the store itself, not just in the running process",
    rawDecisions.length === 4 &&
      rawDecisions.some((decision) => decision.action === "correct" && decision.fields?.value) &&
      rawDecisions.some((decision) => decision.action === "add"),
    JSON.stringify(rawDecisions.map((decision) => decision.action))
  );

  // ------------------------------------------------------------- confirming ---
  const confirmCategory = q.confirmFacts(user.id, "skill");
  check("a category can be confirmed", confirmCategory.ok);
  let state = q.ensureFacts(user.id);
  check(
    "confirming a category stores the time and keeps every fact in it",
    q.confirmationMatches(state.confirmations, state.facts, "skill") &&
      state.confirmations.categories.skill !== null &&
      state.facts.filter((fact) => fact.category === "skill").every((fact) => fact.status === "confirmed"),
    JSON.stringify(state.confirmations.categories.skill)
  );
  check(
    "and it does not claim the rest of the set was confirmed",
    q.confirmationMatches(state.confirmations, state.facts, "overall") === false &&
      state.confirmations.overall === null
  );

  const confirmAll = q.confirmFacts(user.id, "overall");
  check("the whole set can be confirmed", confirmAll.ok);
  state = q.ensureFacts(user.id);
  check(
    "the whole-set confirmation stores a time and describes the set it was made about",
    q.confirmationMatches(state.confirmations, state.facts, "overall") &&
      typeof state.confirmations.overall?.at === "string" &&
      (state.confirmations.overall?.setHash.length ?? 0) > 0,
    JSON.stringify(state.confirmations.overall)
  );
  if (added) check("a fact the user added is part of the confirmed set", added.status === "confirmed");

  // Changing the set must un-confirm it, not silently keep a stale confirmation.
  q.excludeFact(user.id, secondSkill.id);
  state = q.ensureFacts(user.id);
  check(
    "changing the set clears the confirmation it no longer describes",
    state.confirmations.overall === null && state.confirmations.categories.skill === null
  );

  // ------------------------------------------------- the résumé is replaced ---
  q.confirmFacts(user.id, "overall");
  db.saveProfile(user.id, profileWith(shifted));
  const afterResumeChange = q.ensureFacts(user.id);
  check(
    "replacing the résumé re-reads the material instead of showing stale facts",
    afterResumeChange.recomputed === true,
    JSON.stringify(afterResumeChange.computedAt)
  );
  const keptAfter = afterResumeChange.facts.find((fact) => fact.value === keepMe.value);
  const fixedAfter = afterResumeChange.facts.find((fact) => fact.edited && fact.category === "certification");
  const droppedAfter = afterResumeChange.facts.find((fact) => fact.value === dropMe.value);
  const addedAfter = afterResumeChange.facts.find((fact) => fact.origin === "user");
  check(
    "nothing the user decided is lost: kept, corrected, excluded and added all still read the same way",
    keptAfter?.status === "confirmed" &&
      fixedAfter?.value === "Google Analytics Certification (passed 2021)" &&
      droppedAfter?.status === "excluded" &&
      addedAfter?.value === "German",
    JSON.stringify({
      kept: keptAfter?.status,
      fixed: fixedAfter?.value,
      dropped: droppedAfter?.status,
      added: addedAfter?.value,
    })
  );
  check(
    "the previously confirmed set now reads as changed, because it is not the set that was confirmed",
    q.confirmationMatches(afterResumeChange.confirmations, afterResumeChange.facts, "overall") === false &&
      afterResumeChange.confirmations.overall !== null
  );

  // A fact the user added is never given a résumé line, then or later.
  check(
    "the added fact still has no résumé source after the résumé changed",
    addedAfter?.source.kind === "user" && addedAfter?.quote === "German",
    JSON.stringify({ source: addedAfter?.source, quote: addedAfter?.quote })
  );

  // ------------------------------------------------------- a real reload -----
  const expect = [
    { what: "kept fact", id: keptAfter?.id ?? "", status: "confirmed", value: keepMe.value },
    {
      what: "corrected fact",
      id: fixedAfter?.id ?? "",
      status: "confirmed",
      value: "Google Analytics Certification (passed 2021)",
      edited: true,
    },
    { what: "excluded fact", id: droppedAfter?.id ?? "", status: "excluded", value: dropMe.value },
    {
      what: "added fact",
      id: addedAfter?.id ?? "",
      status: "confirmed",
      value: "German",
    },
  ];
  const child = Bun.spawnSync({
    cmd: [process.execPath, SELF, "--reopen", JSON.stringify({ userId: user.id, dataDir, expect })],
    stdout: "pipe",
    stderr: "pipe",
  });
  const childOut = child.stdout.toString();
  const childErr = child.stderr.toString();
  console.log("  ---- separate process, same store ----");
  for (const line of childOut.trim().split("\n")) console.log(`  | ${line}`);
  if (childErr.trim()) for (const line of childErr.trim().split("\n")) console.log(`  ! ${line}`);
  check(
    "everything the user decided is still there in a fresh process (a real reload)",
    child.exitCode === 0,
    `exit ${String(child.exitCode)}`
  );

  // ------------------------------------------------- export and deletion -----
  const exported = db.exportAccount(user.id);
  const exportedDecisions =
    (exported?.qualifications?.decisions as FactDecision[] | null | undefined) ?? [];
  check(
    "the account export carries the user's own decisions as well as the facts",
    Array.isArray(exportedDecisions) &&
      exportedDecisions.length >= 4 &&
      exportedDecisions.some((decision) => decision.action === "add"),
    JSON.stringify(exportedDecisions.map((decision) => decision.action))
  );

  const deleted = db.deleteAccount(user.id);
  const leftovers = db.countRowsForUser(user.id);
  check(
    "deleting the account removes the decisions with everything else",
    deleted?.qualificationDecisions === 1 &&
      Object.values(leftovers).every((count) => count === 0) &&
      !db.getQualificationDecisions(user.id),
    JSON.stringify({ deleted: deleted?.qualificationDecisions, leftovers })
  );

  const tables = db.tableCounts();
  check(
    "no rows are left behind in the decisions table",
    (tables.qualification_decisions ?? 0) === 0,
    JSON.stringify(tables)
  );
}

rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${"=".repeat(78)}`);
if (problems.length === 0) {
  console.log(
    `ALL CHECKS PASSED (${String(checks)}): decisions persist across a real reload, provenance survives editing, ` +
      "a résumé change loses nothing the user decided, and nothing is invented about them."
  );
} else {
  console.log(`${String(problems.length)} PROBLEM(S) out of ${String(checks)} checks:`);
  for (const problem of problems) console.log(`  ! ${problem}`);
  process.exitCode = 1;
}
