/**
 * The vault's file-upload card: drop in a résumé (PDF / .docx / .txt / .md), keep
 * the original, and see exactly what text we managed to read out of it.
 *
 * Product rule on show here: the original file is kept, the extracted text is
 * shown to the user immediately, and an empty or doubtful parse is flagged rather
 * than quietly used. Nothing is submitted anywhere by this component.
 */
import { useRef, useState } from "react";
import { Badge, Card, Field, SectionTitle, buttonStyles } from "~/components/ui";
import {
  deleteMaterial,
  loadMaterialFile,
  uploadMaterial,
  useMaterialAsResume,
} from "~/server/actions";
import {
  HUMAN_MAX_SIZE,
  MATERIAL_LABELS,
  MAX_UPLOAD_BYTES,
  SUPPORTED_FORMATS_COPY,
  UPLOAD_ACCEPT_ATTRIBUTE,
} from "~/types";
import type { MaterialSummary } from "~/types";

type Notice = { tone: "ok" | "warn" | "error"; title: string; detail: string };

const STATUS_BADGE: Record<MaterialSummary["extractStatus"], { tone: "green" | "amber" | "red"; label: string }> = {
  ok: { tone: "green", label: "Text read ✓" },
  thin: { tone: "amber", label: "Check the text" },
  empty: { tone: "red", label: "No text found" },
  failed: { tone: "red", label: "Couldn't read" },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Read a picked file into base64 for the server. The bytes never leave our server. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(offset, offset + chunk) as unknown as number[]
    );
  }
  return btoa(binary);
}

/** Cheap client-side gate so an obvious rejection doesn't need a round trip. */
function preflightError(file: File): string | null {
  if (file.size === 0) return `${file.name} is empty — there's nothing in it to read.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${HUMAN_MAX_SIZE}. Compress it, or paste the text instead.`;
  }
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name.trim())?.[1]?.toLowerCase() ?? "";
  if (extension === "doc") {
    return `${file.name} is the old Word .doc format, which we can't read. Save it as .docx or PDF — or paste the text instead.`;
  }
  return null;
}

