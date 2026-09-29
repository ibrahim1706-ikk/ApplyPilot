/**
 * Every server function the UI calls. Server-only by construction: the client
 * bundle gets RPC stubs, the database and cookie code stay on the server.
 *
 * All of these return `{ ok: false, error }` for anything the user should read,
 * rather than throwing — a thrown error in production would reach the browser as
 * a generic "server error".
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHost, getRequestProtocol } from "@tanstack/react-start/server";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "~/db";
import { currentUser, endSession, startSession } from "~/server/auth";
import { fetchPostingText, normalisePostingUrl } from "~/server/fetch-posting";
import { fieldAnswersFor } from "~/server/field-answers";
import { generateKit, readPostingHints } from "~/server/generate";
import * as qualifications from "~/server/qualifications";
import { emailStatus, sendPasswordResetEmail } from "~/server/email";
import { checkAndRecord, emailBucket, ipBucket, userBucket } from "~/server/ratelimit";
import type { RuleName } from "~/server/ratelimit";
import type { Outcome } from "~/server/qualifications";
import {
  MAX_UPLOAD_BYTES,
  extractTextFromBytes,
  sniffUpload,
} from "~/server/extract";
import { FACT_CATEGORY_ORDER, HUMAN_MAX_SIZE } from "~/types";
import type {
  ApplicationSummary,
  ConfirmationStatus,
  ExtractionReport,
  Fact,
  FactCategory,
  FactConfirmations,
  FieldAnswers,
  Kit,
  MaterialSummary,
  ProfileFormValues,
} from "~/types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NOT_SIGNED_IN = "Your session has ended — please sign in again.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Where someone writes when the app cannot help them itself. */
const CONTACT_EMAIL = "applypilot-48900df7@ctomail.io";
/** How long a password-reset link stays usable. */
const RESET_MINUTES = 60;
const INVALID_RESET_LINK =
  "That reset link isn't valid any more. Links work once and expire an hour after they're requested — request a fresh one and use it straight away.";

function str(value: unknown, max = 5000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function rows<T>(value: unknown, map: (row: Record<string, unknown>) => T, max = 30): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map(map);
}

function readProfileInput(raw: unknown): db.Profile {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    full_name: str(input.full_name, 200),
    email: str(input.email, 200),
    phone: str(input.phone, 60),
    location: str(input.location, 200),
    portfolio_url: str(input.portfolio_url, 500),
    github_url: str(input.github_url, 500),
    linkedin_url: str(input.linkedin_url, 500),
    resume_text: str(input.resume_text, 40000),
    education: rows(
      input.education,
      (row) => ({
        school: str(row.school, 200),
        qualification: str(row.qualification, 200),
        dates: str(row.dates, 100),
        details: str(row.details, 2000),
      }),
      15
    ),
    experience: rows(
      input.experience,
      (row) => ({
        title: str(row.title, 200),
        company: str(row.company, 200),
        start: str(row.start, 60),
        end: str(row.end, 60),
        description: str(row.description, 5000),
      }),
      25
    ),
    work_authorisation: str(input.work_authorisation, 200),
    work_authorisation_note: str(input.work_authorisation_note, 500),
    salary_expectation: str(input.salary_expectation, 200),
    notice_period: str(input.notice_period, 200),
    updated_at: "",
  };
}

function toFormValues(profile: db.Profile): ProfileFormValues {
  const {
    full_name,
    email,
    phone,
    location,
    portfolio_url,
    github_url,
    linkedin_url,
    resume_text,
    education,
    experience,
    work_authorisation,
    work_authorisation_note,
    salary_expectation,
    notice_period,
  } = profile;
  return {
    full_name,
    email,
    phone,
    location,
    portfolio_url,
    github_url,
    linkedin_url,
    resume_text,
    education,
    experience,
    work_authorisation,
    work_authorisation_note,
    salary_expectation,
    notice_period,
  };
}

function parseKit(raw: string | null): Kit | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Kit;
  } catch {
    return null;
  }
}

function summarise(application: db.Application): ApplicationSummary {
  const kit = parseKit(application.kit_json);
  return {
    id: application.id,
    title: application.title,
    company: application.company,
    url: application.url,
    createdAt: application.created_at,
    hasKit: kit !== null,
    coverage: kit?.keywordMatch.coverage ?? null,
    missingCount: kit?.keywordMatch.missing.length ?? 0,
  };
}

