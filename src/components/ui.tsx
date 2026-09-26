/**
 * Small shared UI pieces. Client-safe: no server-only imports here.
 */
import { useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

export function Card({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  /** Optional anchor id, so "add it here" links can land on this card. */
  id?: string;
}) {
  return (
    <section id={id} className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-slate-900">{children}</h2>
      {hint ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
    </div>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

export const buttonStyles = {
  primary: `${BUTTON_BASE} bg-indigo-600 text-white hover:bg-indigo-500`,
  secondary: `${BUTTON_BASE} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`,
  subtle: `${BUTTON_BASE} border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100`,
  danger: `${BUTTON_BASE} border border-red-200 bg-white text-red-600 hover:bg-red-50`,
  mini: "inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50",
};

export function Field({
  label,
  hint,
  children,
  id,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Optional anchor id, so a "add it here" link can land on this field. */
  id?: string;
}) {
  return (
    <label id={id} className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100";

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  name,
  autoComplete,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <input
      className={INPUT_CLASS}
      type={type}
      name={name}
      autoComplete={autoComplete}
      required={required}
      placeholder={placeholder}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 6,
  name,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  name?: string;
}) {
  return (
    <textarea
      className={`${INPUT_CLASS} leading-relaxed`}
      rows={rows}
      name={name}
      placeholder={placeholder}
      value={value}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder: string;
}) {
  return (
    <select
      className={INPUT_CLASS}
      value={value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function Badge({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "green" | "amber" | "indigo" | "red";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    indigo: "bg-indigo-50 text-indigo-700",
    red: "bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Copy-to-clipboard button with a fallback for browsers without the async API. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function handleCopy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopy(text);
      }
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button type="button" onClick={handleCopy} className={buttonStyles.mini}>
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Press Ctrl+C" : label}
    </button>
  );
}

/** A titled block of generated text with its own copy button. */
export function CopyBlock({
  title,
  body,
  meta,
  hint,
}: {
  title: string;
  body: string;
  meta?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <CopyButton text={body} />
      </div>
      {hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null}
      <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">
        {body}
      </pre>
      {meta ? <div className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-500">{meta}</div> : null}
    </div>
  );
}
