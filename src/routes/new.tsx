import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { AppShell } from "~/components/AppShell";
import { Card, Field, Input, SectionTitle, Textarea, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { createApplication, fetchPosting } from "~/server/actions";

export const Route = createFileRoute("/new")({
  beforeLoad: requireSession,
  head: () => ({ meta: [{ title: "New application — ApplyPilot" }] }),
  component: NewApplicationPage,
});

type Banner = { kind: "idle" } | { kind: "error" | "info" | "ok"; message: string };

function NewApplicationPage() {
  const context = Route.useRouteContext();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [banner, setBanner] = useState<Banner>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);

  async function handleReadLink() {
    setReading(true);
    setBanner({ kind: "idle" });
    const result = await fetchPosting({ data: { url } });
    setReading(false);
    if (!result.ok) {
      setBanner({ kind: "error", message: result.error });
      return;
    }
    setText(result.text);
    if (!title && result.title) setTitle(result.title);
    if (!company && result.company) setCompany(result.company);
    setBanner({ kind: "ok", message: "Read the posting — check it over, then generate the kit." });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setBanner({ kind: "idle" });
    const result = await createApplication({ data: { url, text, title, company } });
    if (!result.ok) {
      setBusy(false);
      setBanner({ kind: "error", message: result.error });
      return;
    }
    await navigate({ to: "/kit/$id", params: { id: result.id } });
  }

  return (
    <AppShell email={context.email ?? ""}>
      <h1 className="text-lg font-semibold tracking-tight text-slate-900">New application</h1>
      <p className="mt-1 text-sm text-slate-600">
        Give ApplyPilot the posting and it will build the kit — cover letter, drafted answers and a keyword
        match — from your profile.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <Card>
          <SectionTitle hint="Pasting the text always works. The link is just a shortcut, and some job boards block it.">
            The posting
          </SectionTitle>

          <Field label="Posting link (optional)">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex-1">
                <Input value={url} onChange={setUrl} placeholder="https://boards.greenhouse.io/acme/jobs/123456" />
              </div>
              <button
                type="button"
                className={buttonStyles.secondary}
                onClick={handleReadLink}
                disabled={reading || url.trim().length === 0}
              >
                {reading ? "Reading…" : "Try to read the link"}
              </button>
            </div>
          </Field>

          <div className="mt-4">
            <Field
              label="Job posting text"
              hint="Paste the whole ad — duties, requirements, the lot. This is what the kit matches your profile against."
            >
              <Textarea
                value={text}
                onChange={setText}
                rows={14}
                placeholder={"Paste the job ad here.\n\nInclude the requirements section if you can — that's what the keyword match is built from."}
              />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Role title (optional)" hint="Detected automatically when possible.">
              <Input value={title} onChange={setTitle} placeholder="Marketing Coordinator" />
            </Field>
            <Field label="Company (optional)" hint="Detected from the link or the ad when possible.">
              <Input value={company} onChange={setCompany} placeholder="Northwind" />
            </Field>
          </div>

          {banner.kind !== "idle" ? (
            <p
              className={`mt-4 rounded-lg px-3 py-2 text-sm ${
                banner.kind === "error"
                  ? "bg-red-50 text-red-700"
                  : banner.kind === "ok"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-100 text-slate-700"
              }`}
            >
              {banner.message}
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="submit" className={buttonStyles.primary} disabled={busy}>
              {busy ? "Building your kit…" : "Generate application kit"}
            </button>
            <span className="text-xs text-slate-500">
              Building takes a second. Your kit is saved so you can come back to it.
            </span>
          </div>
        </Card>
      </form>

      <Card className="mt-5 border-slate-300">
        <h2 className="text-sm font-semibold text-slate-900">Before you paste anything</h2>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
          <li>
            • Make sure your{" "}
            <a className="font-medium text-indigo-600 hover:text-indigo-500" href="/profile">
              profile vault
            </a>{" "}
            is filled in — the kit can only use what's there.
          </li>
          <li>• ApplyPilot generates drafts. It does not apply for you, and it never sends anything.</li>
        </ul>
      </Card>
    </AppShell>
  );
}
