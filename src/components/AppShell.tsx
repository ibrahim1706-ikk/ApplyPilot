import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { signOut } from "~/server/actions";
import { buttonStyles } from "~/components/ui";
import { SiteFooter } from "~/components/public";

const NAV = [
  { to: "/applications", label: "Applications" },
  { to: "/new", label: "New application" },
  { to: "/profile", label: "Profile vault" },
  { to: "/qualifications", label: "What we found" },
  { to: "/answers", label: "Field answers" },
  { to: "/account", label: "Account" },
] as const;

/** Header + nav shared by every signed-in page. */
export function AppShell({ email, children }: { email: string; children: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    await router.invalidate();
    await navigate({ to: "/" });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <Link to="/applications" className="text-base font-semibold tracking-tight text-slate-900">
            ApplyPilot
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                activeProps={{ className: "rounded-lg px-3 py-1.5 bg-indigo-50 text-indigo-700" }}
                activeOptions={{ exact: false }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
            <span className="hidden sm:inline">{email}</span>
            <button type="button" className={buttonStyles.mini} onClick={handleSignOut} disabled={busy}>
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <SiteFooter />
    </div>
  );
}
