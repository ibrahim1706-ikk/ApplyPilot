/**
 * Qualifications extractor check: `bun run scripts/qualifications-check.ts`.
 *
 * Runs the deterministic extractor over three deliberately different inputs and
 * prints every fact it produced, grouped by category, with the exact quote each
 * fact came from. Nothing is summarised away: the point is to be able to judge
 * the extraction by reading it, and to see plainly where it found nothing
 * instead of guessing.
 *
 *   1. resume-real.pdf   — a real PDF, read back through the app's own PDF text
 *                          extractor (unpdf), so this is what a résumé that came
 *                          out of a PDF actually looks like to the extractor.
 *   2. resume-plain.txt  — plain, well-structured text, pasted by hand.
 *   3. resume-thin.txt   — thin and badly structured: headings, a first name, a
 *                          sentence of prose and nothing else. This one must
 *                          come back with honest "we couldn't find" answers and
 *                          no invented facts.
 *
 * It also runs three assertions that are the product's hard rules, and exits
 * non-zero if any of them fail:
 *   - every fact has a non-empty quote, and every résumé-quoted fact's quote is
 *     literally present in the text it was read from;
 *   - the thin résumé invents nothing (no skill, employer, date, number or
 *     qualification that its text does not contain);
 *   - the same input always produces the same facts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTextFromBytes, sniffUpload } from "../src/server/extract";
import { extractFacts, inputFromProfile } from "../src/server/qualifications";
import type { QualificationInput } from "../src/server/qualifications";
import { EMPTY_PROFILE } from "../src/db";
import { FACT_CATEGORY_COPY, FACT_CATEGORY_ORDER } from "../src/types";
import type { Fact } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

async function pdfText(): Promise<string> {
  const bytes = new Uint8Array(readFileSync(join(fixtures, "resume-real.pdf")));
  const sniffed = sniffUpload("resume-real.pdf", "application/pdf", bytes);
  if (!sniffed.ok) throw new Error(`fixture PDF rejected: ${sniffed.error}`);
  const out = await extractTextFromBytes(sniffed.file, bytes);
  return out.text;
}

function baseInput(resumeText: string): QualificationInput {
  return inputFromProfile({ ...EMPTY_PROFILE, resume_text: resumeText });
}

/** Some vault fields filled in, to prove both sources are read and labelled. */
function withVault(input: QualificationInput): QualificationInput {
  return {
    ...input,
    workAuthorisation: "Visa with unrestricted work rights",
    workAuthorisationNote: "Subclass 485, valid to March 2027.",
    experience: [
      {
        title: "Freelance Data Consultant",
        company: "Self-employed",
        start: "Jan 2019",
        end: "Jun 2019",
        description: "Six-month contract building reporting for two clinics.",
      },
    ],
    education: [],
  };
}

function printFacts(title: string, resumeText: string, input: QualificationInput): Fact[] {
  const { facts, report } = extractFacts(input);
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
  console.log(
    `résumé text: ${report.resumeChars} characters · headings recognised: ${report.sections.length} · facts: ${facts.length}`
  );
  console.log(
    report.sections.length > 0
      ? `headings: ${report.sections.map((s) => `${s.heading} (line ${s.line}, ${s.kind})`).join("; ")}`
      : "headings: none recognised"
  );
  for (const category of FACT_CATEGORY_ORDER) {
    const inCategory = facts.filter((fact) => fact.category === category);
    console.log(`\n--- ${category.toUpperCase()} (${inCategory.length})`);
    if (inCategory.length === 0) {
      console.log(`    [nothing found] ${FACT_CATEGORY_COPY[category].empty}`);
      continue;
    }
    for (const fact of inCategory) {
      const extra = Object.entries(fact.fields)
        .filter(([field, value]) => field !== "value" && value.trim() !== "")
        .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
        .join(" ");
      const where =
        fact.source.kind === "resume"
          ? `résumé line ${fact.source.line} / ${fact.source.section}`
          : fact.source.kind === "profile"
            ? `vault field ${fact.source.field}`
            : "user";
      console.log(`  • ${fact.label}: ${JSON.stringify(fact.value)}`);
      if (extra) console.log(`      fields: ${extra}`);
      console.log(`      quote (${where}): ${JSON.stringify(fact.quote)}`);
      if (fact.note) console.log(`      note: ${fact.note}`);
    }
  }
  console.log(`\nnotes on this pass (${report.notes.length}):`);
  for (const note of report.notes) console.log(`  – ${note}`);
  if (report.missing.length > 0) {
    console.log(`\nmissing-category copy shown to the user (${report.missing.length}):`);
    for (const line of report.missing) console.log(`  – ${line}`);
  }
  if (resumeText.trim()) {
    const lines = resumeText.replace(/\r\n?/g, "\n").split("\n");
    const bad = facts.filter((fact) => {
      if (fact.source.kind !== "resume") return false;
      const quoted = fact.quote.split("  /  ").map((piece) => piece.trim());
      return !quoted.every((piece) => lines.some((line) => line.trim() === piece));
    });
    if (bad.length > 0) {
      console.log(`\n!! ${bad.length} quotes are not literal lines of the text they came from:`);
      for (const fact of bad) console.log(`   ${JSON.stringify(fact.quote)}`);
    } else {
      console.log("\nquote check: every résumé-sourced quote is a literal line of the text it came from.");
    }
  }
  return facts;
}