// ------------------------------------------------------------------- accounts ---

export const signUp = createServerFn({ method: "POST" })
  .validator((input: { email?: string; password?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const email = str(data?.email, 200).trim().toLowerCase();
    const password = typeof data?.password === "string" ? data.password : "";
    if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (password.length < 8) return { ok: false, error: "Choose a password of at least 8 characters." };

    // Counted per network and per address, so one person cannot mint accounts in
    // bulk. The per-address limit is the tight one; the network limit is a
    // backstop generous enough for everyone sharing an office or campus address.
    const limit = checkAndRecord([
      { rule: "signup_ip_hour", bucket: ipBucket() },
      { rule: "signup_ip_day", bucket: ipBucket() },
      { rule: "signup_email", bucket: emailBucket(email) },
    ]);
    if (!limit.ok) {
      return { ok: false, error: `${limit.error} Nothing has been created.` };
    }

    if (db.emailTaken(email)) {
      return { ok: false, error: "There's already an account with that email — sign in instead." };
    }
    try {
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const user = db.createUser(email, hash);
      db.deleteExpiredSessions();
      db.deleteExpiredResets();
      startSession(user.id);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't create the account. Try again in a moment." };
    }
  });

export const signIn = createServerFn({ method: "POST" })
  .validator((input: { email?: string; password?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const email = str(data?.email, 200).trim().toLowerCase();
    const password = typeof data?.password === "string" ? data.password : "";
    if (!email || !password) return { ok: false, error: "Enter your email and password." };
    const user = db.findUserByEmail(email);
    if (!user) return { ok: false, error: "Email or password is incorrect." };
    const valid = await Bun.password.verify(password, user.password_hash);
    if (!valid) return { ok: false, error: "Email or password is incorrect." };
    db.deleteExpiredSessions();
    startSession(user.id);
    return { ok: true };
  });

export const signOut = createServerFn({ method: "POST" }).handler(async (): Promise<Result> => {
  endSession();
  return { ok: true };
});

export const sessionInfo = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ signedIn: boolean; email: string }> => {
    const user = currentUser();
    return { signedIn: user !== null, email: user?.email ?? "" };
  }
);

// ----------------------------------------------------------- password reset ---
//
// Two server functions: ask for a link, then spend it. The rules that matter:
//   - the token is random, stored only as a SHA-256 hash, single use, 60 minutes
//   - the reset URL points at the site the request came in on
//   - NOTHING here claims an email was sent unless the provider accepted it; when
//     the mail keys are absent the caller is told plainly that email is not set up
//   - asking for a reset tells you nothing about whether the address has an account

function resetToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
}

function hashResetToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** The origin the request arrived on, so the emailed link comes back to this site. */
function siteOrigin(): string {
  try {
    const host = getRequestHost({ xForwardedHost: true });
    const protocol = getRequestProtocol({ xForwardedProto: true }) === "https" ? "https" : "http";
    return `${protocol}://${host}`;
  } catch {
    return "";
  }
}

export type ResetRequestOutcome = {
  /** True only when the provider accepted the message for delivery. */
  delivered: boolean;
  /** False when this deployment has no mail credentials yet. */
  configured: boolean;
  message: string;
};

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((input: { email?: string }) => input)
  .handler(async ({ data }): Promise<Result<ResetRequestOutcome>> => {
    const email = str(data?.email, 200).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };

    const limit = checkAndRecord([
      { rule: "reset_ip_hour", bucket: ipBucket() },
      { rule: "reset_email", bucket: emailBucket(email) },
    ]);
    if (!limit.ok) return { ok: false, error: limit.error };

    const status = emailStatus();
    const user = db.findUserByEmail(email);

    // No mail credentials. Say so plainly rather than pretending a link is on
    // its way — and change nothing on the account.
    if (!status.configured) {
      return {
        ok: true,
        delivered: false,
        configured: false,
        message:
          "Email sending is not set up on this ApplyPilot deployment yet, so no reset link was sent. " +
          "Nothing on your account has changed and your password still works as before. " +
          `Write to ${CONTACT_EMAIL} from the address on your account and we will help you back in.`,
      };
    }

    const generic: ResetRequestOutcome = {
      delivered: false,
      configured: true,
      message:
        "If there's an ApplyPilot account for that address, a reset link is on its way. " +
        `It works once and expires in ${String(RESET_MINUTES)} minutes. Check your spam folder if it doesn't arrive.`,
    };
    if (!user) return { ok: true, ...generic };

    const token = resetToken();
    const expiresAt = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
    db.deleteResetsForUser(user.id); // one live link at a time
    db.createPasswordReset(hashResetToken(token), user.id, expiresAt);

    const sent = await sendPasswordResetEmail({
      to: email,
      userId: user.id,
      resetUrl: `${siteOrigin()}/reset-password?token=${token}`,
      expiresMinutes: RESET_MINUTES,
    });

    if (!sent.ok) {
      // The link never left the building, so it should not stay valid, and the
      // user must be told the send failed rather than that it worked.
      db.deleteResetsForUser(user.id);
      return {
        ok: false,
        error: `${sent.error} Nothing on your account has changed. Try again in a few minutes, or write to ${CONTACT_EMAIL}.`,
      };
    }
    return { ok: true, ...generic, delivered: true };
  });

