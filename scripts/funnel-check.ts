/**
 * Funnel instrumentation check:
 *   `bun run scripts/funnel-check.ts`
 *
 * The product's promise is that nothing is invented about the user and nothing
 * leaves the machine. Instrumentation is where that promise is easiest to break
 * quietly, so this script tries to break it on purpose and reports what it found.
 *
 *   A. EXACTLY FIVE STEPS, AND NOTHING ELSE
 *      The vocabulary is the five step names in order. Every recording call in the
 *      product passes one of them; there is exactly one gateway to the store; no
 *      sixth step name exists anywhere in the source.
 *
 *   B. THROUGH THE REAL STORAGE MODULE (throwaway data dir)
 *      A real account walks the five steps the way the real actions walk them —
 *      created, vault saved, posting saved, kit generated, one taken forward — and
 *      the rows are the ones we expect: right user id, right step, once each.
 *      Saving the vault twice, adding a second posting, rebuilding a kit or taking
 *      a kit forward a second time adds no second row.
 *
 *   C. NO EVENT ROW CONTAINS USER CONTENT
 *      With a profile and a posting full of distinctive markers, no marker string
 *      appears anywhere in the funnel table; the table's columns are exactly
 *      (id, user_id, name, created_at); and every value is the shape it should be —
 *      an opaque id, an account id, one of the five step names, an ISO time.
 *
 *   D. DELETION KEEPS ITS PROMISE
 *      Deleting the account removes its funnel rows with everything else, leaves
 *      nothing behind under that id, and does not touch another account's rows.
 *
 *   E. THE EXPORT BEHAVIOUR WE CHOSE
 *      Steps ARE in the account export — so the export's own "everything we hold
 *      about your account" sentence stays true — and the exported steps carry no
 *      marker content, only a step name and a time.
 *
 *   F. RECORDED ON THE REAL ACTION, NEVER ON A RENDER
 *      Reading writes nothing at all. The recorder is called from the server
 *      actions and from nowhere under src/routes/; in each action the step is
 *      recorded after the thing it describes really happened.
 *
 *   G. THE PROFILE-COMPLETE THRESHOLD IS THE DOCUMENTED ONE
 *      Name plus material to write from; a name alone and a two-line résumé do not
 *      count; the number matches the kit generator's own completeness rule.
 *
 *   H. FIRST-PARTY ONLY
 *      No network call, no analytics vendor, no SQL outside the storage module.
 *
 * Exits non-zero if anything fails. Prints what it checked either way.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const FIXTURES = join(HERE, "fixtures");
const dataDir = mkdtempSync(join(tmpdir(), "applypilot-funnel-"));
process.env.APPLYPILOT_DATA_DIR = dataDir;

const db = await import("../src/db");
const funnel = await import("../src/server/funnel");

const { FUNNEL_STEPS } = db;
const { PROFILE_COMPLETE_RULE, RESUME_TEXT_MIN_CHARS, profileIsCompleteEnough } = funnel;

/** The five, in the order a person walks them. */
const EXPECTED_STEPS = [
  "signup",
  "profile_complete",
  "posting_added",
  "kit_generated",
  "application_taken_forward",
] as const;

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

/** Every .ts/.tsx file under src/, so the source checks see the whole product. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const SOURCES = sourceFiles().map((path) => ({
  path,
  rel: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));
const source = (rel: string): string =>
  SOURCES.find((file) => file.rel === rel)?.text ?? "";

/** Markers that must never reach the funnel table. */
const MARKERS = {
  fullName: "Zebediah Quarrington",
  email: "zeb.quarrington@marker-domain.example",
  phone: "+61 400 111 222",
  location: "Marrickville, NSW",
  employer: "Vandelay Industries",
  school: "Quarrington Polytechnic",
  posting: "We are hiring a Quarrington-flavoured Data Wrangler at Vandelay Industries.",
  postingUrl: "https://vandelay.example/jobs/quarrington-wrangler",
  resumeLine: "Shipped the Quarrington reconciliation pipeline, cutting close time by 40%.",
  kitOnly: "Zebediah Quarrington — cover letter for the Data Wrangler role",
  portfolio: "https://quarrington.example",
  password: "sup3r-secret-quarrington-passphrase",
};
const ALL_MARKER_TEXT = Object.values(MARKERS).join("\n");

