import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { Card, Field, Input, buttonStyles } from "~/components/ui";
import { SiteFooter } from "~/components/public";
import { requireSignedOut } from "~/route-guards";
import { signUp } from "~/server/actions";

export const Route = createFileRoute("/signup")({
  beforeLoad: requireSignedOut,
  head: () => ({ meta: [{ title: "Create your ApplyPilot account" }] }),
  component: SignUpPage,
});

function SignUpPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await signUp({ data: { email, password } });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    await router.invalidate();
    await navigate({ to: "/profile" });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <div className="mx-auto w-full max-w-md px-4 py-14 sm:px-6">
        <Link to="/" className="text-base font-semibold tracking-tight text-slate-900">
          ApplyPilot
        </Link>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">Create your account</h1>
        <p className="mt-2 text-sm text-slate-600">
          You&apos;ll fill in your profile vault next — it takes a few minutes once, and every application kit
          is built from it.
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
            <Field label="Password" hint="At least 8 characters. Stored hashed — never in the clear.">
              <Input
                value={password}
                onChange={setPassword}
                type="password"
                name="password"
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
              {busy ? "Creating your account…" : "Create account"}
            </button>
          </form>
        </Card>

        <p className="mt-4 text-sm text-slate-600">
          Already have an account?{" "}
          <Link to="/signin" className="font-medium text-indigo-600 hover:text-indigo-500">
            Sign in
          </Link>
        </p>

        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          By creating an account you agree to the{" "}
          <Link to="/terms" className="font-medium text-slate-600 underline hover:text-indigo-600">
            terms of use
          </Link>
          . Read the{" "}
          <Link to="/privacy" className="font-medium text-slate-600 underline hover:text-indigo-600">
            privacy policy
          </Link>{" "}
          to see exactly what we store and how to delete it — one line: your profile and files stay
          private to you, and ApplyPilot never submits anything to an employer.
        </p>
      </div>
      <SiteFooter />
    </div>
  );
}