export const resetPassword = createServerFn({ method: "POST" })
  .validator((input: { token?: string; password?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const token = str(data?.token, 200).trim();
    const password = typeof data?.password === "string" ? data.password : "";
    if (password.length < 8) return { ok: false, error: "Choose a password of at least 8 characters." };

    // Stops a script grinding through guessed tokens.
    const limit = checkAndRecord([{ rule: "reset_try_hour", bucket: ipBucket() }]);
    if (!limit.ok) return { ok: false, error: limit.error };
    if (!token) return { ok: false, error: INVALID_RESET_LINK };

    // Atomically spent: a link works once, even if it is used twice at once.
    const claimed = db.claimReset(hashResetToken(token));
    if (!claimed) return { ok: false, error: INVALID_RESET_LINK };

    try {
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
      db.updatePassword(claimed.user_id, hash);
      db.deleteResetsForUser(claimed.user_id);
      // A reset also signs every other device out: if someone else had the old
      // password, they lose their session here.
      db.deleteSessionsForUser(claimed.user_id);
      startSession(claimed.user_id);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't save the new password. Try the link again in a moment." };
    }
  });

// ------------------------------------------------------- export and deletion ---

/** What the account page shows: who you are, what's stored, whether mail works. */
export const accountOverview = createServerFn({ method: "POST" }).handler(
  async (): Promise<
    Result<{
      email: string;
      createdAt: string;
      materials: number;
      applications: number;
      resumeChars: number;
      emailConfigured: boolean;
      /**
       * Where this account's rows and files are stored on the server. Shown to
       * the signed-in owner on purpose: it is the one fact that says whether the
       * store sits outside the folder a publish replaces.
       */
      storageDir: string;
    }>
  > => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const profile = db.getProfile(user.id);
    return {
      ok: true,
      email: user.email,
      createdAt: user.created_at,
      materials: db.countMaterials(user.id),
      applications: db.listApplications(user.id).length,
      resumeChars: profile.resume_text.length,
      emailConfigured: emailStatus().configured,
      storageDir: db.dataDir(),
    };
  }
);

/**
 * Everything this account holds, as one JSON file. Built on the server from the
 * signed-in user's id only — the client cannot ask for anyone else's data, and
 * there is no id in the request.
 */
export const exportMyData = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ filename: string; json: string }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const data = db.exportAccount(user.id);
    if (!data) return { ok: false, error: "Couldn't find your account. Please sign in again." };

    const payload = {
      product: "ApplyPilot",
      exportedAt: db.nowIso(),
      about:
        "This is every piece of information ApplyPilot holds about your account: your profile vault, " +
        "the extracted text of each file you uploaded, every job posting you saved, and every kit " +
        "generated from them. Your uploaded files themselves are not embedded here — open your " +
        "profile vault and download each original from there. Your password is not included: it is " +
        "stored as a one-way hash, so it cannot be exported in a readable form.",
      ...data,
    };
    return {
      ok: true,
      filename: `applypilot-export-${db.nowIso().slice(0, 10)}.json`,
      json: JSON.stringify(payload, null, 2),
    };
  }
);

/**
 * Deletes the account and everything it owns. Requires the password and a typed
 * confirmation, because there is no undo. Uploaded originals are removed from
 * disk as well as their rows — a deleted account must not leave bytes behind.
 */
