/**
 * Funnel instrumentation — where people get through the product and where they
 * stop, recorded first-party so we can read it instead of guessing.
 *
 * Five steps, and no more:
 *
 *   1. signup                     a new account was created
 *   2. profile_complete           the vault holds enough to build an application from
 *   3. posting_added              a job posting was saved
 *   4. kit_generated              a kit was produced for a posting
 *   5. application_taken_forward  the user chose one kit to carry to the real form
 *
 * Three rules hold for every one of them, and the check script proves all three:
 *
 *   NO CONTENT. A step is a local user id, a step name and a timestamp. Never
 *   résumé or posting text, an answer, a company or employer name, an email, a
 *   name, a phone number, an IP address or a user agent string — not even as a
 *   length or a hash.
 *
 *   FIRST-PARTY ONLY. Steps are written through `src/db.ts` into our own
 *   database. No third-party analytics script, no external endpoint, no cookie
 *   beyond the session the app already sets.
 *
 *   REAL ACTIONS ONLY. A step is recorded when the user really does the thing,
 *   from the server action that does it — never on a page render. Asking for a
 *   page writes nothing.
 *
 * Every step is recorded once per account: the moment the account first gets
 * there. So the table reads directly as a funnel — rows per step = people who
 * got that far — and a repeated action (saving the vault twice, adding a second
 * posting) does not inflate it.
 */
import * as db from "~/db";
import type { FunnelEventName } from "~/db";

/**
 * Résumé text at or below this length is not something an application can be
 * built from — the kit would have nothing of the user's own to quote. The number
 * matches the kit generator's own "profile completeness" rule in
 * `src/server/generate.ts` (`profile.resume_text.trim().length > 40`), so this
 * step means the same thing the kit's completeness check means; the check script
 * fails if the two ever drift apart.
 */
export const RESUME_TEXT_MIN_CHARS = 40;

/** The threshold, in words, so the rule can be reported and reviewed verbatim. */
export const PROFILE_COMPLETE_RULE =
  "profile_complete is recorded the first time a saved vault has (a) a non-empty full name " +
  `AND (b) material to write from: résumé text longer than ${String(RESUME_TEXT_MIN_CHARS)} characters, ` +
  "or at least one role, or at least one education entry. A name alone does not count, and neither " +
  "does a two-line résumé: a kit built from that would be all gaps, so calling it 'complete' would " +
  "misreport the funnel.";

/** Just the profile material this decision is made from — no content is copied out. */
export type ProfileMaterial = {
  full_name: string;
  resume_text: string;
  experience: unknown[];
  education: unknown[];
};

/**
 * Whether a vault holds enough to build an application from. Pure and total: it
 * reads the fields it needs and nothing else, and it copies nothing anywhere.
 */
export function profileIsCompleteEnough(profile: ProfileMaterial): boolean {
  if (profile.full_name.trim().length === 0) return false;
  return (
    profile.resume_text.trim().length > RESUME_TEXT_MIN_CHARS ||
    profile.experience.length > 0 ||
    profile.education.length > 0
  );
}

/**
 * Records one step for one account, once ever. Instrumentation must never be
 * able to break the thing it measures: a store that cannot be written to logs and
 * carries on, and the caller's action still succeeds. It warns loudly rather than
 * failing silently, because a funnel that is quietly empty is worse than none.
 */
export function recordStep(userId: string, name: FunnelEventName): boolean {
  try {
    return db.recordFunnelEvent(userId, name);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[applypilot] could not record funnel step "${name}" (${detail})`);
    return false;
  }
}

/**
 * The `profile_complete` step, evaluated against the vault as it now stands.
 * Called after any action that can change the material a kit is written from —
 * saving the vault, and uploading or adopting a résumé — so the step lands on the
 * first real action that got the profile there, whatever that action was.
 */
export function noteProfileMaterial(userId: string): boolean {
  let profile: ProfileMaterial;
  try {
    profile = db.getProfile(userId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[applypilot] could not read the profile for the funnel step (${detail})`);
    return false;
  }
  if (!profileIsCompleteEnough(profile)) return false;
  return recordStep(userId, "profile_complete");
}
