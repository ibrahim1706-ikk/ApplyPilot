import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "~/components/AppShell";
import { Badge, Card, CopyBlock, Input, SectionTitle, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { deleteApplication, loadApplication, regenerateKit, takeApplicationForward } from "~/server/actions";

export const Route = createFileRoute("/kit/$id")({
  beforeLoad: requireSession,
  loader: async ({ params }) => loadApplication({ data: { id: params.id } }),
  head: () => ({ meta: [{ title: "Application kit — ApplyPilot" }] }),
  component: KitPage,
});

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function KitPage() {
  const context = Route.useRouteContext();
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [titleDraft, setTitleDraft] = useState(data.ok ? data.application.title : "");
  const [companyDraft, setCompanyDraft] = useState(data.ok ? data.application.company : "");

  if (!data.ok) {
    return (
      <AppShell email={context.email ?? ""}>
        <Card>
          <p className="text-sm text-slate-700">{data.error}</p>
          <Link to="/applications" className={`${buttonStyles.secondary} mt-4`}>
            Back to my applications
          </Link>
        </Card>
      </AppShell>
    );
  }

  const { application, kit } = data;

  async function handleRegenerate(alsoFixDetails: boolean) {
    setBusy(true);
    setNote("");
    const result = await regenerateKit({
      data: alsoFixDetails
        ? { id: application.id, title: titleDraft, company: companyDraft }
        : { id: application.id },
    });
    setBusy(false);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    await router.invalidate();
    setNote(alsoFixDetails ? "Details saved and the kit was rebuilt." : "Kit rebuilt from your current profile.");
  }

  async function handleDelete() {
    setBusy(true);
    await deleteApplication({ data: { id: application.id } });
    await router.invalidate();
    await navigate({ to: "/applications" });
  }

  async function handleTakeForward() {
    setBusy(true);
    setNote("");
    const result = await takeApplicationForward({ data: { id: application.id } });
    setBusy(false);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    await router.invalidate();
    setNote(
      "Marked as the one you're taking forward. Nothing has been sent anywhere — copy each piece into the employer's own form and send it yourself."
    );
  }

  return (
    <AppShell email={context.email ?? ""}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {application.title || "Untitled role"}
            {application.company ? <span className="text-slate-500"> · {application.company}</span> : null}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Created {dateFormatter.format(new Date(application.createdAt))}
            {kit ? <> · kit generated {dateFormatter.format(new Date(kit.generatedAt))}</> : null}
          </p>
          {application.url ? (
            <a
              href={application.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block break-all text-xs font-medium text-indigo-600 hover:text-indigo-500"
            >
              {application.url}
            </a>
          ) : null}
          {application.takenForwardAt ? (
            <p className="mt-1 text-xs font-medium text-emerald-700">
              Taken forward {dateFormatter.format(new Date(application.takenForwardAt))} — this is the one
              you&apos;re sending yourself. Nothing has been submitted for you.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonStyles.primary}
            onClick={handleTakeForward}
            disabled={busy || !kit || application.takenForwardAt !== null}
            title={
              application.takenForwardAt
                ? "Already marked as taken forward"
                : "Mark this kit as the one you're taking to the employer's form"
            }
          >
            {application.takenForwardAt ? "Taken forward" : busy ? "Working…" : "Take this one forward"}
          </button>
          <button type="button" className={buttonStyles.secondary} onClick={() => handleRegenerate(false)} disabled={busy}>
            {busy ? "Working…" : "Rebuild from my profile"}
          </button>
          <button type="button" className={buttonStyles.danger} onClick={handleDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {note ? <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{note}</p> : null}

      {!kit ? (
        <Card className="mt-6">
          <p className="text-sm text-slate-700">
            This application has no kit yet — rebuild it from your profile.
          </p>
        </Card>
      ) : (
        <div className="mt-6 space-y-5">
          {kit.factBasis?.nothingConfirmed ? (
            <Card className="border-amber-400 bg-amber-50">
              <SectionTitle hint="This is the honest state, not a broken one. Nothing about you has been written here.">
                Nothing to write from yet — you haven&apos;t confirmed any facts
              </SectionTitle>
              <p className="text-sm leading-relaxed text-amber-900">
                The kit writes only from facts you have confirmed for yourself. Every fact we read from your
                material is still waiting on the review screen, so there is no cover letter and no drafted
                answer here that states anything about you. Review and confirm what&apos;s right, then
                rebuild this kit.
              </p>
              <Link
                to="/qualifications"
                className={`${buttonStyles.secondary} mt-4`}
                data-testid="kit-review-facts"
              >
                Review and confirm your facts →
              </Link>
            </Card>
          ) : null}
          <Card className="border-slate-300">
            <div className="flex flex-wrap items-center gap-4">
              <div className="mr-auto">
                <p className="text-sm font-semibold text-slate-900">
                  Keyword match: {kit.keywordMatch.evidenced.length} of{" "}
                  {kit.keywordMatch.evidenced.length + kit.keywordMatch.missing.length} posting keywords are
                  evidenced by facts you confirmed
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {kit.profileCompleteness}% of the basics a kit needs are confirmed in your facts
                  {kit.factBasis
                    ? ` — ${String(kit.factBasis.confirmed)} confirmed, ${String(
                        kit.factBasis.pending
                      )} waiting for you, ${String(kit.factBasis.excluded)} you excluded.`
                    : "."}{" "}
                  Gaps are never filled with guesses.
                </p>
              </div>
              <div className="w-40">
                <div className="h-2 w-full rounded-full bg-slate-200">
                  <div
                    className="h-2 rounded-full bg-indigo-600"
                    style={{ width: `${String(kit.keywordMatch.coverage)}%` }}
                  />
                </div>
                <p className="mt-1 text-right text-xs font-medium text-slate-600">
                  {kit.keywordMatch.coverage}% coverage
                </p>
              </div>
            </div>
          </Card>

          {kit.gaps.length > 0 ? (
            <Card className="border-amber-300 bg-amber-50">
              <SectionTitle hint="The kit stops at these. It never fills a gap with a guess — add the real detail and it will use it.">
                Check before you send
              </SectionTitle>
              <ul className="space-y-3">
                {kit.gaps.map((gap) => (
                  <li key={gap.text} className="rounded-lg border border-amber-200 bg-white/70 p-3">
                    <p className="text-sm text-amber-900">{gap.text}</p>
                    {gap.where === "profile" ? (
                      <Link
                        to="/profile"
                        hash={gap.hash}
                        className="mt-2 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
                      >
                        {gap.action} →
                      </Link>
                    ) : gap.where === "qualifications" ? (
                      <Link
                        to="/qualifications"
                        hash={gap.hash}
                        className="mt-2 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
                        data-testid="gap-review-facts"
                      >
                        {gap.action} →
                      </Link>
                    ) : (
                      <a
                        href={`#${gap.hash}`}
                        className="mt-2 inline-flex text-sm font-medium text-indigo-700 underline decoration-indigo-300 hover:text-indigo-600"
                      >
                        {gap.action} →
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-amber-800">
                Add the missing piece where the link points — your profile vault, or the review screen for
                anything we read that you haven&apos;t confirmed — then press “Rebuild from my profile”. The
                kit picks it up. Nothing is filled in for you in the meantime.
              </p>
            </Card>
          ) : (
            <Card className="border-emerald-300 bg-emerald-50">
              <p className="text-sm text-emerald-900">
                Nothing flagged in what the kit checked: every requirement it compared your confirmed facts
                against is either covered by one or already answered in them.
              </p>
              <p className="mt-2 text-xs text-emerald-800">
                The kit doesn&apos;t check the rest of the posting — the other questions it asks are listed
                below for you to answer in your own words.
              </p>
            </Card>
          )}

          <Card>
            <SectionTitle hint="Written from the facts you confirmed and this posting only. Quote it verbatim, or edit it — it's yours.">
              Cover letter
            </SectionTitle>
            <CopyBlock title="Cover letter" body={kit.coverLetter} />
          </Card>

          <Card>
            <SectionTitle hint="The questions almost every application asks, answered from facts you confirmed — and labelled when that basis isn't there.">
              Drafted answers
            </SectionTitle>
            <div className="space-y-4">
              {kit.answers.map((answer) => (
                <CopyBlock
                  key={answer.question}
                  title={answer.question}
                  body={answer.answer}
                  meta={
                    <div className="flex flex-wrap items-center gap-2">
                      {answer.basis === "pending" ? (
                        <Badge tone="amber">Not confirmed yet — nothing used</Badge>
                      ) : answer.basis === "excluded" ? (
                        <Badge tone="amber">You excluded this — nothing used</Badge>
                      ) : answer.basis === "missing" || answer.missingInput ? (
                        <Badge tone="amber">Nothing confirmed for this yet</Badge>
                      ) : null}
                      {answer.sources.length > 0 ? (
                        <span>Drawn from: {answer.sources.join("; ")}</span>
                      ) : answer.basis === "pending" ? (
                        <span>Drawn from: nothing you have confirmed yet</span>
                      ) : answer.basis === "excluded" ? (
                        <span>Drawn from: nothing — you excluded the fact for this</span>
                      ) : (
                        <span>Drawn from: nothing in your confirmed facts yet</span>
                      )}
                    </div>
                  }
                />
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle hint="Keywords the posting uses, and whether the facts you confirmed already show them.">
              Skills &amp; keyword match
            </SectionTitle>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Facts you confirmed show these ({kit.keywordMatch.evidenced.length})
                </h3>
                <ul className="mt-3 space-y-3">
                  {kit.keywordMatch.evidenced.length === 0 ? (
                    <li className="text-sm text-slate-500">
                      None yet — confirm the facts we read from your résumé text and roles.
                    </li>
                  ) : null}
                  {kit.keywordMatch.evidenced.map((hit) => (
                    <li key={hit.keyword} className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-900">{hit.keyword}</span>
                        {hit.required ? <Badge tone="red">must-have</Badge> : null}
                        <Badge tone="green">{hit.mentions}× in posting</Badge>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-600">“{hit.evidence}”</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  The posting asks for these, nothing you confirmed mentions them ({kit.keywordMatch.missing.length})
                </h3>
                <ul className="mt-3 space-y-2">
                  {kit.keywordMatch.missing.length === 0 ? (
                    <li className="text-sm text-slate-500">Nothing missing — good luck.</li>
                  ) : null}
                  {kit.keywordMatch.missing.map((gap) => (
                    <li
                      key={gap.keyword}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
                    >
                      <span className="text-sm font-medium text-slate-900">{gap.keyword}</span>
                      {gap.required ? <Badge tone="red">must-have</Badge> : null}
                      <Badge tone="slate">{gap.mentions}× in posting</Badge>
                      <span className="w-full text-xs text-slate-500">
                        Nothing you have confirmed mentions {gap.keyword}.
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>

          {kit.postingQuestions.length > 0 ? (
            <Card>
              <SectionTitle hint="This posting also asks the following. ApplyPilot hasn't drafted these — they need your own words.">
                Other questions in this posting
              </SectionTitle>
              <ul className="space-y-2 text-sm text-slate-700">
                {kit.postingQuestions.map((question) => (
                  <li key={question}>• {question}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card id="role-details">
            <SectionTitle hint="Change what the letter calls the role or the company, and the kit rebuilds around it.">
              Role details
            </SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Role title</span>
                <Input value={titleDraft} onChange={setTitleDraft} placeholder="Marketing Coordinator" />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Company</span>
                <Input value={companyDraft} onChange={setCompanyDraft} placeholder="Northwind" />
              </label>
            </div>
            <button
              type="button"
              className={`${buttonStyles.secondary} mt-4`}
              onClick={() => handleRegenerate(true)}
              disabled={busy}
            >
              Save details &amp; rebuild kit
            </button>
          </Card>

          {kit.profileFactsUsed.length > 0 ? (
            <Card>
              <SectionTitle hint="One line per fact, in your own words from the review screen. What the kit does not check: the rest of the posting — the other questions it asks are listed above and need your own words.">
                Material from your profile that the kit drew on
              </SectionTitle>
              <ul className="space-y-1.5 text-sm text-slate-600">
                {kit.profileFactsUsed.map((fact) => (
                  <li key={fact}>• {fact}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="border-slate-300">
            <h2 className="text-sm font-semibold text-slate-900">Nothing has been sent anywhere</h2>
            <p className="mt-2 text-sm text-slate-600">
              ApplyPilot doesn&apos;t have your employer accounts and doesn&apos;t submit applications. Copy
              each piece into the employer&apos;s own form, check the wording, and send it yourself. Marking
              a kit as taken forward only tells ApplyPilot which one you&apos;re sending — it doesn&apos;t
              send it.
            </p>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
