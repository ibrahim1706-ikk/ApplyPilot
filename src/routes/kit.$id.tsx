import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "~/components/AppShell";
import { Badge, Card, CopyBlock, Input, SectionTitle, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { deleteApplication, loadApplication, regenerateKit } from "~/server/actions";

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
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <Card className="border-slate-300">
            <div className="flex flex-wrap items-center gap-4">
              <div className="mr-auto">
                <p className="text-sm font-semibold text-slate-900">
                  Keyword match: {kit.keywordMatch.evidenced.length} of{" "}
                  {kit.keywordMatch.evidenced.length + kit.keywordMatch.missing.length} posting keywords are
                  evidenced by your profile
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {kit.profileCompleteness}% of your profile is filled in. More real detail in your profile
                  means a sharper kit — and gaps are never filled with guesses.
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
                Add the missing piece in your profile, save it, then press “Rebuild from my profile” — the kit picks
                it up. Nothing is filled in for you in the meantime.
              </p>
            </Card>
          ) : (
            <Card className="border-emerald-300 bg-emerald-50">
              <p className="text-sm text-emerald-900">
                Nothing flagged: every requirement this posting mentions is either evidenced by your profile
                or already answered in it.
              </p>
            </Card>
          )}

          <Card>
            <SectionTitle hint="Written from your profile text and this posting only. Quote it verbatim, or edit it — it's yours.">
              Cover letter
            </SectionTitle>
            <CopyBlock title="Cover letter" body={kit.coverLetter} />
          </Card>

          <Card>
            <SectionTitle hint="The questions almost every application asks, answered from what you saved — and labelled when your profile has nothing on it yet.">
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
                      {answer.missingInput ? <Badge tone="amber">Nothing saved for this yet</Badge> : null}
                      {answer.sources.length > 0 ? (
                        <span>Drawn from: {answer.sources.join("; ")}</span>
                      ) : (
                        <span>Drawn from: nothing in your profile yet</span>
                      )}
                    </div>
                  }
                />
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle hint="Keywords the posting uses, and whether your own profile already shows them.">
              Skills &amp; keyword match
            </SectionTitle>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Your profile shows these ({kit.keywordMatch.evidenced.length})
                </h3>
                <ul className="mt-3 space-y-3">
                  {kit.keywordMatch.evidenced.length === 0 ? (
                    <li className="text-sm text-slate-500">
                      None yet — add more detail to your résumé text and roles.
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
                  The posting asks for these, your profile doesn&apos;t mention them ({kit.keywordMatch.missing.length})
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
                        Your profile doesn&apos;t mention {gap.keyword}.
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
              <SectionTitle hint="Everything the kit used came from here.">Facts used from your profile</SectionTitle>
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
              each piece into the employer&apos;s own form, check the wording, and send it yourself.
            </p>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