const resumeFixture = readFileSync(join(FIXTURES, "resume-plain.txt"), "utf8");

/** A vault with everything filled in, all of it marked so we can grep for it. */
function markedProfile(): db.Profile {
  return {
    ...db.EMPTY_PROFILE,
    full_name: MARKERS.fullName,
    email: MARKERS.email,
    phone: MARKERS.phone,
    location: MARKERS.location,
    portfolio_url: MARKERS.portfolio,
    resume_text: `${MARKERS.resumeLine}\n${resumeFixture}`,
    education: [
      {
        school: MARKERS.school,
        qualification: "BSc Information Systems",
        dates: "2019 – 2022",
        details: "Quarrington prize for data engineering",
      },
    ],
    experience: [
      {
        title: "Data Analyst",
        company: MARKERS.employer,
        start: "2022-03",
        end: "",
        description: MARKERS.resumeLine,
      },
    ],
    work_authorisation: "I have the right to work",
    salary_expectation: "90000",
    notice_period: "4 weeks",
  };
}

const dump = (rows: unknown): string => JSON.stringify(rows);

// =========================================================================== A ===
banner("A. exactly five steps, and nothing else");
check(
  "the source scan really read the product's files, so the checks below are not vacuous",
  SOURCES.length > 15 &&
    SOURCES.some((file) => file.rel === "db.ts") &&
    SOURCES.some((file) => file.rel === "server/actions.ts") &&
    SOURCES.some((file) => file.rel === "routes/kit.$id.tsx"),
  String(SOURCES.length)
);
check(
  "the vocabulary is the five steps, in the order a person walks them",
  dump(FUNNEL_STEPS) === dump(EXPECTED_STEPS),
  dump(FUNNEL_STEPS)
);
check(
  "there is exactly one way into the store, and it is the storage module's own function",
  SOURCES.reduce((count, file) => count + (file.text.match(/db\.recordFunnelEvent\(/g) ?? []).length, 0) === 1 &&
    /db\.recordFunnelEvent\(/.test(source("server/funnel.ts")),
  "db.recordFunnelEvent() should be called from src/server/funnel.ts and nowhere else"
);
const literalSteps = new Set<string>();
for (const file of SOURCES) {
  for (const match of file.text.matchAll(/recordStep\(\s*[^,]+,\s*"([a-z_]+)"/g)) literalSteps.add(match[1]!);
}
check(
  "every recorded step name is one of the five — no sixth step can be introduced",
  literalSteps.size > 0 && [...literalSteps].every((name) => (EXPECTED_STEPS as readonly string[]).includes(name)),
  JSON.stringify([...literalSteps])
);
check(
  "and all five are actually wired up (not just four of them)",
  EXPECTED_STEPS.every((step) => literalSteps.has(step)),
  JSON.stringify({ wired: [...literalSteps].sort(), expect: [...EXPECTED_STEPS].sort() })
);
check(
  "the storage module refuses a step name that is not one of the five",
  typeof db.isFunnelStep === "function" &&
    EXPECTED_STEPS.every((step) => db.isFunnelStep(step)) &&
    !db.isFunnelStep("kit_opened") &&
    !db.isFunnelStep("") &&
    !db.isFunnelStep(null)
);

// =========================================================================== B ===
banner("B. through the real storage module — once per action, and only once");

// The signup action's own two lines: the account is created, then the step is
// recorded. The control account proves a deletion does not take anyone else's
// steps with it.
const control = db.createUser("control@example.com", "hash-not-used-here");
funnel.recordStep(control.id, "signup");

const user = db.createUser(MARKERS.email, "hash-not-used-here");
const signupRecorded = funnel.recordStep(user.id, "signup");
const signupAgain = funnel.recordStep(user.id, "signup");
let events = db.getFunnelEvents(user.id);
check(
  "signing up records one signup step, for the account that was just created",
  signupRecorded && !signupAgain && events.length === 1 && events[0]!.name === "signup" && events[0]!.user_id === user.id,
  dump(events)
);
check(
  "the row is a local id, a step name and a time — nothing in it points at a person",
  events[0]!.id.length >= 16 && Number.isFinite(Date.parse(events[0]!.created_at)) && db.funnelEventColumns().length === 4,
  dump({ id: events[0]!.id, at: events[0]!.created_at })
);

// The vault: below the threshold first, then over it, then saved again.
const nameOnly = { ...db.EMPTY_PROFILE, full_name: MARKERS.fullName };
db.saveProfile(user.id, nameOnly);
const nameOnlyStep = funnel.noteProfileMaterial(user.id);
const twoLineResume = { ...nameOnly, resume_text: "Zebediah Quarrington — Data Analyst." };
db.saveProfile(user.id, twoLineResume);
const twoLineStep = funnel.noteProfileMaterial(user.id);
const stepsBelowThreshold = db.getFunnelEvents(user.id).map((event) => event.name);
check(
  "a vault with only a name, or a two-line résumé, does not count as complete",
  !nameOnlyStep &&
    !twoLineStep &&
    stepsBelowThreshold.every((name) => name !== "profile_complete"),
  dump({ nameOnlyStep, twoLineStep, steps: stepsBelowThreshold })
);

const fullVault = markedProfile();
db.saveProfile(user.id, fullVault);
const firstComplete = funnel.noteProfileMaterial(user.id);
const secondComplete = funnel.noteProfileMaterial(user.id);
events = db.getFunnelEvents(user.id);
check(
  "saving a vault with material in it records profile_complete exactly once",
  firstComplete &&
    !secondComplete &&
    events.filter((event) => event.name === "profile_complete").length === 1 &&
    events[1]!.name === "profile_complete",
  dump(events.map((event) => event.name))
);

// A role, with no résumé text at all, is still enough to write from.
const rolesOnly = { ...db.EMPTY_PROFILE, full_name: "Alex Rivera", experience: fullVault.experience };
const rolesOnlyUser = db.createUser("roles-only@example.com", "hash-not-used-here");
db.saveProfile(rolesOnlyUser.id, rolesOnly);
check(
  "a vault with a role but no résumé text is complete enough — a kit can still be written from it",
  funnel.noteProfileMaterial(rolesOnlyUser.id) &&
    db.getFunnelEvents(rolesOnlyUser.id).some((event) => event.name === "profile_complete")
);

// The posting and the kit, as createApplication does them.
const posting = db.createApplication({
  userId: user.id,
  title: "Data Wrangler",
  company: MARKERS.employer,
  url: MARKERS.postingUrl,
  postingText: MARKERS.posting,
});
const postedFirst = funnel.recordStep(user.id, "posting_added");
db.saveKit(user.id, posting.id, JSON.stringify({ coverLetter: MARKERS.kitOnly }));
const kitFirst = funnel.recordStep(user.id, "kit_generated");
check("saving a posting with its kit records posting_added and kit_generated", postedFirst && kitFirst);

// A second posting and a rebuild: same two steps, no extra rows.
const secondPosting = db.createApplication({
  userId: user.id,
  title: "Second role",
  company: MARKERS.employer,
  url: "",
  postingText: `${MARKERS.posting} A second posting, saved after the first.`,
});
funnel.recordStep(user.id, "posting_added");
db.saveKit(user.id, secondPosting.id, JSON.stringify({ coverLetter: MARKERS.kitOnly }));
funnel.recordStep(user.id, "kit_generated");
db.saveKit(user.id, posting.id, JSON.stringify({ coverLetter: MARKERS.kitOnly }));
funnel.recordStep(user.id, "kit_generated");
events = db.getFunnelEvents(user.id);
check(
  "a second posting, and a rebuilt kit, add no second row",
  events.filter((event) => event.name === "posting_added").length === 1 &&
    events.filter((event) => event.name === "kit_generated").length === 1,
  dump(events.map((event) => event.name))
);

// Taking one forward, as the take-forward action does it.
const chosenFirst = db.saveApplicationChoice(user.id, posting.id);
const chooseStepFirst = chosenFirst ? funnel.recordStep(user.id, "application_taken_forward") : false;
const chosenAgain = db.saveApplicationChoice(user.id, posting.id);
const chooseStepAgain = chosenAgain ? funnel.recordStep(user.id, "application_taken_forward") : false;
const chosenOther = db.saveApplicationChoice(user.id, secondPosting.id);
const chooseStepOther = chosenOther ? funnel.recordStep(user.id, "application_taken_forward") : false;
events = db.getFunnelEvents(user.id);
check(
  "taking a kit forward records the step once, and again for another kit adds no second row",
  chooseStepFirst &&
    !chosenAgain &&
    !chooseStepAgain &&
    chosenOther &&
    !chooseStepOther &&
    events.filter((event) => event.name === "application_taken_forward").length === 1,
  dump({ chosenFirst, chosenAgain, chosenOther, steps: events.map((event) => event.name) })
);
check(
  "the whole walk is the five steps, in order, once each",
  dump(events.map((event) => event.name)) === dump(EXPECTED_STEPS) &&
    db.getFunnelEvent(user.id, "signup")?.user_id === user.id,
  dump(events.map((event) => event.name))
);
check(
  "and the funnel summary counts accounts per step, not attempts",
  dump(db.funnelSummary().map((row) => row.name)) === dump(EXPECTED_STEPS) &&
    (db.funnelSummary().find((row) => row.name === "kit_generated")?.accounts ?? 0) >= 1,
  dump(db.funnelSummary())
);

// Reading writes nothing — the same guarantee the answers screen already has.
const beforeReads = dump(db.listAllFunnelEvents());
const beforeCount = db.funnelEventCount();
db.getFunnelEvents(user.id);
db.getFunnelEvent(user.id, "profile_complete");
db.funnelSummary();
db.funnelEventColumns();
db.funnelEventCount();
db.getApplicationChoice(user.id, posting.id);
db.listApplicationChoices(user.id);
db.getProfile(user.id);
db.listApplications(user.id);
db.exportAccount(user.id);
db.countRowsForUser(user.id);
db.tableCounts();
check(
  "reading the funnel — and every read a page does — writes nothing",
  dump(db.listAllFunnelEvents()) === beforeReads && db.funnelEventCount() === beforeCount,
  dump({ before: beforeCount, after: db.funnelEventCount() })
);

// =========================================================================== C ===
banner("C. no event row contains user content");
const allRows = db.listAllFunnelEvents();
const tableJson = dump(allRows);
check("there are rows to inspect at all", allRows.length >= 2, String(allRows.length));
const leaked = Object.entries(MARKERS).filter(([, value]) => tableJson.includes(value));
check(
  "no résumé line, employer, school, posting, url, email, phone, name or portfolio link is in the funnel table",
  leaked.length === 0,
  dump(leaked.map(([key]) => key))
);
check(
  "…and neither is any fragment of the material, in case a rearranged copy slipped in",
  !/quarrington|vandelay|marrickville/i.test(tableJson),
  tableJson.slice(0, 400)
);
check(
  "the table has exactly the four columns it promises, read from the engine",
  dump(db.funnelEventColumns().slice().sort()) === dump(["created_at", "id", "name", "user_id"]),
  dump(db.funnelEventColumns())
);
const rowShapeOk = allRows.every(
  (row) =>
    /^[0-9a-f-]{36}$/.test(row.id) &&
    /^[0-9a-f-]{36}$/.test(row.user_id) &&
    (EXPECTED_STEPS as readonly string[]).includes(row.name) &&
    new Date(row.created_at).toISOString() === row.created_at
);
check(
  "every value is the shape it should be: opaque id, account id, step name, ISO time",
  rowShapeOk,
  tableJson.slice(0, 400)
);
check(
  "each row is tiny — a few counts of an id and a step, not a document",
  allRows.every((row) => JSON.stringify(row).length < 200),
  String(Math.max(...allRows.map((row) => JSON.stringify(row).length)))
);
check(
  "and the account id is a local id, not the email address it was created with",
  allRows.every((row) => !row.user_id.includes("@")) && allRows.every((row) => row.user_id !== MARKERS.email)
);

// =========================================================================== D ===
banner("D. deletion keeps its promise");
check(
  "the account has all five steps before deletion",
  db.getFunnelEvents(user.id).length === 5,
  String(db.getFunnelEvents(user.id).length)
);
const deleted = db.deleteAccount(user.id);
const leftovers = db.countRowsForUser(user.id);
check(
  "deleting the account removes its funnel rows, and reports how many it removed",
  deleted?.funnelEvents === 5 && deleted?.applicationChoices === 2,
  dump({ funnelEvents: deleted?.funnelEvents, applicationChoices: deleted?.applicationChoices })
);
check(
  "nothing at all is left under that id, in any table",
  Object.values(leftovers).every((count) => count === 0),
  dump(leftovers)
);
check(
  "no row in the funnel table still carries the deleted account's id",
  db.listAllFunnelEvents().every((row) => row.user_id !== user.id) && db.getFunnelEvents(user.id).length === 0,
  dump(db.listAllFunnelEvents().map((row) => row.user_id))
);
check(
  "and deleting one account leaves another account's steps alone",
  db.getFunnelEvents(control.id).length === 1 &&
    db.getFunnelEvents(rolesOnlyUser.id).length === 1 &&
    db.listAllFunnelEvents().length === 2,
  dump(db.listAllFunnelEvents().map((row) => [row.user_id, row.name]))
);

// =========================================================================== E ===
banner("E. the export behaviour we chose: the steps are in it, and the export's own words stay true");
const exporter = db.createUser("export@example.com", "hash-not-used-here");
funnel.recordStep(exporter.id, "signup");
db.saveProfile(exporter.id, markedProfile());
funnel.noteProfileMaterial(exporter.id);
const exportPosting = db.createApplication({
  userId: exporter.id,
  title: "Data Wrangler",
  company: MARKERS.employer,
  url: MARKERS.postingUrl,
  postingText: MARKERS.posting,
});
db.saveKit(exporter.id, exportPosting.id, JSON.stringify({ coverLetter: MARKERS.kitOnly }));
funnel.recordStep(exporter.id, "posting_added");
funnel.recordStep(exporter.id, "kit_generated");
db.saveApplicationChoice(exporter.id, exportPosting.id);
funnel.recordStep(exporter.id, "application_taken_forward");
const exported = db.exportAccount(exporter.id);
const exportedSteps = exported?.funnel.events.map((event) => event.step) ?? [];
check(
  "the export lists the steps the account reached, in order",
  dump(exportedSteps) === dump(EXPECTED_STEPS),
  dump(exportedSteps)
);
check(
  "…with a time each, and no content at all in them",
  (exported?.funnel.events ?? []).every(
    (event) => Number.isFinite(Date.parse(event.at)) && JSON.stringify(event).length < 80
  ) && !Object.values(MARKERS).some((value) => dump(exported?.funnel ?? {}).includes(value)),
  dump(exported?.funnel)
);
check(
  "the export also says which kit was taken forward",
  (exported?.applications ?? []).some(
    (application) => application.takenForwardAt !== null && application.title === "Data Wrangler"
  ),
  dump(exported?.applications.map((application) => [application.title, application.takenForwardAt]))
);
const exportAbout = source("server/actions.ts");
check(
  "and the export's own description mentions them, so the file does not contradict itself",
  /funnel steps .{0,60}reached/.test(exportAbout) && /every piece of information/.test(exportAbout),
  "src/server/actions.ts no longer describes the funnel steps in the export"
);
const privacySource = source("routes/privacy.tsx");
check(
  "the privacy page says what is counted, that it has no content, and that it goes with the account",
  /five steps/i.test(privacySource) &&
    /no IP address/i.test(privacySource) &&
    /no third-party analytics/i.test(privacySource) &&
    /funnel steps recorded for your account/i.test(privacySource),
  "privacy.tsx no longer describes the funnel steps"
);

// =========================================================================== F ===
banner("F. recorded on the real action, never on a render");
const routeFiles = SOURCES.filter((file) => file.rel.startsWith("routes/"));
check(
  "no page or component calls the recorder — a render cannot write a step",
  routeFiles.every(
    (file) => !/recordStep\(|noteProfileMaterial\(|recordFunnelEvent\(/.test(file.text)
  ),
  dump(
    routeFiles
      .filter((file) => /recordStep\(|noteProfileMaterial\(|recordFunnelEvent\(/.test(file.text))
      .map((file) => file.rel)
  )
);
const actions = source("server/actions.ts");
const expectedCalls: Array<[string, number]> = [
  ['recordStep(user.id, "signup")', 1],
  ["noteProfileMaterial(user.id)", 3],
  ['recordStep(user.id, "posting_added")', 1],
  ['recordStep(user.id, "kit_generated")', 2],
  ['recordStep(user.id, "application_taken_forward")', 1],
];
const callCounts = expectedCalls.map(([text]) => (actions.split(text).length - 1));
check(
  "the recorder is called from the server actions, once per real action that reaches a step",
  dump(callCounts) === dump(expectedCalls.map(([, count]) => count)),
  dump({ found: callCounts, expected: expectedCalls.map(([, count]) => count) })
);
/** True when `first` appears before `second` in the source. */
function before(sourceText: string, first: string, second: string): boolean {
  const a = sourceText.indexOf(first);
  const b = sourceText.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
}
check(
  "each step is recorded after the thing it describes really happened",
  before(actions, "const user = db.createUser(", 'recordStep(user.id, "signup")') &&
    before(actions, "db.saveProfile(user.id, profile)", "noteProfileMaterial(user.id)") &&
    before(actions, "db.saveKit(user.id, application.id, JSON.stringify(kit))", 'recordStep(user.id, "posting_added")') &&
    before(actions, "const isNew = db.saveApplicationChoice(", 'recordStep(user.id, "application_taken_forward")'),
  "a step is recorded before its action's own write"
);
check(
  "taking a kit forward is a choice the user makes, and it still does not submit anything",
  /takeApplicationForward/.test(actions) &&
    !/submitApplication|sendApplication|applyToJob/.test(SOURCES.map((file) => file.text).join("\n")),
  "a submit path appeared"
);
check(
  "and asking for the take-forward page writes nothing until the button is pressed",
  source("routes/kit.$id.tsx").includes("onClick={handleTakeForward}") &&
    /await takeApplicationForward\(\{ data: \{ id: application.id \} \}\)/.test(source("routes/kit.$id.tsx"))
);

// =========================================================================== G ===
banner("G. the profile-complete threshold is the documented one");
function vault(overrides: Partial<db.Profile>): db.Profile {
  return { ...db.EMPTY_PROFILE, ...overrides };
}
const oneRole = [{ title: "Data Analyst", company: "A company", start: "2022", end: "", description: "" }];
const oneSchool = [{ school: "A school", qualification: "BSc", dates: "2019", details: "" }];
const thresholdCases: Array<[string, boolean, db.Profile]> = [
  ["nothing at all", false, vault({})],
  ["a name and nothing else", false, vault({ full_name: "Alex Morgan" })],
  ["a name and a two-line résumé", false, vault({ full_name: "Alex Morgan", resume_text: "Alex Morgan\nData Analyst" })],
  [
    `a name and exactly ${String(RESUME_TEXT_MIN_CHARS)} characters of résumé`,
    false,
    vault({ full_name: "Alex Morgan", resume_text: "x".repeat(RESUME_TEXT_MIN_CHARS) }),
  ],
  [
    `a name and ${String(RESUME_TEXT_MIN_CHARS + 1)} characters of résumé`,
    true,
    vault({ full_name: "Alex Morgan", resume_text: "x".repeat(RESUME_TEXT_MIN_CHARS + 1) }),
  ],
  ["a name and one role", true, vault({ full_name: "Alex Morgan", experience: oneRole })],
  ["a name and one education entry", true, vault({ full_name: "Alex Morgan", education: oneSchool })],
  ["a role but no name", false, vault({ experience: oneRole })],
  ["a long résumé but no name", false, vault({ resume_text: resumeFixture })],
  ["whitespace is not a name", false, vault({ full_name: "   ", resume_text: resumeFixture })],
];
const wrongCases = thresholdCases.filter(([, expected, profile]) => profileIsCompleteEnough(profile) !== expected);
check(
  "the threshold accepts name + material, and refuses a name alone or a stub résumé",
  wrongCases.length === 0,
  dump(wrongCases.map(([label, expected, profile]) => [label, expected, profileIsCompleteEnough(profile)]))
);
check(
  "the rule is written down where the code is, and names both halves",
  PROFILE_COMPLETE_RULE.length > 120 && /full name/.test(PROFILE_COMPLETE_RULE) && /résumé/.test(PROFILE_COMPLETE_RULE),
  PROFILE_COMPLETE_RULE
);
const generateSource = source("server/generate.ts");
check(
  `the number is the kit generator's own completeness rule, not a second opinion (RESUME_TEXT_MIN_CHARS = ${String(RESUME_TEXT_MIN_CHARS)})`,
  generateSource.includes(`profile.resume_text.trim().length > ${String(RESUME_TEXT_MIN_CHARS)}`) &&
    source("server/funnel.ts").includes(
      "profile.resume_text.trim().length > RESUME_TEXT_MIN_CHARS"
    ),
  "the funnel threshold and the kit's completeness check have drifted apart"
);

// =========================================================================== H ===
banner("H. first-party only");
const funnelSource = source("server/funnel.ts");
const dbSource = source("db.ts");
check(
  "the funnel code makes no network call and holds no model",
  !/\bfetch\s*\(/.test(funnelSource) &&
    !/XMLHttpRequest|navigator\.sendBeacon/.test(funnelSource) &&
    !/https?:\/\//.test(funnelSource) &&
    !/openai|anthropic|completion/i.test(funnelSource)
);
const vendorNames =
  /gtag\(|googletagmanager\.com|google-analytics\.com|posthog\.com|mixpanel\.com|amplitude\.com|segment\.(io|com)|plausible\.io|umami\.is|hotjar\.com|sentry\.io|clarity\.ms|matomo\.org/i;
const vendorFiles = SOURCES.filter((file) => vendorNames.test(file.text));
check(
  "no third-party analytics or tracking script is wired into the product",
  vendorFiles.length === 0,
  dump(vendorFiles.map((file) => file.rel))
);
const sqlWords = /\b(INSERT INTO|DELETE FROM|UPDATE\s+\w+\s+SET|SELECT\s+[\s\S]{0,40}?\sFROM\s|CREATE TABLE|PRAGMA\s)/i;
const sqlOutsideStorage = SOURCES.filter((file) => file.rel !== "db.ts" && sqlWords.test(file.text));
check(
  "no SQL exists outside the storage module — the managed-database swap stays a one-file change",
  sqlOutsideStorage.length === 0,
  dump(sqlOutsideStorage.map((file) => file.rel))
);
/** This script's own text, less the lines that define the SQL pattern above. */
const thisScript = readFileSync(join(HERE, "funnel-check.ts"), "utf8")
  .split("\n")
  .filter((line) => !line.includes("sqlWords"))
  .join("\n");
check(
  "the funnel table's SQL lives in src/db.ts, and this check script writes no SQL of its own",
  sqlWords.test(dbSource) && !sqlWords.test(thisScript) && !/bun:sqlite/.test(thisScript)
);
check(
  "the events are written to our own store, with no endpoint or queue in the path",
  !/https?:\/\//.test(funnelSource) && /db\.recordFunnelEvent\(/.test(funnelSource)
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