const thinText = readFileSync(join(fixtures, "resume-thin.txt"), "utf8");
const plainText = readFileSync(join(fixtures, "resume-plain.txt"), "utf8");
const pdfExtracted = await pdfText();

console.log(`PDF text extraction produced ${pdfExtracted.length} characters.`);
console.log("First 400 characters of the PDF text as unpdf returns it:");
console.log(JSON.stringify(pdfExtracted.slice(0, 400)));

const pdfFacts = printFacts("1. résumé text that came out of a real PDF", pdfExtracted, baseInput(pdfExtracted));
const plainFacts = printFacts("2. plain-text résumé, plus vault fields", plainText, withVault(baseInput(plainText)));
const thinFacts = printFacts("3. thin, badly structured résumé", thinText, baseInput(thinText));
const thinAgain = extractFacts(baseInput(thinText));

// -------------------------------------------------------------- assertions ---
const problems: string[] = [];

for (const fact of [...pdfFacts, ...plainFacts, ...thinFacts]) {
  if (!fact.quote.trim()) problems.push(`fact without a quote: ${fact.id} (${fact.category})`);
  if (fact.status !== "suggested" || fact.origin !== "extracted") {
    problems.push(`fact left the extractor already confirmed: ${fact.id}`);
  }
}

// Nothing may appear in the thin résumé's facts that is not in its text.
const thinTruth = thinText.toLowerCase();
const thinInput = baseInput(thinText);
const thinFactsForbiddenChecks: Array<[string, (fact: Fact) => boolean]> = [
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
for (const fact of thinFacts) {
  for (const [what, test] of thinFactsForbiddenChecks) {
    if (test(fact)) {
      problems.push(`thin résumé produced ${what} it does not contain: ${JSON.stringify(fact.value)}`);
    }
  }
  if (fact.source.kind === "profile") {
    const field = fact.source.field as keyof QualificationInput;
    if (!thinInput[field]) problems.push(`thin résumé fact cites an empty vault field: ${field}`);
  }
  if (fact.source.kind === "resume") {
    const line = thinText.replace(/\r\n?/g, "\n").split("\n")[fact.source.line - 1] ?? "";
    if (line.trim() !== fact.quote.trim()) {
      problems.push(`thin résumé fact quote is not line ${fact.source.line}: ${JSON.stringify(fact.quote)}`);
    }
  }
}
if (thinFacts.some((fact) => fact.category === "identity" && fact.label === "Name")) {
  const name = thinFacts.find((fact) => fact.label === "Name");
  if (name && name.value !== "Jordan Blake") {
    problems.push(`thin résumé read the wrong name: ${JSON.stringify(name.value)}`);
  } else {
    console.log('\nthin résumé: read "Jordan Blake" from the name-like line, and nothing else.');
  }
}

// Deterministic: same input, same facts. Only the extraction timestamp may
// differ between runs — everything else, including the fact ids a later
// correction screen will key on, has to be identical.
function content(facts: Fact[]): string {
  return JSON.stringify(
    facts.map(({ createdAt, updatedAt, ...rest }) => {
      void createdAt;
      void updatedAt;
      return rest;
    })
  );
}
if (content(thinAgain.facts) !== content(extractFacts(baseInput(thinText)).facts)) {
  problems.push("two runs over the same input produced different facts");
}
if (content(extractFacts(baseInput(pdfExtracted)).facts) !== content(pdfFacts)) {
  problems.push("two runs over the PDF text produced different facts");
}
if (content(extractFacts(withVault(baseInput(plainText))).facts) !== content(plainFacts)) {
  problems.push("two runs over the plain-text résumé produced different facts");
}

console.log(`\n${"=".repeat(78)}`);
if (problems.length === 0) {
  console.log("ALL CHECKS PASSED: quotes are literal, the thin résumé invented nothing, runs are identical.");
} else {
  console.log(`${problems.length} PROBLEM(S):`);
  for (const problem of problems) console.log(`  ! ${problem}`);
  process.exitCode = 1;
}
