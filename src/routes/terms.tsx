import { Link, createFileRoute } from "@tanstack/react-router";
import { CONTACT_EMAIL, Bullets, DocumentPage, Section } from "~/components/public";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms — ApplyPilot" },
      {
        name: "description",
        content:
          "What ApplyPilot is, what it is not, the limits it runs under, and what we each owe each other. Written for this product; not reviewed by a lawyer yet.",
      },
    ],
  }),
  component: TermsPage,
});

const UPDATED = "26 September 2026";

function TermsPage() {
  return (
    <DocumentPage
      title="Terms of use"
      updated={UPDATED}
      intro={
        <>
          <p>
            These terms cover using ApplyPilot. They are written in plain language so you can actually
            read them, and they describe the software as it exists today.
          </p>
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <strong>Honest note:</strong> this document has not been reviewed by a lawyer. It is an
            early-stage product statement of how the service works and what we each expect — not a
            polished legal instrument. If you need something formally drafted and reviewed, tell us
            before you rely on this.
          </p>
        </>
      }
    >
      <Section title="What ApplyPilot is">
        <Bullets
          items={[
            "A tool that saves your résumé, links and application details once, then drafts a tailored cover letter, answers to the usual application questions, and a keyword match for each job posting you paste in.",
            "A drafting assistant. Every generated piece is there for you to read, correct, copy and use as you see fit.",
          ]}
        />
      </Section>

      <Section title="What ApplyPilot is not">
        <Bullets
          items={[
            <>
              <strong>It is not an application service.</strong> Nothing in ApplyPilot submits an
              application. There is no auto-submit, no background sending, and no way for us to act on
              your behalf with an employer. You send every application yourself.
            </>,
            <>
              <strong>It does not write your history.</strong> It never invents experience, employers,
              dates, credentials or qualifications. Everything comes from what you saved, and where a
              posting asks for something your profile does not cover, the kit tells you so instead of
              filling the gap.
            </>,
            <>
              <strong>It is not legal, immigration, tax or career advice.</strong> Work-authorisation and
              salary fields repeat exactly what you entered; deciding what to enter is yours, and we
              recommend checking it against the posting and, where it matters, with someone qualified.
            </>,
            <>
              <strong>It cannot guarantee an interview or a job.</strong> No tool can. It saves you the
              typing, not the judgement.
            </>,
          ]}
        />
      </Section>

      <Section title="Your account">
        <Bullets
          items={[
            "Use an email address you can actually receive mail at — it is the only way to reset a forgotten password.",
            "Keep your password to yourself. Anyone with it can see and change your profile data. Ask for a reset from the sign-in page if you think it has leaked.",
            "Use one account for yourself. Accounts are personal, and sharing one login between people means one of you can delete the other's work.",
            "Tell us if you think someone else has got into your account.",
          ]}
        />
      </Section>

      <Section title="Your content, and ours">
        <p>
          Your résumé, your uploads, the postings you paste and the kits generated from them are yours.
          We claim no ownership of them and we do not use them for anything except running the service
          for you.
        </p>
        <p>
          By using ApplyPilot you confirm that what you put in is true and is yours to use — you are
          responsible for the accuracy of every application you send, and for making sure you have the
          right to share the documents you upload.
        </p>
        <p>
          The ApplyPilot name, the wording of the product itself and the code behind it stay ours. Build
          your applications with it freely; do not resell it or clone the service.
        </p>
      </Section>

      <Section title="How we run it, and the limits">
        <Bullets
          items={[
            <>
              <strong>Rate limits.</strong> Sign-up is limited to 3 attempts per email address and 6 new
              accounts per network per hour (40 per day). Drafting kits is limited to 30 per account per
              day, 12 per hour, and never more than 5 in a minute; drafts from one network are capped at
              40 an hour. Password-reset requests are limited to 3 per address and 8 per network per hour.
              These are set to stop bulk abuse, not to slow down a person making a few applications. When
              a limit is hit the app says which one and when to try again.
            </>,
            <>
              <strong>The two-a-day rule.</strong> ApplyPilot takes at most two applications forward for
              you per day. Quality over volume is the whole point of the product, and the cap is part of
              it. Drafting a handful of kits and choosing the best one is fine and unlimited in practice —
              the cap is on applications taken forward. Today nothing is submitted by us at all, so the
              cap binds the moment in-app form filling ships, when it will be enforced by the app itself.
            </>,
            <>
              <strong>Fair use.</strong> Do not script, scrape, hammer or resell the service; do not use
              it to send misleading applications or to impersonate anyone; do not try to reach another
              account's data.
            </>,
            <>
              <strong>Changes and availability.</strong> ApplyPilot is early software. It can go down, and
              features can change. We keep a nightly backup and a tested restore path, and we will say so
              plainly if we lose something.
            </>,
          ]}
        />
      </Section>

      <Section title="Suspending an account">
        <p>
          We may suspend or close an account that is being used for abuse — bulk sign-ups, scripted
          requests, attempts to reach other people&apos;s data, or misleading applications. Where it is
          reasonable to do so we will tell you why and give you the chance to export your data first.
        </p>
      </Section>

      <Section title="Ending your use">
        <p>
          You can leave whenever you like: the{" "}
          <Link to="/account" className="font-medium text-indigo-600 hover:text-indigo-500">
            Account page
          </Link>{" "}
          deletes your account and everything it holds, immediately and permanently. Export first if you
          want a copy — deletion is not reversible. The one thing deletion cannot reach is a backup taken
          before you deleted; those are kept for up to 14 days and then removed. See the{" "}
          <Link to="/privacy" className="font-medium text-indigo-600 hover:text-indigo-500">
            Privacy page
          </Link>{" "}
          for exactly what is stored and how to have your data removed from backups too.
        </p>
      </Section>

      <Section title="Liability, in plain words">
        <p>
          We run ApplyPilot carefully and we fix what we break. But it is early software from a small
          team, provided as it is: we cannot promise it will be free of faults, and we cannot take on
          liability for a missed application, a job you did not get, or a decision you made on the
          strength of a draft. Read everything the app generates before you send it — that is the point
          of the review step, not a formality.
        </p>
        <p>
          If something goes wrong, write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-indigo-600 hover:text-indigo-500">
            {CONTACT_EMAIL}
          </a>{" "}
          and we will tell you exactly what happened and what we are doing about it.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          If these terms change, the date at the top of this page changes with them, and a change that
          matters to you — how your data is used, what the service does — will be said plainly rather
          than buried.
        </p>
      </Section>
    </DocumentPage>
  );
}
