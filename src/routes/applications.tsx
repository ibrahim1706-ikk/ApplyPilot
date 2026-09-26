import { Link, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell";
import { Badge, Card, buttonStyles } from "~/components/ui";
import { requireSession } from "~/route-guards";
import { listApplications } from "~/server/actions";

export const Route = createFileRoute("/applications")({
  beforeLoad: requireSession,
  loader: async () => listApplications(),
  head: () => ({ meta: [{ title: "Your applications — ApplyPilot" }] }),
  component: ApplicationsPage,
});

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function ApplicationsPage() {
  const context = Route.useRouteContext();
  const data = Route.useLoaderData();

  return (
    <AppShell email={context.email ?? ""}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Your applications</h1>
          <p className="text-sm text-slate-600">
            Every posting you&apos;ve pasted in, with the kit that was generated for it.
          </p>
        </div>
        <Link to="/new" className={buttonStyles.primary}>
          New application
        </Link>
      </div>

      {!data.ok ? (
        <Card className="mt-6">
          <p className="text-sm text-slate-700">{data.error}</p>
        </Card>
      ) : data.items.length === 0 ? (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold text-slate-900">No applications yet</h2>
          <p className="mt-2 text-sm text-slate-600">
            Two steps: fill in your{" "}
            <Link to="/profile" className="font-medium text-indigo-600 hover:text-indigo-500">
              profile vault
            </Link>
            , then paste a job posting and ApplyPilot will draft the kit for it.
          </p>
          <Link to="/new" className={`${buttonStyles.primary} mt-4`}>
            Paste a job posting
          </Link>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {data.items.map((item) => (
            <li key={item.id}>
              <Link to="/kit/$id" params={{ id: item.id }} className="block">
                <Card className="transition hover:border-indigo-300 hover:shadow">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="mr-auto min-w-0">
                      <h2 className="truncate text-sm font-semibold text-slate-900">
                        {item.title || "Untitled role"}
                        {item.company ? <span className="text-slate-500"> · {item.company}</span> : null}
                      </h2>
                      <p className="mt-1 text-xs text-slate-500">
                        Created {dateFormatter.format(new Date(item.createdAt))}
                        {item.url ? <span className="break-all"> · {item.url}</span> : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.coverage !== null ? (
                        <Badge tone={item.coverage >= 60 ? "green" : item.coverage >= 30 ? "amber" : "red"}>
                          {item.coverage}% of posting keywords evidenced
                        </Badge>
                      ) : (
                        <Badge>No kit yet</Badge>
                      )}
                      {item.missingCount > 0 ? <Badge tone="amber">{item.missingCount} gaps</Badge> : null}
                      <span className="text-sm font-medium text-indigo-600">Open kit →</span>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
