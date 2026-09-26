import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { AppShell } from "~/components/AppShell";
import { MaterialsCard } from "~/components/MaterialsCard";
import { Card, Field, Input, SectionTitle, Select, Textarea, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { listMaterials, loadProfile, saveProfile } from "~/server/actions";
import { WORK_AUTHORISATION_OPTIONS } from "~/types";
import type { MaterialSummary, ProfileFormValues } from "~/types";

export const Route = createFileRoute("/profile")({
  beforeLoad: requireSession,
  loader: async () => {
    const [profileResult, materialsResult] = await Promise.all([loadProfile(), listMaterials()]);
    if (!profileResult.ok) return { ok: false as const, error: profileResult.error };
    return {
      ok: true as const,
      profile: profileResult.profile,
      materials: materialsResult.ok ? materialsResult.items : [],
    };
  },
  head: () => ({ meta: [{ title: "Profile vault — ApplyPilot" }] }),
  component: ProfilePage,
});

function ProfilePage() {
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

  return (
    <AppShell email={email}>
      <ProfileForm initial={data.profile} initialMaterials={data.materials} />
    </AppShell>
  );
}

type Status = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

function ProfileForm({
  initial,
  initialMaterials,
}: {
  initial: ProfileFormValues;
  initialMaterials: MaterialSummary[];
}) {
  const [form, setForm] = useState<ProfileFormValues>(initial);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  function patch(part: Partial<ProfileFormValues>) {
    setForm((previous) => ({ ...previous, ...part }));
    setStatus({ kind: "idle" });
  }

  /** An upload read text out of a résumé — show it in the (editable) box below. */
  function handleExtractedResume(text: string) {
    setForm((previous) => ({ ...previous, resume_text: text }));
    setStatus({ kind: "idle" });
  }

  function patchExperience(index: number, part: Partial<ProfileFormValues["experience"][number]>) {
    setForm((previous) => ({
      ...previous,
      experience: previous.experience.map((entry, i) => (i === index ? { ...entry, ...part } : entry)),
    }));
    setStatus({ kind: "idle" });
  }

  function patchEducation(index: number, part: Partial<ProfileFormValues["education"][number]>) {
    setForm((previous) => ({
      ...previous,
      education: previous.education.map((entry, i) => (i === index ? { ...entry, ...part } : entry)),
    }));
    setStatus({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await saveProfile({ data: { profile: form } });
    setBusy(false);
    setStatus(result.ok ? { kind: "saved" } : { kind: "error", message: result.error });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="sticky top-0 z-10 -mx-4 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">Profile vault</h1>
            <p className="text-xs text-slate-500">
              Saved once, reused in every application kit. Nothing here is ever sent anywhere on its own.
            </p>
          </div>
          {status.kind === "saved" ? (
            <span className="text-sm font-medium text-emerald-700">Saved ✓</span>
          ) : null}
          {status.kind === "error" ? (
            <span className="text-sm font-medium text-red-700">{status.message}</span>
          ) : null}
          <Link to="/applications" className={buttonStyles.secondary}>
            Applications
          </Link>
          <button type="submit" className={buttonStyles.primary} disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>

      <Card>
        <SectionTitle hint="These are the details every application form asks for.">About you</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <Input value={form.full_name} onChange={(v) => patch({ full_name: v })} placeholder="Alex Chen" />
          </Field>
          <Field label="Email">
            <Input value={form.email} onChange={(v) => patch({ email: v })} placeholder="alex@example.com" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(v) => patch({ phone: v })} placeholder="0400 000 000" />
          </Field>
          <Field label="Location" hint="City and country/state is plenty.">
            <Input value={form.location} onChange={(v) => patch({ location: v })} placeholder="Melbourne, Australia" />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionTitle hint="Any of these you have — they're added to your cover letter links.">Links</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Portfolio site">
            <Input value={form.portfolio_url} onChange={(v) => patch({ portfolio_url: v })} placeholder="https://…" />
          </Field>
          <Field label="GitHub">
            <Input value={form.github_url} onChange={(v) => patch({ github_url: v })} placeholder="https://github.com/…" />
          </Field>
          <Field label="LinkedIn">
            <Input value={form.linkedin_url} onChange={(v) => patch({ linkedin_url: v })} placeholder="https://linkedin.com/in/…" />
          </Field>
        </div>
      </Card>

      <MaterialsCard initial={initialMaterials} onExtractedResume={handleExtractedResume} />

      <Card id="resume">
        <SectionTitle hint="Upload a file above and the text lands here, or paste it straight in. Either way it's yours to edit — the kit quotes your own wording rather than paraphrasing it into something you didn't write.">
          Résumé text
        </SectionTitle>
        <Textarea
          value={form.resume_text}
          onChange={(v) => patch({ resume_text: v })}
          rows={14}
          placeholder={"Upload a résumé above, or paste your résumé here.\n\nExperience, projects, skills, education — plain text is fine. The more real detail there is, the more specific your cover letter gets."}
        />
        {form.resume_text.trim() ? (
          <p className="mt-2 text-xs text-slate-500">
            {form.resume_text.trim().length.toLocaleString()} characters. This is what every kit is built from —
            check it against your original file and fix anything that came out wrong.
          </p>
        ) : null}
      </Card>

      <Card id="experience">
        <SectionTitle hint="Most recent first. The most recent role leads your cover letter and 'about you' answer.">
          Experience
        </SectionTitle>
        <div className="space-y-4">
          {form.experience.length === 0 ? (
            <p className="text-sm text-slate-500">No roles added yet.</p>
          ) : null}
          {form.experience.map((entry, index) => (
            <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Job title">
                  <Input value={entry.title} onChange={(v) => patchExperience(index, { title: v })} placeholder="Marketing Coordinator" />
                </Field>
                <Field label="Company">
                  <Input value={entry.company} onChange={(v) => patchExperience(index, { company: v })} placeholder="Northwind" />
                </Field>
                <Field label="Start">
                  <Input value={entry.start} onChange={(v) => patchExperience(index, { start: v })} placeholder="Feb 2023" />
                </Field>
                <Field label="End" hint="Use “Present” for your current role.">
                  <Input value={entry.end} onChange={(v) => patchExperience(index, { end: v })} placeholder="Present" />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="What you did">
                  <Textarea
                    value={entry.description}
                    onChange={(v) => patchExperience(index, { description: v })}
                    rows={4}
                    placeholder="Ran the weekly campaign reporting, grew Instagram from 4k to 11k, wrote the launch copy for three product releases…"
                  />
                </Field>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className={buttonStyles.danger}
                  onClick={() =>
                    setForm((previous) => ({
                      ...previous,
                      experience: previous.experience.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove role
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`${buttonStyles.secondary} mt-4`}
          onClick={() =>
            setForm((previous) => ({
              ...previous,
              experience: [
                ...previous.experience,
                { title: "", company: "", start: "", end: "", description: "" },
              ],
            }))
          }
        >
          + Add a role
        </button>
      </Card>

      <Card id="education">
        <SectionTitle hint="Qualifications, degrees, certificates — anything a posting might ask you to prove.">
          Education &amp; qualifications
        </SectionTitle>
        <div className="space-y-4">
          {form.education.length === 0 ? <p className="text-sm text-slate-500">Nothing added yet.</p> : null}
          {form.education.map((entry, index) => (
            <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Qualification">
                  <Input value={entry.qualification} onChange={(v) => patchEducation(index, { qualification: v })} placeholder="Bachelor of Commerce" />
                </Field>
                <Field label="Institution">
                  <Input value={entry.school} onChange={(v) => patchEducation(index, { school: v })} placeholder="University of Melbourne" />
                </Field>
                <Field label="Dates">
                  <Input value={entry.dates} onChange={(v) => patchEducation(index, { dates: v })} placeholder="2019 – 2022" />
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Anything else" hint="Majors, grades, certificates, licences.">
                  <Textarea value={entry.details} onChange={(v) => patchEducation(index, { details: v })} rows={2} placeholder="Major in Marketing, WAM 78" />
                </Field>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className={buttonStyles.danger}
                  onClick={() =>
                    setForm((previous) => ({
                      ...previous,
                      education: previous.education.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`${buttonStyles.secondary} mt-4`}
          onClick={() =>
            setForm((previous) => ({
              ...previous,
              education: [...previous.education, { school: "", qualification: "", dates: "", details: "" }],
            }))
          }
        >
          + Add education
        </button>
      </Card>

      <Card>
        <SectionTitle hint="These come up in almost every application, so save the true answers once and the kit repeats them exactly.">
          Application basics
        </SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="work-authorisation" label="Work authorisation / visa status">
            <Select
              value={form.work_authorisation}
              onChange={(v) => patch({ work_authorisation: v })}
              options={WORK_AUTHORISATION_OPTIONS}
              placeholder="Choose your situation"
            />
          </Field>
          <Field label="Work authorisation note" hint="Optional — e.g. visa expiry, or “unrestricted hours”.">
            <Input
              value={form.work_authorisation_note}
              onChange={(v) => patch({ work_authorisation_note: v })}
              placeholder="Permanent resident since 2021"
            />
          </Field>
          <Field id="salary" label="Salary expectation" hint="Your wording, exactly as you want it used. Left blank? The kit says so instead of guessing.">
            <Input
              value={form.salary_expectation}
              onChange={(v) => patch({ salary_expectation: v })}
              placeholder="$70,000–$80,000 plus super"
            />
          </Field>
          <Field id="notice-period" label="Notice period">
            <Input
              value={form.notice_period}
              onChange={(v) => patch({ notice_period: v })}
              placeholder="4 weeks"
            />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonStyles.primary} disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
        {status.kind === "saved" ? (
          <span className="text-sm text-slate-600">
            Saved. Re-generate a kit to pick up your changes.
          </span>
        ) : null}
        {status.kind === "error" ? <span className="text-sm text-red-700">{status.message}</span> : null}
      </div>
    </form>
  );
}