export const deleteMyAccount = createServerFn({ method: "POST" })
  .validator((input: { password?: string; confirmation?: string }) => input)
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        email: string;
        removed: {
          profile: number;
          applications: number;
          materials: number;
          sessions: number;
          resetLinks: number;
          files: number;
        };
      }>
    > => {
      const user = currentUser();
      if (!user) return { ok: false, error: NOT_SIGNED_IN };

      if (str(data?.confirmation, 40).trim().toUpperCase() !== "DELETE") {
        return { ok: false, error: 'Type DELETE in the confirmation box to confirm. Nothing has been removed.' };
      }
      const password = typeof data?.password === "string" ? data.password : "";
      if (!password) return { ok: false, error: "Enter your password to confirm. Nothing has been removed." };

      const row = db.findUserByEmail(user.email);
      if (!row) return { ok: false, error: NOT_SIGNED_IN };
      const valid = await Bun.password.verify(password, row.password_hash);
      if (!valid) {
        return { ok: false, error: "That password doesn't match. Nothing has been removed." };
      }

      const deleted = db.deleteAccount(user.id);
      if (!deleted) return { ok: false, error: "Couldn't find your account. Please sign in again." };

      // Files first, then the folder that held them (which also catches anything
      // left behind by an older upload).
      let files = 0;
      for (const storedPath of deleted.materialPaths) {
        try {
          unlinkSync(join(db.uploadsRoot(), user.id, storedPath));
          files += 1;
        } catch {
          // Already gone — the row is what matters, and the folder sweep follows.
        }
      }
      try {
        rmSync(join(db.uploadsRoot(), user.id), { recursive: true, force: true });
      } catch {
        // Directory removal is best-effort; the rows and named files are gone.
      }

      endSession();
      return {
        ok: true,
        email: deleted.email,
        removed: {
          profile: deleted.profiles,
          applications: deleted.applications,
          materials: deleted.materials,
          sessions: deleted.sessions,
          resetLinks: deleted.resets,
          files,
        },
      };
    }
  );

// -------------------------------------------------------------------- profile ---

export const loadProfile = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ profile: ProfileFormValues }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    return { ok: true, profile: toFormValues(db.getProfile(user.id)) };
  }
);
/**
 * The qualifications facts for the signed-in account, with the user's own
 * decisions applied.
 *
 * Deterministic and offline: the facts module reads the user's own résumé text
 * and vault fields, so no model is called and nothing can be invented. It
 * re-reads the material whenever it has changed since the stored pass, then
 * re-applies the user's decisions (kept / corrected / excluded / added) on top —
 * a re-read never discards one of them.
 *
 * The confirmation status is computed here, not in the browser: it compares a
 * fingerprint of the set as it stands now with the one stored when the user
 * confirmed it, so an edited set reads as "changed" rather than confirmed.
 */
export const loadQualifications = createServerFn({ method: "POST" }).handler(
  async (): Promise<
    Result<{
      facts: Fact[];
      report: ExtractionReport;
      computedAt: string;
      recomputed: boolean;
      decisionNotes: string[];
      decisionsUpdatedAt: string | null;
      confirmations: FactConfirmations;
      confirmationStatus: { overall: ConfirmationStatus; categories: Record<FactCategory, ConfirmationStatus> };
    }>
  > => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    try {
      const state = qualifications.ensureFacts(user.id);
      return {
        ok: true,
        facts: state.facts,
        report: state.report,
        computedAt: state.computedAt,
        recomputed: state.recomputed,
        decisionNotes: state.decisionNotes,
        decisionsUpdatedAt: state.decisionsUpdatedAt,
        confirmations: state.confirmations,
        confirmationStatus: {
          overall: qualifications.confirmationMatches(state.confirmations, state.facts, "overall")
            ? "confirmed"
            : state.confirmations.overall
              ? "changed"
              : "pending",
          categories: Object.fromEntries(
            FACT_CATEGORY_ORDER.map((category) => [
              category,
              qualifications.confirmationMatches(state.confirmations, state.facts, category)
                ? "confirmed"
                : state.confirmations.categories[category]
                  ? "changed"
                  : "pending",
            ])
          ) as Record<FactCategory, ConfirmationStatus>,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          "We couldn't read your material just now. Nothing has been changed — try again in a moment." +
          (error instanceof Error ? ` (${error.message})` : ""),
      };
    }
  }
);

