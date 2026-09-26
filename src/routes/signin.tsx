import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { Card, Field, Input, buttonStyles } from "~/components/ui";
import { SiteFooter } from "~/components/public";
import { requireSignedOut } from "~/route-guards";
import { signIn } from "~/server/actions";

export const Route = createFileRoute("/signin")({
  beforeLoad: requireSignedOut,
  head: () => ({ meta: [{ title: "Sign in to ApplyPilot" }] }),
  component: SignInPage,
});

function SignInPage() {
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
    const result = await signIn({ data: { email, password } });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      return;
    }
    await router.invalidate();
    await navigate({ to: "/applications" });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <div className="mx-auto w-full max-w-md px-4 py-14 sm:px-6">
        <Link to="/" className="text-base font-semibold tracking-tight text-slate-900">
          ApplyPilot
        </Link>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your profile vault and every application kit you&apos;ve generated are waiting.
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
            <Field label="Password">
              <Input
                value={password}
                onChange={setPassword}
                type="password"
                name="password"
                autoComplete="current-password"
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
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </Card>

        <p className="mt-4 text-sm text-slate-600">
          No account yet?{" "}
          <Link to="/signup" className="font-medium text-indigo-600 hover:text-indigo-500">
            Create one
          </Link>
        </p>

        <p className="mt-2 text-sm text-slate-600">
          Forgotten your password?{" "}
          <Link to="/forgot-password" className="font-medium text-indigo-600 hover:text-indigo-500">
            Reset it
          </Link>
        </p>
      </div>
      <SiteFooter />
    </div>
  );
}
