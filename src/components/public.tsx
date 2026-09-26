/**
 * Public page furniture: the header/footer every page outside the signed-in app
 * shares, so the privacy policy, the terms and the password-reset pages are
 * reachable (and linked) from anywhere. Client-safe: no server-only imports.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The business inbox, shown so anyone locked out has a way to reach a person. */
export const CONTACT_EMAIL = "applypilot-48900df7@ctomail.io";

export function SiteFooter({ note }: { note?: string }) {
  return (
    <footer className="mt-auto border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:px-6">
        <p className="max-w-2xl leading-relaxed">
          {note ??
            "ApplyPilot drafts from the details you saved. It never invents experience and never submits an application — you review, copy and send."}
        </p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto">
          <Link to="/privacy" className="font-medium text-slate-600 hover:text-indigo-600">
            Privacy
          </Link>
          <Link to="/terms" className="font-medium text-slate-600 hover:text-indigo-600">
            Terms
          </Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-slate-600 hover:text-indigo-600">
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** Narrow page shell (sign-in shaped) with the footer attached. */
export function PageShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-md"} px-4 py-14 sm:px-6`}>
        <Link to="/" className="text-base font-semibold tracking-tight text-slate-900">
          ApplyPilot
        </Link>
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}

/** A long-form document page (policy, terms): prose with a heading block. */
export function DocumentPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell wide>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated {updated}</p>
      <div className="mt-6 space-y-6 text-sm leading-relaxed text-slate-700">{intro}</div>
      <div className="mt-8 space-y-8 text-sm leading-relaxed text-slate-700">{children}</div>
      <p className="mt-10 text-sm text-slate-600">
        Questions about any of this? Write to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-indigo-600 hover:text-indigo-500">
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </PageShell>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <div className="mt-2 space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span aria-hidden className="select-none text-slate-400">
            •
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
