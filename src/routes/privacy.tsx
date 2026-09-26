import { Link, createFileRoute } from "@tanstack/react-router";
import { Bullets, DocumentPage, Section } from "~/components/public";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — ApplyPilot" },
      {
        name: "description",
        content:
          "Exactly what ApplyPilot stores, who can see it, and how to export or delete everything. Written for this product; not reviewed by a lawyer yet.",
      },
    ],
  }),
  component: PrivacyPage,
});

const UPDATED = "26 September 2026";

function PrivacyPage() {
  return (
    <DocumentPage
      title="Privacy"
      updated={UPDATED}
      intro={
        <>
          <p>
            ApplyPilot is a small tool with a simple job: take the résumé and details you save once,
            and turn each job posting you paste in into a cover letter, some drafted answers and a
            keyword match. This page says, in plain words, exactly what that means for your
            information.
          </p>
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <strong>Honest note:</strong> this policy has not been reviewed by a lawyer. It describes
            what the software actually does today, and we update it when the software changes. If you
            need something that has been through legal review — for a university or an employer — get
            in touch first and we will tell you plainly what we can and cannot say.
          </p>
        </>
      }
    >
      <Section title="The short version">
        <Bullets
          items={[
            "We store your account, your profile vault, the files you upload and the text we read out of them, the job postings you paste, and the kits we generate from them.",
            "Nobody but you can see it through the app. There is no sharing, no public profile, and no employer access.",
            "We never submit anything to an employer. ApplyPilot has no submit button and no code path that sends an application anywhere.",
            "You can download everything as one file, and you can delete your whole account and its files yourself, from the Account page, at any time.",
            "There is no advertising, no tracking pixel, no analytics script, and no AI service reading your data.",
          ]}
        />
      </Section>

      <Section title="What we store">
        <p>All of this sits in one database file and one uploads folder on the server that runs ApplyPilot:</p>
        <Bullets
          items={[
            <>
              <strong>Your account</strong> — your email address, your password as a one-way hash (never
              the password itself), and when you signed up.
            </>,
            <>
              <strong>Your profile vault</strong> — the full name, email, phone, location, portfolio,
              GitHub and LinkedIn links, education, roles with dates, work authorisation, salary
              expectation and notice period you entered, plus your résumé text.
            </>,
            <>
              <strong>Your uploads</strong> — the original files you upload (for example a PDF résumé)
              stored as files on disk, and the text extracted from them so kits can quote you.
            </>,
            <>
              <strong>The job postings you paste</strong> — the text of each posting, and its link if you
              gave one.
            </>,
            <>
              <strong>The kits</strong> — the cover letter, drafted answers and keyword match generated for
              each posting.
            </>,
            <>
              <strong>Sign-in sessions</strong> — a random session token, stored only as a hash, with an
              expiry date, so you stay signed in for 30 days.
            </>,
            <>
              <strong>Password-reset links</strong> — if you ask for one, a single-use token stored as a
              hash, and when it expires. It is deleted when it is used or when a new one is issued.
            </>,
            <>
              <strong>Rate-limit counters</strong> — a row per attempt with the time, the kind of action,
              and an opaque identifier: your account id, or a one-way hash of your IP address. We keep the
              hash rather than the address, and the rows age out after two days.
            </>,
            <>
              <strong>Backups</strong> — a nightly copy of the database and the uploads folder, kept for up
              to 14 days and then deleted automatically.
            </>,
          ]}
        />
      </Section>

      <Section title="What we do not do">
        <Bullets
          items={[
            "We do not send anything to an employer, a job board or an applicant-tracking system. There is no submit path in this app at all.",
            "We do not invent experience, dates, employers or credentials. Every generated sentence is built from what you saved, and where a posting asks for something your profile does not cover, the kit says so instead of filling the gap.",
            "We do not sell, rent or share your data. There is no advertising, no data broker, and no third-party analytics or tracking on this site.",
            "We do not use an AI model on your data. The drafting runs on this server from your own text with rules and templates.",
            "We do not ask for your employer-account passwords, and we do not log into any account of yours.",
            "We do not keep a copy after you delete your account — with the one honest exception described below under 'Deleting everything'.",
          ]}
        />
      </Section>

      <Section title="Who can see it">
        <p>
          Through the app: only you. Your profile, materials and kits are looked up by your account id,
          every request is checked against your signed-in session, and there is no screen anywhere that
          shows one account another account&apos;s data.
        </p>
        <p>
          Behind the app: whoever runs the ApplyPilot server can technically read the database file and
          the uploads folder — the data is not encrypted at rest, and we are not going to pretend
          otherwise. Nobody else has access, and it is not used for anything except running and fixing
          the service.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          One cookie, <code className="rounded bg-slate-100 px-1">applypilot_session</code>. It holds a
          random session token so you stay signed in. It is httpOnly (no script can read it), SameSite=Lax,
          and marked Secure on the live https site. There are no tracking or advertising cookies. Signing
          out deletes the session on the server and clears the cookie.
        </p>
      </Section>

      <Section title="Email">
        <p>
          There is exactly one reason we email you: you asked for a password reset. When that happens
          your address is passed to our transactional email provider (Knock, knock.app) so it can deliver
          the message. Nothing else about you goes with it, and it is not used for marketing.
        </p>
        <p>
          If email is not set up on the deployment you are using, the reset page says so plainly rather
          than pretending a message went out — and nothing is sent.
        </p>
      </Section>

      <Section title="Exporting your data">
        <p>
          The{" "}
          <Link to="/account" className="font-medium text-indigo-600 hover:text-indigo-500">
            Account page
          </Link>{" "}
          has a <strong>Download my data</strong> button. It produces one JSON file with your profile
          vault, the extracted text of every upload, every job posting and every kit. Your original
          uploaded files are not embedded in that file — download each one from your profile vault. Your
          password cannot be exported, because it is stored as a one-way hash and nobody, including us,
          can read it back.
        </p>
      </Section>

      <Section title="Deleting everything">
        <p>
          The{" "}
          <Link to="/account" className="font-medium text-indigo-600 hover:text-indigo-500">
            Account page
          </Link>{" "}
          has a <strong>Delete my account</strong> button. Enter your password and type DELETE, and the
          account row, your profile, every application and kit, every session and every reset link go,
          along with your uploaded files from disk. It is immediate and there is no undo.
        </p>
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <strong>The honest exception:</strong> a deleted account may still exist inside a backup taken
          before you deleted it. Backups are kept for up to 14 days and then deleted automatically, so
          after two weeks nothing of yours remains anywhere. If you need a deletion to include the
          backups, write to us and we will remove your data from them and confirm it.
        </p>
      </Section>

      <Section title="Keeping it safe, and keeping it honest">
        <Bullets
          items={[
            "Passwords are hashed with Argon2id. Session tokens and reset tokens are stored only as one-way hashes.",
            "A password reset link works once, expires after an hour, and signs every other device out when it is used.",
            "Sign-up, password-reset requests and kit generation are rate limited, per account and per network. The limits are deliberately generous and they are listed on the Terms page.",
            "The database is backed up nightly, and the restore path is tested. See the Terms page for how the service is run.",
            "If something goes wrong with your data we will tell you what happened and what we are doing about it.",
          ]}
        />
      </Section>

      <Section title="Changes">
        <p>
          This page says what the software does today and it is kept in step with the code. If we start
          doing something new with your data, this page changes first and the date at the top moves.
        </p>
      </Section>
    </DocumentPage>
  );
}
