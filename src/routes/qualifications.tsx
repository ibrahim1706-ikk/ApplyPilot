/**
 * "What we found in your material" — the read-only view of the qualifications
 * facts.
 *
 * What this page is: a plain list of what the extractor read out of the user's
 * own résumé text and the fields they saved in the vault, grouped by category,
 * each fact sitting next to the exact words it came from.
 *
 * What this page deliberately is NOT, this time round: there is nothing to edit,
 * confirm, exclude or send anywhere. No button on this page writes anything — the
 * only thing that happens when it loads is that the facts are re-read if the
 * material has changed since the last read. Correcting and confirming facts is
 * the next piece of work, and the copy says so rather than implying the list is
 * final.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell";
import { Card, SectionTitle } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { loadQualifications } from "~/server/actions";
import { FACT_CATEGORY_COPY, FACT_CATEGORY_ORDER, factSourceLabel, groupFacts } from "~/types";
import type { ExtractionReport, Fact, FactCategory } from "~/types";

export const Route = createFileRoute("/qualifications")({
  beforeLoad: requireSession,
  loader: async () => {
    const result = await loadQualifications();
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      facts: result.facts,
      report: result.report,
      computedAt: result.computedAt,
      recomputed: result.recomputed,
    };
  },
  head: () => ({ meta: [{ title: "What we found in your material — ApplyPilot" }] }),
  component: QualificationsPage,
});

function QualificationsPage() {
  const data = Route.useLoaderData();
  const context = Route.useRouteContext();
  const email = context.email ?? "";

  if (!data.ok) {
    return (
      <AppShell email={email}>
        <Card>
          <p className="text-sm text-slate-700">{data.error}</p>
        </Card>
      </AppShell>
    );
  }

  const grouped = groupFacts(data.facts);
  const total = data.facts.length;
  const emptyCategories = grouped.filter((group) => group.facts.length === 0);

  return (
    <AppShell email={email}>
      <div className="space-y-5">
        <Card>
          <SectionTitle>What we found in your material</SectionTitle>
          <p className="text-sm leading-relaxed text-slate-700">
            This is exactly what your own material says — your résumé text and the fields you saved in the
            profile vault. Every item below shows the line it came from, word for word. Nothing here is
            invented, written for you, or filled in from anywhere else, and if a section is empty it means
            your material doesn't say it: we'd rather show you a gap than guess.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            You'll be able to correct or confirm these facts soon — this page only shows them for now. If
            something is missing, adding it to your{" "}
            <Link to="/profile" className="font-medium text-indigo-700 underline">
              profile vault
            </Link>{" "}
            and coming back is how it gets read.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Facts found" value={total === 0 ? "None yet" : String(total)} />
            <Stat
              label="Material read"
              value={`${data.report.resumeChars.toLocaleString()} characters`}
            />
            <Stat
              label="Last read"
              value={new Date(data.computedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              hint={data.recomputed ? "Re-read just now, because your material changed." : undefined}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {FACT_CATEGORY_ORDER.map((category) => (
              <span
                key={category}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  data.report.counts[category] > 0
                    ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }`}
              >
                {FACT_CATEGORY_COPY[category].title}:{" "}
                {data.report.counts[category] > 0 ? data.report.counts[category] : "none found"}
              </span>
            ))}
          </div>
        </Card>

        {FACT_CATEGORY_ORDER.map((category) => (
          <CategoryCard
            key={category}
            category={category}
            facts={grouped.find((group) => group.category === category)?.facts ?? []}
          />
        ))}

        <NotesCard report={data.report} emptyCategories={emptyCategories.map((g) => g.category)} />

        <Card>
          <SectionTitle hint="Every heading the extractor recognised in your résumé text, and the line it was on.">
            What we read
          </SectionTitle>
          {data.report.sections.length === 0 ? (
            <p className="text-sm text-slate-600">
              We didn't recognise any section headings in your résumé text
              {data.report.resumeChars === 0 ? " — there is no résumé text saved yet." : "."}{" "}
              {data.report.resumeChars === 0 ? (
                <>
                  Add your résumé on the{" "}
                  <Link to="/profile" className="font-medium text-indigo-700 underline">
                    profile vault
                  </Link>{" "}
                  and this list will fill in.
                </>
              ) : (
                "Headings like EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS and LANGUAGES are the ones we know."
              )}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.report.sections.map((section, index) => (
                <li
                  key={`${section.line}-${index}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  <span className="font-medium text-slate-800">{section.heading}</span>
                  <span className="text-xs text-slate-500">
                    line {section.line} · read as “{section.kind}”
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{value}</dd>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function CategoryCard({ category, facts }: { category: FactCategory; facts: Fact[] }) {
  const copy = FACT_CATEGORY_COPY[category];
  const fromResume = facts.filter((fact) => fact.source.kind === "resume").length;
  const fromVault = facts.length - fromResume;
  return (
    <Card>
      <SectionTitle hint={copy.hint}>{copy.title}</SectionTitle>
      {facts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-3 text-sm text-slate-600">
          {copy.empty}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {facts.map((fact) => (
              <FactRow key={fact.id} fact={fact} />
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            {facts.length} {facts.length === 1 ? "fact" : "facts"}
            {fromResume > 0 ? ` · ${fromResume} quoted from your résumé text` : ""}
            {fromVault > 0 ? ` · ${fromVault} from your vault fields` : ""}
          </p>
        </>
      )}
    </Card>
  );
}

function FactRow({ fact }: { fact: Fact }) {
  const extraFields = Object.entries(fact.fields).filter(
    ([field, value]) => field !== "value" && value.trim() !== ""
  );
  return (
    <li className="rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fact.label}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
          not confirmed yet
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm font-medium text-slate-900">{fact.value}</p>
      {extraFields.length > 0 ? (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
          {extraFields.map(([field, value]) => (
            <div key={field} className="flex gap-1">
              <dt className="text-slate-500">{FIELD_LABELS[field] ?? field}:</dt>
              <dd className="whitespace-pre-wrap">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <figure className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <blockquote className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
          {fact.quote}
        </blockquote>
        <figcaption className="mt-1 text-[11px] text-slate-500">
          {factSourceLabel(fact.source)}
          {fact.source.kind === "resume" && fact.source.section !== "other"
            ? ` · read in your “${fact.source.section}” section`
            : ""}
        </figcaption>
      </figure>
      {fact.note ? <p className="mt-2 text-xs text-slate-500">{fact.note}</p> : null}
    </li>
  );
}

const FIELD_LABELS: Record<string, string> = {
  title: "Job title",
  company: "Company",
  start: "Start",
  end: "End",
  description: "What you did",
  qualification: "Qualification",
  school: "Institution",
  dates: "Dates",
  details: "Anything else",
  metric: "The number it states",
  year: "Year",
  level: "Level",
  note: "Note",
};

function NotesCard({ report, emptyCategories }: { report: ExtractionReport; emptyCategories: FactCategory[] }) {
  return (
    <Card>
      <SectionTitle hint="How the reading went, including what we couldn't find and why.">
        Notes on this pass
      </SectionTitle>
      {emptyCategories.length > 0 ? (
        <p className="mb-3 text-sm text-slate-700">
          Nothing was found for{" "}
          {emptyCategories.map((category) => FACT_CATEGORY_COPY[category].title.toLowerCase()).join(", ")}.
          {emptyCategories.length === FACT_CATEGORY_ORDER.length
            ? " That's the whole list — there is nothing here to show you yet, and we have not filled anything in to hide that."
            : " That is not a failure: it means your material doesn't state it."}
        </p>
      ) : null}
      {report.notes.length === 0 ? (
        <p className="text-sm text-slate-600">No notes — every category above has something in it.</p>
      ) : (
        <ul className="space-y-2 text-sm text-slate-700">
          {report.notes.map((note, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden className="text-slate-400">
                —
              </span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
