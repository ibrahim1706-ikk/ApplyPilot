/**
 * Honest rate limiting — server-only.
 *
 * Every counted attempt is one row in `rate_events` (see ~/db). Counting rows in
 * a moving window is duller than an in-memory bucket, and that is the point: the
 * count survives a restart, it is the same for every server process, and it is
 * inspectable by whoever runs the site. Rows older than the longest window are
 * pruned as they age out.
 *
 * Two shapes of bucket:
 *   - per account   `u:<userId>`      — one person hammering their own account
 *   - per IP hash   `ip:<sha256>`     — one person hammering from one place
 * IP addresses are hashed, not stored: the counter only needs to tell callers
 * apart, and this way the table holds no raw address of anyone.
 *
 * The limits are deliberately low but not tight-fisted. Drafting kits is cheap
 * and repeated drafting is legitimate (draft a few, pick the best); creating
 * accounts and generating kits in bulk is not. The per-account numbers are the
 * real guard; the per-IP numbers are generous because everyone behind a shared
 * address (an office, a campus, a proxy) must not block each other.
 */
import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";
import * as db from "~/db";

export type Rule = { limit: number; windowSeconds: number; label: string };

export const RULES = {
  signup_ip_hour: { limit: 6, windowSeconds: 3_600, label: "new accounts from your network" },
  signup_ip_day: { limit: 40, windowSeconds: 86_400, label: "new accounts from your network" },
  signup_email: { limit: 3, windowSeconds: 3_600, label: "sign-up attempts for that email address" },

  kit_user_minute: { limit: 5, windowSeconds: 60, label: "application kits drafted" },
  kit_user_hour: { limit: 12, windowSeconds: 3_600, label: "application kits drafted" },
  kit_user_day: { limit: 30, windowSeconds: 86_400, label: "application kits drafted" },
  kit_ip_hour: { limit: 40, windowSeconds: 3_600, label: "application kits drafted from your network" },
  kit_ip_day: { limit: 120, windowSeconds: 86_400, label: "application kits drafted from your network" },

  reset_ip_hour: { limit: 8, windowSeconds: 3_600, label: "password-reset requests from your network" },
  reset_email: { limit: 3, windowSeconds: 3_600, label: "password-reset requests for that address" },
  reset_try_hour: { limit: 10, windowSeconds: 3_600, label: "password-reset link attempts" },
} satisfies Record<string, Rule>;

export type RuleName = keyof typeof RULES;

export type LimitCheck = { ok: true } | { ok: false; error: string; retryAfterSeconds: number };

const HOUR_MS = 3_600_000;

/**
 * The caller's IP, or "" when the platform gives us nothing. Proxies put the
 * client address in X-Forwarded-For (the platform's edge sets it), so that is
 * read first, then the direct socket.
 */
export function clientIp(): string {
  try {
    const forwarded = getRequestHeader("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const direct = getRequestIP({ xForwardedFor: true });
    return direct?.trim() ?? "";
  } catch {
    return "";
  }
}

/** `ip:<hash>` for a request, or null when there is no address to count. */
export function ipBucket(): string | null {
  const ip = clientIp();
  if (!ip) return null;
  const hash = new Bun.CryptoHasher("sha256").update(ip).digest("hex").slice(0, 16);
  return `ip:${hash}`;
}

export function userBucket(userId: string): string {
  return `u:${userId}`;
}

export function emailBucket(email: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `e:${hash}`;
}

function describeWindow(seconds: number): string {
  if (seconds <= 90) return "a minute";
  if (seconds <= 3_700) return "an hour";
  return "a day";
}

function humanise(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
}

type Attempt = { rule: RuleName; bucket: string | null };

/**
 * Checks every attempt against its rule; records all of them when none is over
 * the line, and records nothing when one is (so a blocked caller cannot push
 * their own window further out by hammering).
 */
export function checkAndRecord(attempts: Attempt[]): LimitCheck {
  const now = Date.now();
  pruneIfDue(now);

  for (const attempt of attempts) {
    if (!attempt.bucket) continue;
    const rule = RULES[attempt.rule];
    const since = new Date(now - rule.windowSeconds * 1000).toISOString();
    const count = db.countRateEvents(attempt.rule, attempt.bucket, since);
    if (count >= rule.limit) {
      const oldest = db.oldestRateEvent(attempt.rule, attempt.bucket, since);
      const oldestMs = oldest ? new Date(oldest).getTime() : now;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestMs + rule.windowSeconds * 1000 - now) / 1000)
      );
      return {
        ok: false,
        retryAfterSeconds,
        error:
          `That's the limit for ${rule.label} — ${String(rule.limit)} per ${describeWindow(rule.windowSeconds)}. ` +
          `Try again in about ${humanise(retryAfterSeconds)}.`,
      };
    }
  }

  for (const attempt of attempts) {
    if (attempt.bucket) db.recordRateEvent(attempt.rule, attempt.bucket);
  }
  return { ok: true };
}

let lastPrune = 0;

/** Drops rows older than the longest window, at most once an hour. */
function pruneIfDue(now: number): void {
  if (now - lastPrune < HOUR_MS) return;
  lastPrune = now;
  try {
    db.pruneRateEvents(new Date(now - 2 * 86_400_000).toISOString());
  } catch {
    // Housekeeping only; a failure here must never block a real request.
  }
}