/**
 * STAGE 3: what this account would put in each standard field of a real
 * application form, each answer carrying the fact it came from and the line or
 * vault field behind that fact.
 *
 * Deterministic and offline: the answers come from the same fact set the review
 * screen shows, with the user's decisions applied, and only facts the user has
 * CONFIRMED are ever used. A fact that isn't confirmed yet is reported as
 * pending instead; a field nothing covers comes back "not covered" with a
 * pointer to where the real detail belongs. Nothing is written and nothing is
 * sent — there is no submit path.
 */
export const loadFieldAnswers = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ answers: FieldAnswers }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    try {
      return { ok: true, answers: fieldAnswersFor(user.id) };
    } catch (error) {
      return {
        ok: false,
        error:
          "We couldn't put your answers together just now. Nothing has been changed — try again in a moment." +
          (error instanceof Error ? ` (${error.message})` : ""),
      };
    }
  }
);

// --------------------------------------------------- reviewing the fact set ---
// Every one of these writes only what the user themselves decided. There is no
// path here that changes a fact on the user's behalf, and none of them sends
// anything anywhere: the app has no submit path at all.

/** The one thing these handlers need from the browser: which fact, and what. */
function readFactId(raw: unknown): string {
  return str(raw, 200);
}

function readScope(raw: unknown): "overall" | FactCategory | null {
  if (raw === "overall") return "overall";
  return FACT_CATEGORY_ORDER.includes(raw as FactCategory) ? (raw as FactCategory) : null;
}

/** Wraps one decision write so every failure reads the same way. */
function runDecision(work: () => Outcome): Result {
  try {
    const result = work();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error) {
    return {
      ok: false,
      error:
        "We couldn't save that just now — nothing was changed. Try again in a moment." +
        (error instanceof Error ? ` (${error.message})` : ""),
    };
  }
}

