/**
 * Uploaded-file text extraction — SERVER ONLY.
 *
 * Two libraries do the parsing, both pure JavaScript with no native bits:
 *   - `unpdf` (a serverless build of pdf.js) for PDFs
 *   - `fflate` for the .docx zip container, plus a small XML-to-text pass
 *
 * Nothing here decides anything about the user: it either returns the words that
 * were in their own file, or it says plainly that it couldn't read them. The
 * status + note travel back to the UI so the user is told what happened instead
 * of a bad parse being quietly trusted.
 *
 * This module must never be imported from a component; only `actions.ts`
 * (server-function handlers) imports it, so pdf.js stays out of the browser
 * bundle.
 */
import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { HUMAN_MAX_SIZE, MAX_UPLOAD_BYTES, SUPPORTED_FORMATS_COPY } from "~/types";

export { HUMAN_MAX_SIZE, MAX_UPLOAD_BYTES };

/** Matches the profile field cap in `actions.ts` so nothing is silently dropped. */
export const MAX_EXTRACTED_CHARS = 40000;

export type FileKind = "pdf" | "docx" | "text";

export type SniffedFile = {
  kind: FileKind;
  /** Canonical extension we store the original under (no dot). */
  extension: string;
  /** Human name of the format, for messages: "PDF", "Word .docx", "text". */
  format: string;
};

export type ExtractStatus = "ok" | "thin" | "empty" | "failed";

export type ExtractOutcome = {
  text: string;
  status: ExtractStatus;
  /** Plain-language sentence for the user. */
  note: string;
};

// ------------------------------------------------------------------ sniffing ---

const EXTENSIONS_BY_KIND: Record<FileKind, string> = { pdf: "pdf", docx: "docx", text: "txt" };

const FORMAT_BY_KIND: Record<FileKind, string> = {
  pdf: "PDF",
  docx: "Word .docx",
  text: "text",
};

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "text", "rtf"]);
const TEXT_MIME = new Set(["text/plain", "text/markdown", "text/x-markdown", "application/rtf"]);

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match?.[1] ? match[1].toLowerCase() : "";
}

function hasPrefix(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Decide whether we can read this file at all, from the name, the declared mime
 * type and the actual first bytes. The bytes win: a file called `resume.pdf` that
 * isn't a PDF is rejected rather than handed to the parser to fail on.
 */
export function sniffUpload(
  filename: string,
  mimeType: string,
  bytes: Uint8Array
): { ok: true; file: SniffedFile } | { ok: false; error: string } {
  const name = filename.trim() || "that file";
  const extension = extensionOf(name);
  const mime = (mimeType || "").toLowerCase().split(";")[0]?.trim() ?? "";

  if (bytes.length === 0) return { ok: false, error: `${name} is empty — there's nothing in it to read.` };

  const looksPdf = hasPrefix(bytes, "%PDF");
  const looksZip = hasPrefix(bytes, "PK\u0003\u0004");

  if (extension === "pdf" || mime === "application/pdf" || looksPdf) {
    if (!looksPdf) {
      return {
        ok: false,
        error: `${name} has a .pdf name but isn't a PDF we can open. Re-save it and try again, or paste the text instead.`,
      };
    }
    return { ok: true, file: { kind: "pdf", extension: "pdf", format: "PDF" } };
  }

  if (
    extension === "docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (!looksZip) {
      return {
        ok: false,
        error: `${name} has a .docx name but isn't a Word document we can open. Open it in Word and "Save as" .docx again, or paste the text instead.`,
      };
    }
    return { ok: true, file: { kind: "docx", extension: "docx", format: "Word .docx" } };
  }

  if (extension === "doc" || mime === "application/msword") {
    return {
      ok: false,
      error: `${name} is the old Word .doc format, which we can't read. In Word, use "Save as" and choose .docx or PDF — or paste the text below.`,
    };
  }

  if (TEXT_EXTENSIONS.has(extension) || TEXT_MIME.has(mime) || mime.startsWith("text/")) {
    // RTF is text but full of markup; strip the control words rather than store them.
    const kind: FileKind = "text";
    return { ok: true, file: { kind, extension: extension === "markdown" ? "md" : extension || "txt", format: FORMAT_BY_KIND[kind] } };
  }

  return {
    ok: false,
    error: `${name} isn't a format we can read. Upload ${SUPPORTED_FORMATS_COPY} — or paste the text instead.`,
  };
}

// ---------------------------------------------------------------- pdf / docx ---

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{3,}/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/**
 * Word markup → plain text. Paragraph and row ends become line breaks, cells get
 * separated, and field/deleted-text runs are dropped so a table of contents
 * doesn't dump stale page numbers into the résumé.
 */
export function docxXmlToText(xml: string): string {
  return tidy(
    decodeXmlEntities(
      xml
        .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, " ")
        .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, " ")
        .replace(/<w:tab\b[^>]*\/?>/g, "\t")
        .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, "\n")
        .replace(/<\/w:tc>/g, " | ")
        .replace(/<\/(?:w:p|w:tr)>/g, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );
}