export function MaterialsCard({
  initial,
  onExtractedResume,
}: {
  initial: MaterialSummary[];
  /** Called with the text a résumé upload put in the résumé box. */
  onExtractedResume: (text: string) => void;
}) {
  const [materials, setMaterials] = useState<MaterialSummary[]>(initial);
  const [label, setLabel] = useState<string>(MATERIAL_LABELS[0]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleUpload() {
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setNotice({ tone: "error", title: "Choose a file first", detail: "Pick the résumé or material you want to store." });
      return;
    }
    const preflight = preflightError(file);
    if (preflight) {
      setBusy(false);
      setNotice({ tone: "error", title: "That file was rejected", detail: preflight });
      return;
    }

    setBusy(true);
    setRowError("");
    setNotice(null);
    try {
      const encoded = await fileToBase64(file);
      const result = await uploadMaterial({
        data: { filename: file.name, mimeType: file.type, label, dataBase64: encoded },
      });
      if (!result.ok) {
        setNotice({ tone: "error", title: "That upload didn't go through", detail: result.error });
        return;
      }

      const material = result.material;
      setMaterials((previous) => [...previous, material]);
      if (inputRef.current) inputRef.current.value = "";

      if (result.resumeText) {
        onExtractedResume(result.resumeText);
        const replaced = result.replacedResumeText
          ? " It replaced the text that was already in your résumé box — check it below."
          : " It's in your résumé box below: read it, fix anything that came out wrong, then save.";
        setNotice({
          tone: material.extractStatus === "ok" ? "ok" : "warn",
          title: `Read ${material.textLength.toLocaleString()} characters from ${material.filename}`,
          detail: `${material.extractNote ? `${material.extractNote} ` : ""}${replaced}`.trim(),
        });
      } else if (material.extractStatus === "ok") {
        setNotice({
          tone: "ok",
          title: `${material.filename} stored as “${material.label}”`,
          detail: `We read ${material.textLength.toLocaleString()} characters from it. The original file is kept for future applications.`,
        });
      } else {
        setNotice({
          tone: "warn",
          title: `We couldn't read text out of ${material.filename}`,
          detail: `${material.extractNote} The file itself is stored and kept. Paste your résumé text below instead — nothing is ever guessed.`,
        });
      }
    } catch {
      setNotice({
        tone: "error",
        title: "That upload failed",
        detail: "The file didn't reach the server. Try again, or paste the text instead.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(material: MaterialSummary) {
    setRowError("");
    const result = await deleteMaterial({ data: { id: material.id } });
    if (!result.ok) {
      setRowError(result.error);
      return;
    }
    setMaterials((previous) => previous.filter((item) => item.id !== material.id));
    setNotice({
      tone: "ok",
      title: `${material.filename} deleted`,
      detail: material.isResume
        ? "The text in your résumé box is still there — clear it there if you want it gone too."
        : "The stored file and its text are gone from your account.",
    });
  }

  async function handleDownload(material: MaterialSummary) {
    setRowError("");
    const result = await loadMaterialFile({ data: { id: material.id } });
    if (!result.ok) {
      setRowError(result.error);
      return;
    }
    const binary = atob(result.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function handleUseAsResume(material: MaterialSummary) {
    setRowError("");
    const result = await useMaterialAsResume({ data: { id: material.id } });
    if (!result.ok) {
      setRowError(result.error);
      return;
    }
    onExtractedResume(result.resumeText);
    setNotice({
      tone: "ok",
      title: `${material.filename} now fills your résumé box`,
      detail:
        "Check the text below — remember to press “Save profile”, and re-generate any kit you want it to affect.",
    });
  }

  return (
    <Card id="materials">
      <SectionTitle hint={`Upload the files you already have. We read the text out of them and keep the original file, so it can be attached to a real application later. ${SUPPORTED_FORMATS_COPY}.`}>
        Résumé &amp; materials
      </SectionTitle>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="File" hint="One file at a time. Nothing is uploaded until you press Upload.">
          <input
            ref={inputRef}
            type="file"
            accept={UPLOAD_ACCEPT_ATTRIBUTE}
            className="block w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
        </Field>
        <Field label="What is it?">
          <div className="flex gap-2">
            <select
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {MATERIAL_LABELS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button type="button" className={buttonStyles.secondary} onClick={handleUpload} disabled={busy}>
              {busy ? "Reading…" : "Upload"}
            </button>
          </div>
        </Field>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        A file labelled “Résumé” fills your résumé text box below. Other labels are stored as-is, and their text is
        kept for reference.
      </p>

      {notice ? (
        <div
          className={`mt-4 rounded-xl border p-3 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : notice.tone === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-red-200 bg-red-50 text-red-900"
          }`}
        >
          <p className="font-medium">{notice.title}</p>
          {notice.detail ? <p className="mt-1 leading-relaxed">{notice.detail}</p> : null}
        </div>
      ) : null}

      {rowError ? <p className="mt-3 text-sm text-red-700">{rowError}</p> : null}

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-slate-900">
          Stored files {materials.length > 0 ? `(${materials.length})` : ""}
        </h3>
        {materials.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Nothing uploaded yet — paste your résumé text below, or upload a file above. Both work.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {materials.map((material) => {
              const badge = STATUS_BADGE[material.extractStatus];
              return (
                <li key={material.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={material.isResume ? "indigo" : "slate"}>{material.label}</Badge>
                    <span className="text-sm font-medium text-slate-900">{material.filename}</span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                    <span className="text-xs text-slate-500">
                      {formatBytes(material.sizeBytes)} · uploaded {formatDate(material.createdAt)}
                    </span>
                  </div>

                  {material.extractNote ? (
                    <p className="mt-2 text-xs text-amber-800">{material.extractNote}</p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={buttonStyles.mini}
                      onClick={() => handleDownload(material)}
                    >
                      Download original
                    </button>
                    {!material.isResume && material.textLength > 0 ? (
                      <button
                        type="button"
                        className={buttonStyles.mini}
                        onClick={() => handleUseAsResume(material)}
                      >
                        Use this text as my résumé
                      </button>
                    ) : null}
                    {material.isResume ? (
                      <span className="text-xs text-slate-500">Fills the résumé text box below.</span>
                    ) : null}
                    <button
                      type="button"
                      className={`${buttonStyles.mini} ml-auto text-red-600 hover:bg-red-50`}
                      onClick={() => handleDelete(material)}
                    >
                      Delete
                    </button>
                  </div>

                  {material.textLength > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-slate-600">
                        What we read from this file ({material.textLength.toLocaleString()} characters
                        {material.textLength > material.textPreview.length ? ", first 2,000 shown" : ""})
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 font-sans text-xs leading-relaxed text-slate-700">
                        {material.textPreview}
                      </pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
