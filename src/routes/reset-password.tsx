import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { Card, Field, Input, buttonStyles } from "~/components/ui";
import { PageShell } from "~/components/public";
import { resetPassword } from "~/server/actions";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  head: () => ({ meta: [{ title: "Set a new ApplyPilot password" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Those two passwords don't match. Nothing has been changed.");
      return;
    }
    setBusy(true);
    const result = await resetPassword({ data: { token, password } });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // The reset signs every other device out and signs this one in, so the next
    // stop is the app itself.
    await router.invalidate();
    await navigate({ to: "/applications" });
  }

  if (!token) {
    return (
      <PageShell>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">Set a new password</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page needs the single-use link we email you. Open that link, or ask for a new one.
        </p>
        <Link to="/forgot-password" className={`${buttonStyles.primary} mt-6`}>
          Send me a reset link
        </Link>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">Set a new password</h1>
      <p className="mt-2 text-sm text-slate-600">
        This link works once. Setting a new password signs out every other device that was signed in.
      </p>

      <Card className="mt-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="New password" hint="At least 8 characters. Stored hashed — never in the clear.">
            <Input
              value={password}
              onChange={setPassword}
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              placeholder="••••••••"
            />
          </Field>
          <Field label="Repeat new password">
            <Input
              value={confirm}
              onChange={setConfirm}
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              placeholder="••••••••"
            />
          </Field>
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className={`${buttonStyles.primary} w-full`} disabled={busy}>
            {busy ? "Saving…" : "Set new password"}
          </button>
        </form>
      </Card>

      <p className="mt-4 text-sm text-slate-600">
        Link expired or already used?{" "}
        <Link to="/forgot-password" className="font-medium text-indigo-600 hover:text-indigo-500">
          Request a new one
        </Link>
        .
      </p>
    </PageShell>
  );
}