/** Keep a fact: the user confirms it is right and it becomes usable. */
export const keepFact = createServerFn({ method: "POST" })
  .validator((input: { id?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const id = readFactId(data?.id);
    if (!id) return { ok: false, error: "We didn't get a fact to keep — reload the page and try again." };
    return runDecision(() => qualifications.keepFact(user.id, id));
  });

/** Correct a fact: the user's own wording replaces part of it, original line kept. */
export const correctFact = createServerFn({ method: "POST" })
  .validator((input: { id?: unknown; fields?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const id = readFactId(data?.id);
    if (!id) return { ok: false, error: "We didn't get a fact to save — reload the page and try again." };
    return runDecision(() => qualifications.correctFact(user.id, id, data?.fields));
  });

/** Exclude a fact: not used anywhere, still listed so it can be brought back. */
export const excludeFact = createServerFn({ method: "POST" })
  .validator((input: { id?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const id = readFactId(data?.id);
    if (!id) return { ok: false, error: "We didn't get a fact to exclude — reload the page and try again." };
    return runDecision(() => qualifications.excludeFact(user.id, id));
  });

/** Undo a decision, returning the fact to whatever the material says on its own. */
export const restoreFact = createServerFn({ method: "POST" })
  .validator((input: { id?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const id = readFactId(data?.id);
    if (!id) return { ok: false, error: "We didn't get a fact to restore — reload the page and try again." };
    return runDecision(() => qualifications.restoreFact(user.id, id));
  });

/**
 * Add a fact the extractor missed. It is stored as the user's own: labelled
 * "you added this", with no résumé quote attached, because it did not come from
 * one.
 */
export const addFact = createServerFn({ method: "POST" })
  .validator((input: { category?: unknown; fields?: unknown; note?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const category = readScope(data?.category);
    if (!category || category === "overall") {
      return { ok: false, error: "Choose which part of your qualifications this belongs to." };
    }
    return runDecision(() => qualifications.addFact(user.id, category, data?.fields, data?.note));
  });

/**
 * Confirm a set is right — one category, or everything at once — and store when.
 * This is the flag stage 3 will gate on before answering a real application field
 * from these facts.
 */
export const confirmFacts = createServerFn({ method: "POST" })
  .validator((input: { scope?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const scope = readScope(data?.scope);
    if (!scope) return { ok: false, error: "We didn't get a set to confirm — reload the page and try again." };
    return runDecision(() => qualifications.confirmFacts(user.id, scope));
  });


export const saveProfile = createServerFn({ method: "POST" })
  .validator((input: { profile?: unknown }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const profile = readProfileInput(data?.profile);
    if (!profile.full_name.trim()) return { ok: false, error: "Add your full name — it goes on every document." };
    try {
      db.saveProfile(user.id, profile);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't save your profile. Try again." };
    }
  });

// ------------------------------------------------------------------ materials ---
//
// Uploaded originals (résumé, transcript, cover-letter sample…) are kept as real
// files on disk so the browser agent can attach them to a live application form
// later, and their text is extracted here, server-side, for use in kits. The
// extraction result is always reported back to the client — a bad or empty parse
// is shown to the user rather than trusted.

/** How many materials one account can hold. */
const MAX_MATERIALS = 20;
/** How much extracted text the vault previews per material. */
const PREVIEW_CHARS = 2000;
/** Base64 padding/encoding overhead over the byte cap. */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 16;
const RESUME_LABEL = "Résumé";

function summariseMaterial(material: db.Material): MaterialSummary {
  const text = material.extracted_text;
  return {
    id: material.id,
    label: material.label,
    isResume: material.is_resume === 1,
    filename: material.filename,
    mimeType: material.mime_type,
    sizeBytes: material.size_bytes,
    createdAt: material.created_at,
    extractStatus: (material.extract_status || "ok") as MaterialSummary["extractStatus"],
    extractNote: material.extract_note,
    textPreview: text.slice(0, PREVIEW_CHARS),
    textLength: text.length,
  };
}

function labelFrom(raw: unknown): string {
  const value = str(raw, 60).trim();
  if (!value) return RESUME_LABEL;
  return value;
}

/** Absolute path of a material's stored original. */
function storedPathFor(userId: string, storedPath: string): string {
  return join(db.uploadsRoot(), userId, storedPath);
}

export const listMaterials = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ items: MaterialSummary[] }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    return { ok: true, items: db.listMaterials(user.id).map(summariseMaterial) };
  }
);

export const uploadMaterial = createServerFn({ method: "POST" })
  .validator(
    (input: { filename?: string; mimeType?: string; label?: string; dataBase64?: string }) => input
  )
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        material: MaterialSummary;
        /** Non-empty when this upload replaced the profile's résumé text. */
        resumeText: string;
        replacedResumeText: boolean;
      }>
    > => {
      const user = currentUser();
      if (!user) return { ok: false, error: NOT_SIGNED_IN };

      const filename = str(data?.filename, 200).trim();
      if (!filename) return { ok: false, error: "That upload didn't include a file name — try again." };

      const encoded = typeof data?.dataBase64 === "string" ? data.dataBase64 : "";
      if (!encoded) return { ok: false, error: `${filename} came through empty — try the upload again.` };
      if (encoded.length > MAX_BASE64_CHARS) {
        return { ok: false, error: `${filename} is bigger than the ${HUMAN_MAX_SIZE} limit. Upload a smaller file, or paste the text instead.` };
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(encoded, "base64"));
      } catch {
        return { ok: false, error: `${filename} didn't upload cleanly — try again, or paste the text instead.` };
      }
      if (bytes.length === 0) {
        return { ok: false, error: `${filename} is empty — there's nothing in it to read.` };
      }
      if (bytes.length > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          error: `${filename} is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB — the limit is ${HUMAN_MAX_SIZE}. Compress it, or paste the text instead.`,
        };
      }

      const sniffed = sniffUpload(filename, str(data?.mimeType, 200), bytes);
      if (!sniffed.ok) return { ok: false, error: sniffed.error };

      // Capture the size BEFORE parsing: pdf.js transfers the buffer it is given
      // to its worker, which detaches it and leaves `bytes.length === 0`.
      const sizeBytes = bytes.length;

      if (db.countMaterials(user.id) >= MAX_MATERIALS) {
        return {
          ok: false,
          error: `You've already stored ${MAX_MATERIALS} materials. Delete one you no longer need first.`,
        };
      }

      const label = labelFrom(data?.label);
      const isResume = label === RESUME_LABEL;
      const storedPath = `${crypto.randomUUID()}.${sniffed.file.extension}`;
      const absolute = storedPathFor(user.id, storedPath);

      try {
        mkdirSync(join(db.uploadsRoot(), user.id), { recursive: true });
        writeFileSync(absolute, bytes);
      } catch {
        return { ok: false, error: `We couldn't store ${filename}. Try again in a moment.` };
      }

      const outcome = await extractTextFromBytes(sniffed.file, bytes);

      // Only a résumé fills the résumé text — and only when we actually read
      // something. A failed parse leaves what the user already had alone.
      const profile = db.getProfile(user.id);
      const previous = profile.resume_text;
      let resumeText = "";
      let replacedResumeText = false;
      const usableText = outcome.text.trim().length > 0;

      try {
        if (isResume && usableText) {
          db.saveProfile(user.id, { ...profile, resume_text: outcome.text });
          resumeText = outcome.text;
          replacedResumeText = previous.trim().length > 0 && previous !== outcome.text;
        }
        const material = db.createMaterial({
          userId: user.id,
          label,
          isResume,
          filename,
          mimeType: str(data?.mimeType, 200) || `application/octet-stream`,
          sizeBytes,
          storedPath,
          extractStatus: outcome.status,
          extractNote: outcome.note,
          extractedText: outcome.text,
        });
        return { ok: true, material: summariseMaterial(material), resumeText, replacedResumeText };
      } catch {
        try {
          unlinkSync(absolute);
        } catch {
          // The row never landed, so a leftover file is harmless; nothing to report.
        }
        return { ok: false, error: "Couldn't save that upload. Try again in a moment." };
      }
    }
  );

