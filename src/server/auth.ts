/**
 * Session handling. Server-only: reads and writes the httpOnly session cookie
 * and looks the session up in the database. Nothing here is ever imported by a
 * component.
 *
 * The cookie holds a random token; the database stores only its SHA-256 hash, so
 * a copy of the database file cannot be turned into a logged-in session. The
 * cookie is httpOnly (no JS access), SameSite=Lax, and Secure whenever the
 * request arrived over https (the published site) — which keeps local http
 * testing working without weakening the live site.
 */
import { deleteCookie, getCookie, getRequestProtocol, setCookie } from "@tanstack/react-start/server";
import * as db from "~/db";

const SESSION_COOKIE = "applypilot_session";
const SESSION_DAYS = 30;
const SECONDS_PER_DAY = 60 * 60 * 24;

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function isHttps(): boolean {
  try {
    return getRequestProtocol({ xForwardedProto: true }) === "https";
  } catch {
    return false;
  }
}

export function startSession(userId: string): void {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * SECONDS_PER_DAY * 1000).toISOString();
  db.createSession(hashToken(token), userId, expiresAt);
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isHttps(),
    maxAge: SESSION_DAYS * SECONDS_PER_DAY,
  });
}

export function endSession(): void {
  const token = getCookie(SESSION_COOKIE);
  if (token) db.deleteSession(hashToken(token));
  deleteCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: isHttps() });
}

export function currentUser(): db.User | null {
  const token = getCookie(SESSION_COOKIE);
  if (!token) return null;
  return db.findSessionUser(hashToken(token));
}
