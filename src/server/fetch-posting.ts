/**
 * Best-effort server-side fetch of a job posting URL, so the user can paste a
 * link instead of the whole ad. Many ATS pages are JavaScript-rendered or block
 * bots, so this is deliberately a convenience, not a requirement: when it can't
 * read the page it says so and the user pastes the text instead.
 */
const BLOCKED_HOSTS =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

const UA =
  "Mozilla/5.0 (compatible; ApplyPilotBot/1.0; +https://applypilot.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };

export function normalisePostingUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]?.length !== 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchPostingText(rawUrl: string): Promise<FetchResult> {
  const url = normalisePostingUrl(rawUrl);
  if (!url) return { ok: false, error: "Add the posting link first." };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http(s) links can be read." };
  }
  if (BLOCKED_HOSTS.test(parsed.hostname) || !parsed.hostname.includes(".")) {
    return { ok: false, error: "That address can't be read from here." };
  }

  try {
    const response = await fetch(parsed.toString(), {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `The site answered with ${String(response.status)}. Paste the posting text instead — that works just as well.`,
      };
    }
    const html = await response.text();
    const text = htmlToText(html);
    if (text.length < 300) {
      return {
        ok: false,
        error:
          "That page loaded but had almost no readable text (many job boards build their pages with JavaScript). Paste the posting text instead — that works just as well.",
      };
    }
    return { ok: true, text: text.slice(0, 40000) };
  } catch {
    return {
      ok: false,
      error:
        "Couldn't reach that page (timeout or blocked). Paste the posting text instead — that works just as well.",
    };
  }
}
