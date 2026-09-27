/**
 * Builds `resume-real.pdf` — a genuine, minimal PDF whose pages are laid out the
 * way a word processor lays out a résumé: one text-showing operator per line, at
 * its own position, with wider gaps for the section headings.
 *
 * Why hand-build it: the extractor's job starts with text that came out of a
 * real PDF parser, and this sandbox has no word processor or PDF library to
 * print one with. unpdf (the same parser the app uses on an upload) reads this
 * file byte for byte, so the fixture exercises the real path — including the
 * blank-line loss and spacing quirks that PDF text extraction produces and that
 * plain-text fixtures never show.
 *
 *   bun run scripts/fixtures/make-resume-pdf.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "resume-real.pdf");

/** Faint rules and heading emphasis, so it looks like a document, not a dump. */
const LINES: Array<{ text: string; size: number; gap: number }> = [
  { text: "ALEX MORGAN", size: 17, gap: 26 },
  { text: "alex.morgan@example.com   |   0412 345 678   |   Melbourne, Australia", size: 9.5, gap: 14 },
  { text: "github.com/alexmorgan  |  linkedin.com/in/alexmorgan  |  alexmorgan.dev", size: 9.5, gap: 26 },
  { text: "SUMMARY", size: 11, gap: 16 },
  { text: "Product analyst who turns messy support data into decisions. Six years", size: 10, gap: 13 },
  { text: "across fintech and health SaaS, comfortable in SQL and Python, and used", size: 10, gap: 13 },
  { text: "to talking to engineers, designers and the support floor in one afternoon.", size: 10, gap: 24 },
  { text: "EXPERIENCE", size: 11, gap: 16 },
  { text: "Senior Product Analyst, Northwind Financial    Feb 2022 - Present", size: 10.5, gap: 14 },
  { text: "- Built the weekly retention dashboard the exec team runs standups from.", size: 10, gap: 13 },
  { text: "- Grew activation from 41% to 63% over three quarters.", size: 10, gap: 13 },
  { text: "- Cut the time to answer a pricing question from 9 days to 2.", size: 10, gap: 13 },
  { text: "- Managed a $240k analytics tooling budget and merged four vendors.", size: 10, gap: 20 },
  { text: "Product Analyst, Northwind Financial    Mar 2020 - Feb 2022", size: 10.5, gap: 14 },
  { text: "- Owned the support-deflection model, which reduced inbound tickets 18%.", size: 10, gap: 13 },
  { text: "- Partnered with two engineers to ship a self-serve refund flow.", size: 10, gap: 20 },
  { text: "Junior Data Analyst", size: 10.5, gap: 13 },
  { text: "Harbour Health Group    Jul 2018 - Mar 2020", size: 10.5, gap: 14 },
  { text: "- Wrote the SQL behind the monthly patient wait-time report.", size: 10, gap: 13 },
  { text: "- Trained 14 clinic coordinators on the new reporting portal.", size: 10, gap: 24 },
  { text: "EDUCATION", size: 11, gap: 16 },
  { text: "Bachelor of Commerce (Business Analytics)", size: 10, gap: 13 },
  { text: "University of Melbourne", size: 10, gap: 13 },
  { text: "2015 - 2018", size: 10, gap: 24 },
  { text: "SKILLS", size: 11, gap: 16 },
  { text: "SQL (advanced), Python, dbt, Looker, Figma", size: 10, gap: 13 },
  { text: "A/B testing, Snowflake, Metabase, Jira", size: 10, gap: 24 },
  { text: "CERTIFICATIONS", size: 11, gap: 16 },
  { text: "Google Analytics Certification, 2021", size: 10, gap: 13 },
  { text: "AWS Certified Cloud Practitioner", size: 10, gap: 13 },
  { text: "2023", size: 10, gap: 24 },
  { text: "LANGUAGES", size: 11, gap: 16 },
  { text: "English (native), Spanish (B2), Mandarin (conversational)", size: 10, gap: 24 },
  { text: "WORK RIGHTS", size: 11, gap: 16 },
  { text: "Australian citizen. No sponsorship required for any role in Australia.", size: 10, gap: 14 },
];

const PAGE_HEIGHT = 842;
const TOP = 790;
const LEFT = 56;

let y = TOP;
const parts: string[] = [];
for (const line of LINES) {
  y -= line.gap;
  const escaped = line.text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  parts.push(`BT /F1 ${line.size} Tf ${LEFT} ${y.toFixed(1)} Td (${escaped}) Tj ET`);
}
const content = parts.join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
];

let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objects.forEach((body, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(out, pdf, "latin1");
console.log(`wrote ${out} (${pdf.length} bytes, ${LINES.length} text lines, page height ${PAGE_HEIGHT})`);