export const deleteMaterial = createServerFn({ method: "POST" })
  .validator((input: { id?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const material = db.getMaterial(user.id, str(data?.id, 100));
    if (!material) return { ok: false, error: "That material isn't in your account." };
    db.deleteMaterial(user.id, material.id);
    try {
      unlinkSync(storedPathFor(user.id, material.stored_path));
    } catch {
      // Already gone from disk — the row is what matters.
    }
    return { ok: true };
  });

/** Hands the original bytes back so the user can check what we're holding. */
export const loadMaterialFile = createServerFn({ method: "POST" })
  .validator((input: { id?: string }) => input)
  .handler(
    async ({
      data,
    }): Promise<Result<{ filename: string; mimeType: string; dataBase64: string }>> => {
      const user = currentUser();
      if (!user) return { ok: false, error: NOT_SIGNED_IN };
      const material = db.getMaterial(user.id, str(data?.id, 100));
      if (!material) return { ok: false, error: "That material isn't in your account." };
      try {
        const bytes = readFileSync(storedPathFor(user.id, material.stored_path));
        return {
          ok: true,
          filename: material.filename,
          mimeType: material.mime_type || "application/octet-stream",
          dataBase64: Buffer.from(bytes).toString("base64"),
        };
      } catch {
        return { ok: false, error: `We couldn't find the stored copy of ${material.filename}. Upload it again.` };
      }
    }
  );

/** Copies a material's extracted text into the profile's résumé field. */
export const useMaterialAsResume = createServerFn({ method: "POST" })
  .validator((input: { id?: string }) => input)
  .handler(async ({ data }): Promise<Result<{ resumeText: string }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const material = db.getMaterial(user.id, str(data?.id, 100));
    if (!material) return { ok: false, error: "That material isn't in your account." };
    if (!material.extracted_text.trim()) {
      return {
        ok: false,
        error: `We didn't manage to read any text out of ${material.filename}. Paste your résumé text instead.`,
      };
    }
    const profile = db.getProfile(user.id);
    db.saveProfile(user.id, { ...profile, resume_text: material.extracted_text });
    return { ok: true, resumeText: material.extracted_text };
  });

// --------------------------------------------------------------- applications ---

/**
 * The rate-limit attempts that guard kit generation: per account (the real
 * guard) and per network (a backstop generous enough for shared addresses).
 */
function kitAttempts(userId: string): Array<{ rule: RuleName; bucket: string | null }> {
  const ip = ipBucket();
  return [
    { rule: "kit_user_minute", bucket: userBucket(userId) },
    { rule: "kit_user_hour", bucket: userBucket(userId) },
    { rule: "kit_user_day", bucket: userBucket(userId) },
    { rule: "kit_ip_hour", bucket: ip },
    { rule: "kit_ip_day", bucket: ip },
  ];
}