function pdfBytesToText(bytes: Uint8Array): Promise<string> {
  return (async () => {
    // Hand pdf.js its own copy: it transfers the buffer to its worker, which
    // detaches the caller's array (a detached Uint8Array reports length 0).
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(document, { mergePages: true });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    return pages.join("\n\n");
  })();
}

function textBytesToString(bytes: Uint8Array): string {
  const decoded = new TextDecoder("utf-8").decode(bytes);
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

// ----------------------------------------------------------- quality signals ---

const PRINTABLE_EXTRA = new Set([..."–—‘’“”•·…°€£¥§¶¢®™←→✓✩★"]);

type Quality = { status: ExtractStatus; reason: string };

/**
 * Is this parse trustworthy enough to put in front of the user without a warning?
 * Deliberately blunt: an empty or badly-decoded parse must be flagged, because
 * quietly trusting it would put words in the user's mouth.
 */
export function judgeExtraction(text: string): Quality {
  const trimmed = text.trim();
  if (!trimmed) return { status: "empty", reason: "nothing" };

  const chars = Array.from(trimmed);
  let suspicious = 0;
  let wordy = 0;
  let spaces = 0;
  for (const char of chars) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) {
      spaces++;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(char)) {
      wordy++;
      continue;
    }
    if (code >= 32 && code <= 126) continue;
    if (PRINTABLE_EXTRA.has(char)) continue;
    if (code >= 0x00a1 && code <= 0x024f) continue;
    suspicious++;
  }

  const nonSpace = chars.length - spaces;
  if (chars.length > 200 && spaces === 0) return { status: "thin", reason: "no-breaks" };
  if (nonSpace > 0 && suspicious / nonSpace > 0.03) return { status: "thin", reason: "unreadable-characters" };
  if (nonSpace > 0 && wordy / nonSpace < 0.45) return { status: "thin", reason: "not-much-text" };
  if (trimmed.length < 120) return { status: "thin", reason: "very-short" };

  return { status: "ok", reason: "" };
}

function describeThinness(reason: string, format: string): string {
  switch (reason) {
    case "no-breaks":
      return `We read this ${format} but it came out as one unbroken run of characters, so it probably isn't laid out the way the original is. Check it below and fix anything that's wrong.`;
    case "unreadable-characters":
      return `This ${format} contains characters we couldn't decode properly, so some of the text below may be scrambled. Fix it below, or paste the text yourself.`;
    case "not-much-text":
      return `There was very little readable text in this ${format} — it may be mostly graphics or badly encoded. Paste the text below if the version we read isn't right.`;
    default:
      return `We only found a very short amount of text in this ${format} (under 120 characters). If your résumé is a scan or a photo, we can't read it — paste the text below instead.`;
  }
}

// ------------------------------------------------------------------ entry point ---

/**
 * Pull the words out of an uploaded file. Never throws: a parse failure comes
 * back as `status: "failed"` with a sentence the user can act on, and the
 * original file is kept either way.
 */
export async function extractTextFromBytes(
  file: SniffedFile,
  bytes: Uint8Array
): Promise<ExtractOutcome> {
  let raw = "";
  try {
    if (file.kind === "pdf") raw = await pdfBytesToText(bytes);
    else if (file.kind === "docx") raw = docxFromZip(bytes);
    else raw = textBytesToString(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    const hint = /password|encrypt/i.test(detail)
      ? "It may be password-protected."
      : "It may be damaged, or saved in a way we can't read.";
    return {
      text: "",
      status: "failed",
      note: `We saved the file, but couldn't read any text out of this ${file.format}. ${hint} Paste the text below so nothing gets guessed.`,
    };
  }

  const text = raw.replace(/\u0000/g, "").slice(0, MAX_EXTRACTED_CHARS);
  const quality = judgeExtraction(text);

  if (quality.status === "empty") {
    return {
      text: "",
      status: "empty",
      note: `We saved the file, but found no text in it — a scanned or photographed document looks like this. Paste your text below instead, and we'll use that.`,
    };
  }
  if (quality.status === "thin") {
    return { text, status: "thin", note: describeThinness(quality.reason, file.format) };
  }
  return { text, status: "ok", note: "" };
}

function docxFromZip(bytes: Uint8Array): string {
  const entries = unzipSync(bytes, { filter: (file) => file.name === "word/document.xml" });
  const document = entries["word/document.xml"];
  if (!document) {
    throw new Error("no word/document.xml in the .docx container");
  }
  return docxXmlToText(strFromU8(document));
}

/** Exposed for the format list in the UI copy. */
export function supportedKindLabel(kind: FileKind): string {
  return FORMAT_BY_KIND[kind];
}

/** Kept for symmetry with the extensions we store originals under. */
export function extensionForKind(kind: FileKind): string {
  return EXTENSIONS_BY_KIND[kind];
}
