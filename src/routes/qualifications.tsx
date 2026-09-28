/**
 * "Your qualifications" — the place the fact set becomes the user's own.
 *
 * Stage 1 read the user's own material and showed what it found. This screen is
 * stage 2: every fact can be kept, corrected, excluded or added to, a set can be
 * confirmed as a whole, and the confirmed time is stored for the next piece of
 * work (answering real application fields from these facts — not wired up yet).
 *
 * The rules this screen has to hold, because provenance is the product:
 *   - a fact the user typed is labelled as theirs and is never quoted as if it
 *     came out of the résumé;
 *   - a corrected fact still shows the original line beside it, marked as edited;
 *   - nothing is inferred anywhere — where the material is silent the copy says
 *     so, and offers the honest way to fill the gap;
 *   - nothing here sends anything anywhere: the app has no submit path.
 */
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "~/components/AppShell";
import { Card, Field, Input, SectionTitle, Textarea, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import {
  addFact,
  confirmFacts,
  correctFact,
  excludeFact,
  keepFact,
  loadQualifications,
  restoreFact,
} from "~/server/actions";
import {
  FACT_BADGE_COPY,
  FACT_CATEGORY_COPY,
  FACT_CATEGORY_ORDER,
  FACT_FIELDS,
  factBadge,
  factSourceCaption,
  groupFacts,
} from "~/types";
import type {
  ConfirmationStatus,
  ExtractionReport,
  Fact,
  FactCategory,
} from "~/types";

export const Route = createFileRoute("/qualifications")({
  beforeLoad: requireSession,
  loader: async () => {
    const result = await loadQualifications();
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      facts: result.facts,
      report: result.report,
      computedAt: result.computedAt,
      recomputed: result.recomputed,
      decisionNotes: result.decisionNotes,
      decisionsUpdatedAt: result.decisionsUpdatedAt,
      confirmations: result.confirmations,
      confirmationStatus: result.confirmationStatus,
    };
  },
  head: () => ({ meta: [{ title: "Your qualifications — ApplyPilot" }] }),
  component: QualificationsPage,
});

type Message = { kind: "ok" | "error"; text: string };
type SaveResult = { ok: boolean; error?: string };

function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function emptiesFor(category: FactCategory, fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of FACT_FIELDS[category]) out[spec.key] = fields[spec.key] ?? "";
  return out;
}