export const fetchPosting = createServerFn({ method: "POST" })
  .validator((input: { url?: string }) => input)
  .handler(
    async ({ data }): Promise<Result<{ text: string; title: string; company: string }>> => {
      const user = currentUser();
      if (!user) return { ok: false, error: NOT_SIGNED_IN };
      const url = normalisePostingUrl(str(data?.url, 1000));
      if (!url) return { ok: false, error: "Paste the posting link first." };
      const fetched = await fetchPostingText(url);
      if (!fetched.ok) return fetched;
      const hints = readPostingHints(fetched.text, url);
      return { ok: true, text: fetched.text, title: hints.title, company: hints.company };
    }
  );

export const createApplication = createServerFn({ method: "POST" })
  .validator(
    (input: { text?: string; url?: string; title?: string; company?: string }) => input
  )
  .handler(async ({ data }): Promise<Result<{ id: string }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };

    // Drafting kits is the one thing worth protecting from a script: counted per
    // account (the real guard) and per network (a backstop).
    const limit = checkAndRecord(kitAttempts(user.id));
    if (!limit.ok) return { ok: false, error: `${limit.error} Nothing was generated.` };

    const url = normalisePostingUrl(str(data?.url, 1000));
    let text = str(data?.text, 40000).trim();

    if (!text) {
      if (!url) {
        return {
          ok: false,
          error: "Paste the job posting text (or a link we can read) so there's something to work from.",
        };
      }
      const fetched = await fetchPostingText(url);
      if (!fetched.ok) return fetched;
      text = fetched.text;
    }
    if (text.length < 80) {
      return { ok: false, error: "That posting text is very short — paste a bit more of the ad." };
    }

    const hints = readPostingHints(text, url);
    const application = db.createApplication({
      userId: user.id,
      title: str(data?.title, 200).trim() || hints.title,
      company: str(data?.company, 200).trim() || hints.company,
      url,
      postingText: text,
    });

    const kit = generateKit({ profile: db.getProfile(user.id), application });
    db.saveKit(user.id, application.id, JSON.stringify(kit));
    return { ok: true, id: application.id };
  });

export const listApplications = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<{ items: ApplicationSummary[] }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    return { ok: true, items: db.listApplications(user.id).map(summarise) };
  }
);

export const loadApplication = createServerFn({ method: "POST" })
  .validator((input: { id?: string }) => input)
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        application: { id: string; title: string; company: string; url: string; createdAt: string };
        kit: Kit | null;
      }>
    > => {
      const user = currentUser();
      if (!user) return { ok: false, error: NOT_SIGNED_IN };
      const application = db.getApplication(user.id, str(data?.id, 100));
      if (!application) return { ok: false, error: "That application isn't in your account." };
      return {
        ok: true,
        application: {
          id: application.id,
          title: application.title,
          company: application.company,
          url: application.url,
          createdAt: application.created_at,
        },
        kit: parseKit(application.kit_json),
      };
    }
  );

export const regenerateKit = createServerFn({ method: "POST" })
  .validator((input: { id?: string; title?: string; company?: string }) => input)
  .handler(async ({ data }): Promise<Result<{ kit: Kit }>> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    const application = db.getApplication(user.id, str(data?.id, 100));
    if (!application) return { ok: false, error: "That application isn't in your account." };

    // Redrafting counts against the same kit limits as drafting a new one.
    const limit = checkAndRecord(kitAttempts(user.id));
    if (!limit.ok) return { ok: false, error: `${limit.error} Nothing was generated.` };

    const title = str(data?.title, 200).trim();
    const company = str(data?.company, 200).trim();
    if (title !== "" || company !== "") {
      db.updateApplicationDetails(user.id, application.id, {
        title: title || application.title,
        company: company || application.company,
      });
    }

    const updated = db.getApplication(user.id, application.id);
    if (!updated) return { ok: false, error: "That application isn't in your account." };
    const kit = generateKit({ profile: db.getProfile(user.id), application: updated });
    db.saveKit(user.id, application.id, JSON.stringify(kit));
    return { ok: true, kit };
  });

export const deleteApplication = createServerFn({ method: "POST" })
  .validator((input: { id?: string }) => input)
  .handler(async ({ data }): Promise<Result> => {
    const user = currentUser();
    if (!user) return { ok: false, error: NOT_SIGNED_IN };
    db.deleteApplication(user.id, str(data?.id, 100));
    return { ok: true };
  });
