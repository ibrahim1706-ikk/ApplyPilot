/**
 * "Field answers" — what this account would put in each field of a real
 * application form, and where every word of it came from.
 *
 * This is stage 3 of the qualifications engine. Stage 1 read the user's own
 * material; stage 2 made the facts theirs (keep, correct, exclude, add, confirm);
 * this screen answers a form's standard fields from the facts they CONFIRMED.
 *
 * What it must show, because provenance is the product:
 *   - every answer carries the fact behind it, the line of the résumé or the
 *     vault field that fact was read from, in the same words the review screen
 *     uses;
 *   - a fact the user has not confirmed is named as pending and NOT used —
 *     never silently, and never dressed up as an answer;
 *   - a field nothing covers reads "not covered", with a link that lands on the
 *     exact place the real detail belongs;
 *   - nothing is submitted and nothing is sent anywhere — the app has no submit
 *     path at all, and this screen is read-only by design. Correcting facts is
 *     the review screen's job, and per-field review is the next piece of work.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell";
import { Card, SectionTitle, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { loadFieldAnswers } from "~/server/actions";
import {
  ANSWER_GROUP_COPY,
  EXCLUDED_FACT_COPY,
  NOT_COVERED_COPY,
  PENDING_FACT_COPY,
} from "~/types";
import type { AnswerGroup, AnswerSource, FieldAnswer, FieldAnswers } from "~/types";

export const Route = createFileRoute("/answers")({
  beforeLoad: requireSession,
  loader: async () => {
    const result = await loadFieldAnswers();
    if (!result.ok) return { ok: false as const, error: result.error };
    return { ok: true as const, answers: result.answers };
  },
  head: () => ({ meta: [{ title: "Answers for a real form — ApplyPilot" }] }),
  component: AnswersPage,
});

const GROUP_ORDER: AnswerGroup[] = ["identity", "arrangements", "experience", "qualifications"];

function AnswersPage() {
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

  const set: FieldAnswers = data.answers;

  return (
    <AppShell email={email}>
      <div className="space-y-5">
        <Card>
          <SectionTitle hint="Read-only. Correcting, excluding and per-field review are the next piece of work — not this one.">
            Answers for a real application form
          </SectionTitle>
          <p className="text-sm leading-relaxed text-slate-700">
            A job application asks for the same things over and over. Below is what this account would put in each of
            those fields, built only from the facts <strong>you confirmed</strong> on the review screen — and beside
            every answer, the fact it came from with the exact line of your résumé or vault field behind it.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            Where a fact isn't confirmed yet it is named as pending and{" "}
            <strong>nothing is written from it</strong>. Where nothing covers a field, the answer is{" "}
            <strong>“not covered”</strong> and you get a link to the exact place the real detail belongs. We never fill
            a gap with a plausible answer, a market rate or a default.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            Nothing here has been sent anywhere, and nothing can be: ApplyPilot has no submit path. When the
            form-filling agent arrives it works in a window you watch, fills only from these answers, and you submit
            the form yourself.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Fields answered" value={`${String(set.answered)} of ${String(set.answers.length)}`} />
            <Stat
              label="Waiting on you"
              value={set.pending === 0 ? "None" : String(set.pending)}
              hint={set.pending === 0 ? undefined : "your material covers these, but the fact isn't confirmed"}
            />
            <Stat
              label="Not covered"
              value={set.notCovered === 0 ? "None" : String(set.notCovered)}
              hint={set.notCovered === 0 ? undefined : "said plainly instead of guessed"}
            />
            <Stat
              label="Facts you confirmed"
              value={set.confirmedCount === 0 ? "None yet" : String(set.confirmedCount)}
              hint={`${String(set.factCount)} fact${set.factCount === 1 ? "" : "s"} in your set`}
            />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/qualifications" className={buttonStyles.secondary}>
              Review and confirm your facts
            </Link>
            <Link to="/profile" className={buttonStyles.subtle}>
              Open the profile vault
            </Link>
          </div>
        </Card>

        {set.empty ? (
          <Card className="border-amber-300 bg-amber-50">
            <SectionTitle hint="An empty set is the honest answer, not a broken one.">
              No answers yet — nothing you have confirmed
            </SectionTitle>
            <p className="text-sm leading-relaxed text-amber-900">{set.emptyCopy}</p>
            <ul className="mt-3 space-y-2 text-sm text-amber-900">
              <li className="flex gap-2">
                <span aria-hidden>—</span>
                <span>
                  What we read is listed on{" "}
                  <Link to="/qualifications" className="font-medium underline">
                    the review screen
                  </Link>
                  , next to the line each fact came from.
                </span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden>—</span>
                <span>
                  Answering a form from a fact you haven't confirmed is exactly what this product refuses to do.
                </span>
              </li>
            </ul>
          </Card>
        ) : null}

        {set.notes.length > 0 ? (
          <Card>
            <SectionTitle hint="How this set of answers was put together.">How these answers were made</SectionTitle>
            <ul className="space-y-2 text-sm text-slate-700">
              {set.notes.map((note, index) => (
                <li key={index} className="flex gap-2">
                  <span aria-hidden className="text-slate-400">
                    —
                  </span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {GROUP_ORDER.map((group) => {
          const answers = set.answers.filter((item) => item.group === group);
          if (answers.length === 0) return null;
          const copy = ANSWER_GROUP_COPY[group];
          const filled = answers.filter((item) => item.status === "answered").length;
          return (
            <Card key={group}>
              <SectionTitle hint={copy.hint}>{copy.title}</SectionTitle>
              <p className="mb-3 text-xs text-slate-500">
                {filled} of {answers.length} answered
                {filled < answers.length ? " · the rest say why not" : ""}
              </p>
              <ul className="space-y-4">
                {answers.map((answer) => (
                  <AnswerRow key={answer.field} answer={answer} />
                ))}
              </ul>
            </Card>
          );
        })}
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

const STATUS_BADGE: Record<FieldAnswer["status"], { label: string; className: string }> = {
  answered: { label: "answered from your facts", className: "bg-emerald-100 text-emerald-800" },
  pending: { label: "not confirmed yet", className: "bg-slate-100 text-slate-600" },
  "not-covered": { label: "not covered", className: "bg-amber-100 text-amber-900" },
};

function AnswerRow({ answer }: { answer: FieldAnswer }) {
  const badge = STATUS_BADGE[answer.status];
  return (
    <li
      data-testid={`field-${answer.field}`}
      data-status={answer.status}
      className={`rounded-xl border px-3 py-3 ${
        answer.status === "answered"
          ? "border-emerald-200 bg-white"
          : answer.status === "pending"
            ? "border-slate-200 bg-slate-50/70"
            : "border-amber-200 bg-amber-50/40"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-900">{answer.question}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.label}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{answer.hint}</p>

      {answer.status === "answered" ? (
        <>
          <p
            data-testid={`answer-${answer.field}`}
            className="mt-2 whitespace-pre-wrap rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm font-medium text-slate-900"
          >
            {answer.answer}
          </p>
          <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Where this came from
          </p>
          <ul className="mt-1 space-y-2">
            {answer.sources.map((source) => (
              <SourceBlock key={source.factId} source={source} />
            ))}
          </ul>
          {answer.related.length > 0 ? (
            <>
              <p
                data-testid={`related-${answer.field}`}
                className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-500"
              >
                Your material also says — quoted, not merged into the answer
              </p>
              <ul className="mt-1 space-y-2">
                {answer.related.map((source) => (
                  <SourceBlock key={source.factId} source={source} />
                ))}
              </ul>
            </>
          ) : null}
          {answer.caveat ? <p className="mt-2 text-xs text-slate-600">{answer.caveat}</p> : null}
        </>
      ) : null}

      {answer.status === "pending" ? (
        <>
          <p
            data-testid={`pending-${answer.field}`}
            className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
          >
            <strong>{PENDING_FACT_COPY}</strong>
            {answer.caveat ? ` ${answer.caveat}` : ""}
          </p>
          <ul className="mt-2 space-y-2">
            {answer.pending.map((source) => (
              <SourceBlock key={source.factId} source={source} />
            ))}
          </ul>
          <Link
            to="/qualifications"
            className="mt-2 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
            data-testid={`review-${answer.field}`}
          >
            Review and confirm it →
          </Link>
        </>
      ) : null}

      {answer.status === "not-covered" ? (
        <>
          <p data-testid={`not-covered-${answer.field}`} className="mt-2 text-sm text-slate-800">
            <span className="mr-2 rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-900">
              {NOT_COVERED_COPY}
            </span>
            {answer.notCovered}
          </p>
          {answer.pending.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {answer.pending.map((source) => (
                <SourceBlock key={source.factId} source={source} />
              ))}
            </ul>
          ) : null}
          {answer.excluded.length > 0 ? (
            <div className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2">
              <p className="text-xs text-slate-700">
                {EXCLUDED_FACT_COPY} The fact you excluded reads “{answer.excluded[0]!.factValue}” — {answer.excluded[0]!.provenance}.
              </p>
              <Link
                to="/qualifications"
                className="mt-1 inline-flex text-xs font-medium text-indigo-700 underline"
              >
                Bring it back on the review screen →
              </Link>
            </div>
          ) : null}
          {answer.nudge ? (
            <div className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2" data-testid={`nudge-${answer.field}`}>
              <p className="text-sm text-amber-900">{answer.nudge.text}</p>
              {answer.nudge.where === "profile" ? (
                <Link
                  to="/profile"
                  hash={answer.nudge.hash}
                  className="mt-1 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
                >
                  {answer.nudge.action} →
                </Link>
              ) : (
                <Link
                  to="/qualifications"
                  hash={answer.nudge.hash}
                  className="mt-1 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
                >
                  {answer.nudge.action} →
                </Link>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** One fact an answer came from, with the exact line or field behind it. */
function SourceBlock({ source }: { source: AnswerSource }) {
  const parts = Object.entries(source.fields).filter(([key, value]) => key !== "value" && String(value).trim() !== "");
  return (
    <li
      data-testid={`source-${source.factId}`}
      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{source.factLabel}</p>
      <p className="whitespace-pre-wrap text-sm text-slate-900">{source.factValue}</p>
      {parts.length > 0 ? (
        <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-2">
          {parts.map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt className="text-slate-500">{key}:</dt>
              <dd className="whitespace-pre-wrap">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <blockquote className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-700">{source.quote}</blockquote>
      <p className="mt-1 text-[11px] text-slate-500">{source.provenance}</p>
      {source.note ? <p className="mt-1 text-[11px] text-slate-500">{source.note}</p> : null}
      {source.sourceGone ? (
        <p className="mt-1 text-[11px] text-amber-900">
          The line this was read from is no longer in your material — the fact is kept as you decided it.
        </p>
      ) : null}
    </li>
  );
}
