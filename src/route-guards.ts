/**
 * Route guards. Work on the server (during SSR) and in the browser (on client
 * navigation) because they only call a server function and then redirect.
 */
import { redirect } from "@tanstack/react-router";
import { sessionInfo } from "~/server/actions";

export async function requireSession(): Promise<{ signedIn: boolean; email: string }> {
  const session = await sessionInfo();
  if (!session.signedIn) throw redirect({ to: "/signin" });
  return session;
}

export async function requireSignedOut(): Promise<void> {
  const session = await sessionInfo();
  if (session.signedIn) throw redirect({ to: "/applications" });
}