function QualificationsPage() {
  const data = Route.useLoaderData();
  const context = Route.useRouteContext();
  const router = useRouter();
  const email = context.email ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<{ id: string; fields: Record<string, string> } | null>(null);
  const [adding, setAdding] = useState<{ category: FactCategory; fields: Record<string, string>; note: string } | null>(
    null
  );

  if (!data.ok) {
    return (
      <AppShell email={email}>
        <Card>
          <p className="text-sm text-slate-700">{data.error}</p>
        </Card>
      </AppShell>
    );
  }

  /** Every action goes through here: write, re-read from the server, say what happened. */
  async function act(key: string, work: () => Promise<SaveResult>, okText: string): Promise<boolean> {
    setBusy(key);
    setMessage(null);
    const result = await work();
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error ?? "That didn't save. Try again." });
      setBusy(null);
      return false;
    }
    setEditing(null);
    setAdding(null);
    await router.invalidate();
    setBusy(null);
    setMessage({ kind: "ok", text: okText });
    return true;
  }

  const grouped = groupFacts(data.facts);
  const inSet = data.facts.filter((fact) => fact.status !== "excluded");
  const confirmed = data.facts.filter((fact) => fact.status === "confirmed");
  const pending = inSet.filter((fact) => fact.status !== "confirmed");
  const excluded = data.facts.filter((fact) => fact.status === "excluded");
  const emptyCategories = grouped.filter((group) => group.facts.length === 0);
  const overall = data.confirmationStatus.overall;

  return (
    <AppShell email={email}>
      <div className="space-y-5">
        <Card>
          <SectionTitle hint="Kept, corrected or added by you — nothing here is inferred, and nothing leaves this page.">
            Your qualifications
          </SectionTitle>
          <p className="text-sm leading-relaxed text-slate-700">
            Everything below was read out of your own material — your résumé text and the fields you saved in the
            profile vault — and each item shows the line it came from, word for word. Read it, fix what's wrong,
            remove what doesn't belong, and add anything we missed. Then confirm the set: the facts you confirm are
            the only ones this account will ever answer a job application from, and where they don't cover
            something, the app says so rather than filling the gap.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-700">
            Nothing on this page is sent anywhere and nothing is submitted: ApplyPilot has no submit path. When the
            form-filling agent arrives it works in a window you watch, and it will only ever use what you have
            confirmed here.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Facts in your set" value={inSet.length === 0 ? "None yet" : String(inSet.length)} />
            <Stat
              label="Confirmed by you"
              value={`${String(confirmed.length)} of ${String(inSet.length)}`}
              hint={pending.length === 0 ? undefined : `${String(pending.length)} still to confirm`}
            />
            <Stat
              label="Excluded by you"
              value={excluded.length === 0 ? "None" : String(excluded.length)}
              hint={excluded.length === 0 ? undefined : "still listed, so you can bring them back"}
            />
            <Stat label="Material read" value={`${data.report.resumeChars.toLocaleString()} characters`} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            Last read {shortTime(data.computedAt)}
            {data.recomputed ? " — re-read just now, because your material changed." : "."}
            {data.decisionsUpdatedAt ? ` Last decision saved ${shortTime(data.decisionsUpdatedAt)}.` : ""}
          </p>
        </Card>

        {message ? (
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm ${
              message.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        <ConfirmAllCard
          facts={inSet}
          status={overall}
          at={data.confirmations.overall?.at ?? null}
          busy={busy === "confirm-overall"}
          onConfirm={() =>
            act(
              "confirm-overall",
              () => confirmFacts({ data: { scope: "overall" } }),
              "Confirmed — every fact in your set is now the set this account will answer from."
            )
          }
        />

        {data.decisionNotes.length > 0 ? (
          <Card>
            <SectionTitle hint="What happened to the decisions you had already made when your material was last read.">
              How your decisions were carried over
            </SectionTitle>
            <ul className="space-y-2 text-sm text-slate-700">
              {data.decisionNotes.map((note, index) => (
                <li key={index} className="flex gap-2">
                  <span aria-hidden className="text-slate-400">
                    —
                  </span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {FACT_CATEGORY_ORDER.map((category) => (
          <CategoryCard
            key={category}
            category={category}
            facts={grouped.find((group) => group.category === category)?.facts ?? []}
            status={data.confirmationStatus.categories[category]}
            confirmedAt={data.confirmations.categories[category]?.at ?? null}
            busy={busy}
            editing={editing}
            adding={adding?.category === category ? adding : null}
            onStartEdit={(fact) => {
              setMessage(null);
              setEditing({ id: fact.id, fields: emptiesFor(category, fact.fields) });
            }}
            onChangeEdit={(fields) => setEditing((current) => (current ? { ...current, fields } : current))}
            onCancelEdit={() => setEditing(null)}
            onSaveEdit={(fact) =>
              act(
                `save-${fact.id}`,
                () =>
                  correctFact({
                    data: {
                      id: fact.id,
                      fields: (editing?.id === fact.id ? editing.fields : fact.fields) as Record<string, string>,
                    },
                  }),
                "Saved your wording. Your original line is still shown beside it."
              )
            }
            onKeep={(fact) =>
              act(
                `keep-${fact.id}`,
                () => keepFact({ data: { id: fact.id } }),
                "Kept — this fact is confirmed as yours."
              )
            }
            onExclude={(fact) =>
              act(
                `exclude-${fact.id}`,
                () => excludeFact({ data: { id: fact.id } }),
                "Excluded. It stays listed below so nothing you typed is lost, and you can bring it back."
              )
            }
            onRestore={(fact) =>
              act(
                `restore-${fact.id}`,
                () => restoreFact({ data: { id: fact.id } }),
                fact.origin === "user"
                  ? "Removed that fact — it was yours, so nothing else is affected."
                  : "Brought back — the fact is unconfirmed again and reads exactly as your material does."
              )
            }
            onStartAdd={() => {
              setMessage(null);
              setAdding({ category, fields: emptiesFor(category, {}), note: "" });
            }}
            onChangeAdd={(fields, note) => setAdding((current) => (current ? { ...current, fields, note } : current))}
            onCancelAdd={() => setAdding(null)}
            onAdd={() =>
              act(
                `add-${category}`,
                () =>
                  addFact({
                    data: { category, fields: adding?.fields ?? {}, note: adding?.note ?? "" },
                  }),
                "Added as your own fact — it's labelled that way, and no résumé line is claimed for it."
              )
            }
            onConfirm={() =>
              act(
                `confirm-${category}`,
                () => confirmFacts({ data: { scope: category } }),
                "Confirmed. That is the set this account will answer from for this part of your qualifications."
              )
            }
          />
        ))}

        <EmptyStatesCard emptyCategories={emptyCategories.map((group) => group.category)} report={data.report} />

        <Card>
          <SectionTitle hint="Every heading the extractor recognised in your résumé text, and the line it was on.">
            What we read
          </SectionTitle>
          {data.report.sections.length === 0 ? (
            <p className="text-sm text-slate-600">
              We didn't recognise any section headings in your résumé text
              {data.report.resumeChars === 0 ? " — there is no résumé text saved yet." : "."}{" "}
              {data.report.resumeChars === 0 ? (
                <>
                  Add your résumé on the{" "}
                  <Link to="/profile" className="font-medium text-indigo-700 underline">
                    profile vault
                  </Link>{" "}
                  and this list will fill in.
                </>
              ) : (
                "Headings like EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS and LANGUAGES are the ones we know."
              )}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.report.sections.map((section, index) => (
                <li
                  key={`${section.line}-${index}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                >
                  <span className="font-medium text-slate-800">{section.heading}</span>
                  <span className="text-xs text-slate-500">
                    line {section.line} · read as “{section.kind}”
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              What happens to my corrections when I change my résumé
            </summary>
            <ul className="mt-2 space-y-2 text-sm text-slate-700">
              <li>
                Changing your résumé text or your vault fields makes us re-read your material on the next visit, so
                you are never shown facts from a résumé you have already replaced.
              </li>
              <li>
                Your decisions survive that. A fact you kept, corrected or excluded is matched to the same fact in
                the new reading — if its line merely moved, your decision still applies and the line quoted beside
                it is the new one.
              </li>
              <li>
                If a fact you corrected is gone from your material entirely, <strong>your version is kept</strong>{" "}
                and marked as coming from a line your material no longer has. Nothing you typed is deleted. A fact you{" "}
                <strong>kept</strong> whose line goes the same way stays kept, and is marked the same way — we never
                record a decision you did not make.
              </li>
              <li>
                A fact you excluded stays excluded, and stays listed, so it never quietly returns.
              </li>
              <li>
                Facts you added yourself are kept as yours. Confirming a set again is asked for whenever that set
                changes.
              </li>
            </ul>
          </details>
        </Card>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{value}</dd>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function confirmSummary(status: ConfirmationStatus, at: string | null): { label: string; className: string } {
  if (status === "confirmed")
    return { label: `confirmed ${shortTime(at)}`, className: "border-emerald-200 bg-emerald-50 text-emerald-800" };
  if (status === "changed")
    return {
      label: `changed since you confirmed it (${shortTime(at)})`,
      className: "border-amber-200 bg-amber-50 text-amber-900",
    };
  return { label: "not confirmed yet", className: "border-slate-200 bg-slate-50 text-slate-600" };
}

function ConfirmAllCard({
  facts,
  status,
  at,
  busy,
  onConfirm,
}: {
  facts: Fact[];
  status: ConfirmationStatus;
  at: string | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const summary = confirmSummary(status, at);
  return (
    <Card>
      <SectionTitle hint="This is the flag that lets these facts be used to answer a real application field.">
        Confirm the whole set
      </SectionTitle>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${summary.className}`}>
          {summary.label}
        </span>
        <span className="text-sm text-slate-600">
          {facts.length === 0
            ? "There is nothing to confirm yet — read the screen below and add what's true for you."
            : `${String(facts.length)} fact${facts.length === 1 ? "" : "s"} would be confirmed as right, exactly as they now read.`}
        </span>
        <button
          type="button"
          className={`${buttonStyles.primary} ml-auto`}
          data-testid="confirm-overall"
          disabled={busy || facts.length === 0}
          onClick={onConfirm}
        >
          {busy ? "Confirming…" : status === "confirmed" ? "Confirm again" : "Confirm this set is right"}
        </button>
      </div>
    </Card>
  );
}

function CategoryCard(props: {
  category: FactCategory;
  facts: Fact[];
  status: ConfirmationStatus;
  confirmedAt: string | null;
  busy: string | null;
  editing: { id: string; fields: Record<string, string> } | null;
  adding: { category: FactCategory; fields: Record<string, string>; note: string } | null;
  onStartEdit: (fact: Fact) => void;
  onChangeEdit: (fields: Record<string, string>) => void;
  onCancelEdit: () => void;
  onSaveEdit: (fact: Fact) => void;
  onKeep: (fact: Fact) => void;
  onExclude: (fact: Fact) => void;
  onRestore: (fact: Fact) => void;
  onStartAdd: () => void;
  onChangeAdd: (fields: Record<string, string>, note: string) => void;
  onCancelAdd: () => void;
  onAdd: () => void;
  onConfirm: () => void;
}) {
  const {
    category,
    facts,
    status,
    confirmedAt,
    busy,
    editing,
    adding,
    onStartEdit,
    onChangeEdit,
    onCancelEdit,
    onSaveEdit,
    onKeep,
    onExclude,
    onRestore,
    onStartAdd,
    onChangeAdd,
    onCancelAdd,
    onAdd,
    onConfirm,
  } = props;
  const copy = FACT_CATEGORY_COPY[category];
  const fromResume = facts.filter((fact) => fact.source.kind === "resume").length;
  const fromVault = facts.filter((fact) => fact.source.kind === "profile").length;
  const added = facts.filter((fact) => fact.origin === "user").length;
  const usable = facts.filter((fact) => fact.status !== "excluded");
  const summary = confirmSummary(status, confirmedAt);

  return (
    <Card>
      <SectionTitle hint={copy.hint}>{copy.title}</SectionTitle>

      {facts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-3 py-3 text-sm text-slate-600">
          {copy.empty}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {facts.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                busy={busy}
                editing={editing?.id === fact.id ? editing.fields : null}
                onChangeEdit={onChangeEdit}
                onStartEdit={() => onStartEdit(fact)}
                onCancelEdit={onCancelEdit}
                onSaveEdit={() => onSaveEdit(fact)}
                onKeep={() => onKeep(fact)}
                onExclude={() => onExclude(fact)}
                onRestore={() => onRestore(fact)}
              />
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            {facts.length} listed
            {fromResume > 0 ? ` · ${fromResume} quoted from your résumé text` : ""}
            {fromVault > 0 ? ` · ${fromVault} from your vault fields` : ""}
            {added > 0 ? ` · ${added} you added yourself` : ""}
          </p>
        </>
      )}

      {adding ? (
        <AddForm
          category={category}
          fields={adding.fields}
          note={adding.note}
          busy={busy === `add-${category}`}
          onChange={onChangeAdd}
          onCancel={onCancelAdd}
          onAdd={onAdd}
        />
      ) : (
        <button
          id={`add-${category}`}
          type="button"
          className={`${buttonStyles.secondary} mt-4`}
          data-testid={`add-open-${category}`}
          onClick={onStartAdd}
        >
          {copy.addLabel}
        </button>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${summary.className}`}>
          {summary.label}
        </span>
        <span className="text-xs text-slate-500">
          {usable.length === 0
            ? "Nothing to confirm here yet."
            : `${String(usable.length)} fact${usable.length === 1 ? "" : "s"} in this set.`}
        </span>
        <button
          type="button"
          className={`${buttonStyles.primary} ml-auto`}
          data-testid={`confirm-${category}`}
          disabled={busy === `confirm-${category}` || usable.length === 0}
          onClick={onConfirm}
        >
          {busy === `confirm-${category}`
            ? "Confirming…"
            : status === "confirmed"
              ? "Confirm again"
              : "Confirm these are right"}
        </button>
      </div>
    </Card>
  );
}

function FactRow(props: {
  fact: Fact;
  busy: string | null;
  editing: Record<string, string> | null;
  onChangeEdit: (fields: Record<string, string>) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onKeep: () => void;
  onExclude: () => void;
  onRestore: () => void;
}) {
  const { fact, busy, editing, onChangeEdit, onStartEdit, onCancelEdit, onSaveEdit, onKeep, onExclude, onRestore } =
    props;
  const badge = FACT_BADGE_COPY[factBadge(fact)];
  const extraFields = Object.entries(fact.fields).filter(
    ([field, value]) => field !== "value" && value.trim() !== ""
  );
  const excluded = fact.status === "excluded";
  const working = busy !== null && busy.endsWith(fact.id);

  return (
    <li
      data-testid={`fact-${fact.id}`}
      data-status={fact.status}
      data-origin={fact.origin}
      className={`rounded-xl border px-3 py-3 ${
        excluded ? "border-slate-200 bg-slate-50/70" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fact.label}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>{badge.label}</span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-slate-500">
            Correcting replaces our reading with your own wording. The line your material has stays beside it, marked
            as edited by you — nothing is overwritten.
          </p>
          {FACT_FIELDS[fact.category].map((spec) => (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              {spec.multiline ? (
                <Textarea
                  value={editing[spec.key] ?? ""}
                  rows={3}
                  onChange={(value) => onChangeEdit({ ...editing, [spec.key]: value })}
                />
              ) : (
                <Input
                  value={editing[spec.key] ?? ""}
                  placeholder={spec.placeholder}
                  onChange={(value) => onChangeEdit({ ...editing, [spec.key]: value })}
                />
              )}
            </Field>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonStyles.primary}
              data-testid={`save-${fact.id}`}
              disabled={working}
              onClick={onSaveEdit}
            >
              {working ? "Saving…" : "Save my version"}
            </button>
            <button type="button" className={buttonStyles.subtle} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={`mt-1 whitespace-pre-wrap text-sm font-medium ${
              excluded ? "text-slate-500 line-through" : "text-slate-900"
            }`}
          >
            {fact.value}
          </p>
          {extraFields.length > 0 ? (
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
              {extraFields.map(([field, value]) => (
                <div key={field} className="flex gap-1">
                  <dt className="text-slate-500">{FIELD_LABELS[field] ?? field}:</dt>
                  <dd className="whitespace-pre-wrap">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {fact.origin === "user" ? (
            <figure className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2">
              <blockquote className="whitespace-pre-wrap text-xs leading-relaxed text-indigo-900">
                {fact.value}
              </blockquote>
              <figcaption className="mt-1 text-[11px] text-indigo-800">
                You added this yourself, on {shortTime(fact.decidedAt)}. It did not come from a file you uploaded, so
                there is no résumé line to quote for it.
                {fact.userNote ? ` Your note: ${fact.userNote}` : ""}
              </figcaption>
            </figure>
          ) : (
            <figure className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <blockquote className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
                {fact.quote}
              </blockquote>
              <figcaption className="mt-1 text-[11px] text-slate-500">{factSourceCaption(fact)}</figcaption>
            </figure>
          )}

          {fact.edited && fact.originalValue && fact.originalValue !== fact.value ? (
            <p className="mt-2 text-xs text-amber-900">
              What your material read: <span className="font-medium">{fact.originalValue}</span> — kept here so you
              can see what you changed.
            </p>
          ) : null}

          {fact.sourceGone ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {fact.edited
                ? "The line this was read from is no longer in your material. Your version is kept as you wrote it — nothing you typed was deleted — and it is marked here so you can decide whether it still applies."
                : "The line this was read from is no longer in your material. The fact is kept exactly as it was read, because you said it was right — it is marked here so you can decide whether it still applies."}
            </p>
          ) : null}

          {fact.note ? <p className="mt-2 text-xs text-slate-500">{fact.note}</p> : null}
          {fact.decidedAt && fact.status === "confirmed" && !fact.edited ? (
            <p className="mt-2 text-xs text-emerald-800">Kept by you on {shortTime(fact.decidedAt)}.</p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {excluded ? (
              <button
                type="button"
                className={buttonStyles.secondary}
                data-testid={`restore-${fact.id}`}
                disabled={working}
                onClick={onRestore}
              >
                {fact.origin === "user" ? "Delete this fact" : "Bring it back"}
              </button>
            ) : (
              <>
                {fact.status !== "confirmed" ? (
                  <button
                    type="button"
                    className={buttonStyles.primary}
                    data-testid={`keep-${fact.id}`}
                    disabled={working}
                    onClick={onKeep}
                  >
                    This is right — keep it
                  </button>
                ) : null}
                <button
                  type="button"
                  className={buttonStyles.secondary}
                  data-testid={`edit-${fact.id}`}
                  disabled={working}
                  onClick={onStartEdit}
                >
                  Correct it
                </button>
                <button
                  type="button"
                  className={buttonStyles.danger}
                  data-testid={`exclude-${fact.id}`}
                  disabled={working}
                  onClick={onExclude}
                >
                  Exclude it
                </button>
                {fact.status === "confirmed" && fact.edited ? (
                  <button
                    type="button"
                    className={buttonStyles.subtle}
                    data-testid={`undo-${fact.id}`}
                    disabled={working}
                    onClick={onRestore}
                  >
                    Undo my edit
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function AddForm({
  category,
  fields,
  note,
  busy,
  onChange,
  onCancel,
  onAdd,
}: {
  category: FactCategory;
  fields: Record<string, string>;
  note: string;
  busy: boolean;
  onChange: (fields: Record<string, string>, note: string) => void;
  onCancel: () => void;
  onAdd: () => void;
}) {
  return (
    <div
      className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/40 px-3 py-3"
      data-testid={`add-form-${category}`}
    >
      <p className="text-sm font-medium text-slate-800">Add something the reading missed</p>
      <p className="mt-1 text-xs text-slate-600">
        This is stored as your own fact, labelled “you added this”. It is never presented as something your résumé
        said, and it is never guessed at — only what you type here goes in.
      </p>
      <div className="mt-3 space-y-3">
        {FACT_FIELDS[category].map((spec) => (
          <Field key={spec.key} label={spec.label} hint={spec.hint}>
            {spec.multiline ? (
              <Textarea
                value={fields[spec.key] ?? ""}
                rows={3}
                onChange={(value) => onChange({ ...fields, [spec.key]: value }, note)}
              />
            ) : (
              <Input
                value={fields[spec.key] ?? ""}
                placeholder={spec.placeholder}
                onChange={(value) => onChange({ ...fields, [spec.key]: value }, note)}
              />
            )}
          </Field>
        ))}
        <Field label="Note (optional)" hint="Anything you want to remember about this — not sent anywhere.">
          <Input value={note} onChange={(value) => onChange(fields, value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonStyles.primary}
          data-testid={`add-save-${category}`}
          disabled={busy}
          onClick={onAdd}
        >
          {busy ? "Adding…" : "Add it"}
        </button>
        <button type="button" className={buttonStyles.subtle} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  title: "Job title",
  company: "Company",
  start: "Start",
  end: "End",
  description: "What you did",
  qualification: "Qualification",
  school: "Institution",
  dates: "Dates",
  details: "Anything else",
  metric: "The number it states",
  year: "Year",
  level: "Level",
  note: "Note",
};

function EmptyStatesCard({
  emptyCategories,
  report,
}: {
  emptyCategories: FactCategory[];
  report: ExtractionReport;
}) {
  return (
    <Card>
      <SectionTitle hint="How the reading went, including what we couldn't find and why.">
        Notes on this pass
      </SectionTitle>
      {report.missing.length > 0 ? (
        <p className="mb-3 text-sm text-slate-700">
          In your material we found nothing for{" "}
          {report.missing.length === FACT_CATEGORY_ORDER.length
            ? "any of these categories"
            : "some of these categories"}
          . Nothing has been filled in to hide that: an empty category is the honest answer, and the way to change it
          is to add the fact yourself above, or put it in your résumé and let us read it again.
        </p>
      ) : null}
      {emptyCategories.length > 0 ? (
        <ul className="mb-3 space-y-2 text-sm text-slate-700">
          {emptyCategories.map((category) => (
            <li key={category} className="flex gap-2">
              <span aria-hidden className="text-slate-400">
                —
              </span>
              <span>
                <span className="font-medium text-slate-800">{FACT_CATEGORY_COPY[category].title}:</span>{" "}
                {FACT_CATEGORY_COPY[category].empty}{" "}
                <a href={`#add-${category}`} className="text-indigo-700 underline">
                  Add it here instead.
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {report.notes.length === 0 ? (
        <p className="text-sm text-slate-600">No notes — every category above has something in it.</p>
      ) : (
        <ul className="space-y-2 text-sm text-slate-700">
          {report.notes.map((note, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden className="text-slate-400">
                —
              </span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
