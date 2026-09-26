import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { Card, Field, Input, buttonStyles } from "~/components/ui";
import { PageShell } from "~/components/public";
import { requireSignedOut } from "~/route-guards";
import { requestPasswordReset } from "~/server/actions";

export const Route = createFileRoute("/forgot-password")({
  beforeLoad: requireSignedOut,
  head: () => ({ meta: [{ title: "Reset your ApplyPilot password" }] }),
  component: ForgotPasswordPage,
});

type Outcome = { delivered: boolean; configured: boolean; message: string };

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setOutcome(null);
    const result = await requestPasswordReset({ data: { email } });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    setOutcome({
      delivered: result.delivered,
      configured: result.configured,
      message: result.message,
    });
    setBusy(false);
  }

  return (
    <PageShell>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">Reset your password</h1>
      <p className="mt-2 text-sm text-slate-600">
        Enter the email address on your account and we&apos;ll send a link to set a new password. The link
        works once and expires an hour after you ask for it.
      </p>

      <Card className="mt-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email">
            <Input
              value={email}
              onChange={setEmail}
              type="email"
              name="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className={`${buttonStyles.primary} w-full`} disabled={busy}>
            {busy ? "Checking…" : "Send me a reset link"}
          </button>
        </form>
      </Card>

      {outcome ? (
        <div
          role="status"
          className={
            outcome.configured
              ? "mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700"
              : "mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900"
          }
        >
          {!outcome.configured ? (
            <p className="mb-2 font-semibold">No email was sent.</p>
          ) : null}
          <p>{outcome.message}</p>
        </div>
      ) : null}

      <p className="mt-4 text-sm text-slate-600">
        Remembered it?{" "}
        <Link to="/signin" className="font-medium text-indigo-600 hover:text-indigo-500">
          Sign in
        </Link>
        . No account yet?{" "}
        <Link to="/signup" className="font-medium text-indigo-600 hover:text-indigo-500">
          Create one
        </Link>
        .
      </p>
    </PageShell>
  );
}
