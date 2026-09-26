import { Link, createFileRoute } from "@tanstack/react-router";
import { Card, buttonStyles } from "~/components/ui";
import { SiteFooter } from "~/components/public";
import { sessionInfo } from "~/server/actions";

export const Route = createFileRoute("/")({
  loader: async () => sessionInfo(),
  head: () => ({
    meta: [
      { title: "ApplyPilot — turn your profile into finished job applications" },
      {
        name: "description",
        content:
          "ApplyPilot takes the résumé and links you save once and turns each job posting you paste into a tailored cover letter, drafted application answers and a keyword match — for you to review and send yourself.",
      },
    ],
  }),
  component: Landing,
});

const STEPS = [
  {
    title: "1. Build your profile vault once",
    body: "Paste your résumé text, add your portfolio, GitHub and LinkedIn links, and the details every application form asks for: contact info, education, roles with dates, work authorisation.",
  },
  {
    title: "2. Paste a job posting",
    body: "Paste the ad as text, or drop in the link — pasted text always works, links work when the page is readable.",
  },
  {
    title: "3. Get the kit for that posting",
    body: "A tailored cover letter, drafted answers to the usual questions (why this role, about you, strengths, salary, notice period, work rights), and a keyword match showing what the posting asks for and what your profile already evidences.",
  },
  {
    title: "4. Review, copy, send",
    body: "Every piece has a copy button. You check the wording, adjust, and submit the application yourself.",
  },
];

function Landing() {
  const session = Route.useLoaderData();

  return (
    <div className="min-h-dvh bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <header className="flex items-center justify-between">
          <span className="text-base font-semibold tracking-tight text-slate-900">ApplyPilot</span>
          <nav className="flex items-center gap-2 text-sm">
            {session.signedIn ? (
              <Link to="/applications" className={buttonStyles.primary}>
                Go to my applications
              </Link>
            ) : (
              <>
                <Link to="/signin" className={buttonStyles.secondary}>
                  Sign in
                </Link>
                <Link to="/signup" className={buttonStyles.primary}>
                  Create account
                </Link>
              </>
            )}
          </nav>
        </header>

        <h1 className="mt-14 text-3xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          One profile, then a finished application kit for every job you paste in.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">
          ApplyPilot saves your résumé, links and application details once, then turns any job posting you
          paste in into a tailored cover letter, drafted answers to the usual questions and a keyword match
          against the role — so you can spend your evening on something other than forms.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          {session.signedIn ? (
            <Link to="/new" className={buttonStyles.primary}>
              Paste a job posting
            </Link>
          ) : (
            <>
              <Link to="/signup" className={buttonStyles.primary}>
                Create your account
              </Link>
              <Link to="/signin" className={buttonStyles.secondary}>
                I already have one
              </Link>
            </>
          )}
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2">
          {STEPS.map((step) => (
            <Card key={step.title}>
              <h2 className="text-sm font-semibold text-slate-900">{step.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
            </Card>
          ))}
        </div>

        <Card className="mt-6 border-slate-300 bg-white">
          <h2 className="text-sm font-semibold text-slate-900">What ApplyPilot will not do</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-600">
            <li>
              • It never invents experience, dates, employers or credentials. Every sentence is built from
              the profile you saved, and where a posting asks for something your profile doesn&apos;t cover
              it says so — “your profile doesn&apos;t mention X” — instead of making something up.
            </li>
            <li>
              • It never applies to anything. There is no auto-submit and no background sending: you review,
              copy and submit each application yourself.
            </li>
            <li>• It doesn&apos;t have access to your real employer accounts, and it doesn&apos;t guess salary or
              visa details — you save those once, and it repeats them exactly.</li>
          </ul>
        </Card>

        <p className="mt-8 text-xs text-slate-500">
          Drafting runs from your own profile text with rules and templates — no external AI service, no
          magic. Early version: plain, honest, and built to save you an evening per application.{" "}
          <Link to="/privacy" className="font-medium text-slate-600 underline hover:text-indigo-600">
            What we store
          </Link>{" "}
          ·{" "}
          <Link to="/terms" className="font-medium text-slate-600 underline hover:text-indigo-600">
            Terms
          </Link>
        </p>
      </div>
      <SiteFooter />
    </div>
  );
}
