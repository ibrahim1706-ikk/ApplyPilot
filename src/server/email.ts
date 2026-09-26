/**
 * Transactional email — server-only. The ONLY module that reads the mail
 * credentials, and it never runs in the browser (it is imported only from
 * server-function handlers, so it is bundled into a server chunk).
 *
 * The provider is Knock (https://knock.app). Two secrets are read from the
 * environment, which the owner sets on the Secrets page — never in a .env file,
 * never committed:
 *
 *   KNOCK_API_KEY      authorises calls to the Knock API (sent as a bearer token)
 *   KNOCK_SIGNING_KEY  the key Knock signs its own requests to us with, for
 *                      verifying webhook deliveries (we do not run a webhook yet;
 *                      it is read and reported so nothing is missing the day we do)
 *   KNOCK_RESET_WORKFLOW  optional: the key of the Knock workflow that renders and
 *                      sends the password-reset email. Defaults to "password-reset".
 *
 * HONESTY RULE, on purpose: nothing here reports success it did not observe. If a
 * key is missing the caller is told email is not configured; if the provider call
 * fails the caller is told the send failed. There is no code path that claims an
 * email went out without a 2xx from the provider.
 */

const KNOCK_API_BASE = "https://api.knock.fm/v1";
const DEFAULT_RESET_WORKFLOW = "password-reset";
const SEND_TIMEOUT_MS = 10_000;

/** What the app knows about email right now. Never contains a secret value. */
export type EmailStatus =
  | { configured: true; provider: "Knock"; workflow: string; signingKeyPresent: boolean }
  | { configured: false; provider: "Knock"; missing: string[]; signingKeyPresent: boolean };

function envValue(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads the credentials on every call (not at module load) so that saving the
 * keys on the Secrets page takes effect on the next request, without a rebuild
 * — the platform restarts the site with the new values within seconds.
 */
function credentials(): { apiKey: string; signingKey: string; workflow: string } {
  return {
    apiKey: envValue("KNOCK_API_KEY"),
    signingKey: envValue("KNOCK_SIGNING_KEY"),
    workflow: envValue("KNOCK_RESET_WORKFLOW") || DEFAULT_RESET_WORKFLOW,
  };
}

export function emailStatus(): EmailStatus {
  const { apiKey, signingKey, workflow } = credentials();
  const signingKeyPresent = signingKey.length > 0;
  if (!apiKey) {
    return {
      configured: false,
      provider: "Knock",
      missing: ["KNOCK_API_KEY"],
      signingKeyPresent,
    };
  }
  return { configured: true, provider: "Knock", workflow, signingKeyPresent };
}

export type SendResult = { ok: true } | { ok: false; error: string; configured: boolean };

/**
 * Sends the password-reset email through Knock and reports exactly what happened.
 * A non-2xx from Knock, a timeout or a network failure all come back as
 * `{ ok: false }` — the caller must not tell the user an email was sent unless
 * this returns `ok: true`.
 */
export async function sendPasswordResetEmail(input: {
  to: string;
  userId: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<SendResult> {
  const { apiKey, workflow } = credentials();
  if (!apiKey) {
    return {
      ok: false,
      configured: false,
      error: "Email sending is not configured on this deployment.",
    };
  }

  try {
    const response = await fetch(`${KNOCK_API_BASE}/workflows/${encodeURIComponent(workflow)}/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // `recipients` inline-identifies the user with Knock, so the address reaches
      // the workflow even if this account was never seen by Knock before.
      body: JSON.stringify({
        recipients: [{ id: input.userId, email: input.to }],
        data: {
          reset_url: input.resetUrl,
          expires_minutes: input.expiresMinutes,
          product: "ApplyPilot",
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        configured: true,
        error: `The email provider refused the message (HTTP ${String(response.status)}${body ? `: ${body.slice(0, 200)}` : ""}).`,
      };
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return { ok: false, configured: true, error: `Couldn't reach the email provider (${detail}).` };
  }
}
