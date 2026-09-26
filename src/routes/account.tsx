import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { AppShell } from "~/components/AppShell";
import { SiteFooter } from "~/components/public";
import { Badge, Card, Field, Input, SectionTitle, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { accountOverview, deleteMyAccount, exportMyData } from "~/server/actions";

export const Route = createFileRoute("/account")({
  beforeLoad: requireSession,
  loader: async () => accountOverview(),
  head: () => ({ meta: [{ title: "Your account — ApplyPilot" }] }),
  component: AccountPage,
});

/** Hands a string to the browser as a file download. */
function downloadFile(filename: string, contents: string, mime = "application/json"): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function AccountPage() {
  const context = Route.useRouteContext();
  const overview = Route.useLoaderData();
  const router = useRouter();

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exported, setExported] = useState("");

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState<null | {
    email: string;
    removed: { profile: number; applications: number; materials: number; sessions: number; resetLinks: number; files: number };
  }>(null);

  async function handleExport() {
    setExporting(true);
    setExportError("");
    setExported("");
    const result = await exportMyData();
    setExporting(false);
    if (!result.ok) {
      setExportError(result.error);
      return;
    }
    try {
      downloadFile(result.filename, result.json);
      setExported(
        `${result.filename} — ${(result.json.length / 1024).toFixed(1)} kB. Check your downloads folder.`
      );
    } catch {
      setExportError("Your browser blocked the download. Try again, or from a different browser.");
    }
  }

  async function handleDelete(event: FormEvent) {
    event.preventDefault();
    setDeleting(true);
    setDeleteError("");
    const result = await deleteMyAccount({ data: { password, confirmation } });
    if (!result.ok) {
      setDeleteError(result.error);
      setDeleting(false);
      return;
    }
    setGone({ email: result.email, removed: result.removed });
    await router.invalidate();
  }

  if (gone) {
    return (
      <div className="flex min-h-dvh flex-col bg-slate-50">
        <main className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
          <Card>
            <h1 className="text-lg font-semibold text-slate-900">Your account has been deleted</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Everything ApplyPilot held for <strong>{gone.email}</strong> is gone, and you have been
              signed out. Removed just now:
            </p>
            <ul className="mt-3 space-y-1 text-sm text-slate-700">
              <li>• profile: {gone.removed.profile === 1 ? "removed" : "there was none stored"}</li>
              <li>• application kits: {gone.removed.applications} removed</li>
              <li>
                • uploaded materials: {gone.removed.materials} removed ({gone.removed.files} file
                {gone.removed.files === 1 ? "" : "s"} deleted from disk)
              </li>
              <li>• signed-in sessions: {gone.removed.sessions} invalidated</li>
              <li>• password-reset links: {gone.removed.resetLinks} removed</li>
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              A backup taken before now may still contain your data for up to 14 days, after which it is
              removed automatically. Ask us to clear it sooner if you need that.
            </p>
            <Link to="/" className={`${buttonStyles.primary} mt-6`}>
              Back to the start
            </Link>
          </Card>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const data = overview.ok ? overview : null;

  return (
    <AppShell email={context.email ?? ""}>
      <SectionTitle hint="Your data, your account, and the way out of both.">Account</SectionTitle>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold text-slate-900">What we hold for you</h2>
          {data ? (
            <ul className="mt-3 space-y-2 text-sm text-slate-700">
              <li>
                Email: <strong>{data.email}</strong>
              </li>
              <li>Account created: {new Date(data.createdAt).toLocaleDateString()}</li>
              <li>
                Profile vault:{" "}
                {data.resumeChars > 0
                  ? `résumé text saved (${data.resumeChars.toLocaleString()} characters)`
                  : "no résumé text yet"}
              </li>
              <li>Uploaded materials: {data.materials}</li>
              <li>Application kits: {data.applications}</li>
              <li className="text-xs text-slate-500">
                Stored on the server at <code className="break-all">{data.storageDir}</code>
              </li>
            </ul>
          ) : (
            <p className="mt-3 text-sm text-red-700">
              Couldn&apos;t load your account details. Reload the page.
            </p>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-slate-900">Password-reset email</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {data?.emailConfigured ? (
              <>
                <Badge tone="green">Configured</Badge>{" "}
                <span className="mt-2 block">
                  If you forget your password we can email you a single-use reset link.
                </span>
              </>
            ) : (
              <>
                <Badge tone="amber">Not configured yet</Badge>{" "}
                <span className="mt-2 block">
                  No mail credentials are set on this deployment, so we cannot send a reset link yet. The
                  reset page will say so plainly rather than pretending an email went out. Keep your
                  password somewhere safe, and write to the contact address in the footer if you lose it.
                </span>
              </>
            )}
          </p>
          <Link to="/forgot-password" className={`${buttonStyles.secondary} mt-4`}>
            Request a reset link
          </Link>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold text-slate-900">Export your data</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            One JSON file with your profile, the extracted text of every upload, every job posting and
            every kit. Your original uploaded files aren&apos;t embedded — download those from your
            profile vault.
          </p>
          <button
            type="button"
            onClick={handleExport}
            className={`${buttonStyles.primary} mt-4`}
            disabled={exporting}
          >
            {exporting ? "Preparing…" : "Download my data"}
          </button>
          {exported ? <p className="mt-3 text-sm text-emerald-700">{exported}</p> : null}
          {exportError ? (
            <p className="mt-3 text-sm text-red-700" role="alert">
              {exportError}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-slate-500">
            Read the{" "}
            <Link to="/privacy" className="font-medium text-indigo-600">
              privacy policy
            </Link>{" "}
            for exactly what is stored.
          </p>
        </Card>

        <Card className="border-red-200">
          <h2 className="text-sm font-semibold text-red-700">Delete my account</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            Removes your account, profile, uploads (including the files on disk), every application kit,
            every session and every reset link. Immediate, and there is no undo — export first if you
            want a copy.
          </p>
          <form onSubmit={handleDelete} className="mt-4 space-y-3">
            <Field label="Your password">
              <Input
                value={password}
                onChange={setPassword}
                type="password"
                name="delete-password"
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </Field>
            <Field label="Type DELETE to confirm" hint="Uppercase, exactly — a deliberate speed bump.">
              <Input
                value={confirmation}
                onChange={setConfirmation}
                name="delete-confirmation"
                placeholder="DELETE"
              />
            </Field>
            {deleteError ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {deleteError}
              </p>
            ) : null}
            <button type="submit" className={buttonStyles.danger} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete my account and everything in it"}
            </button>
          </form>
          <p className="mt-3 text-xs text-slate-500">
            A backup taken before now may hold your data for up to 14 days; ask us to clear it sooner if
            that matters.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
