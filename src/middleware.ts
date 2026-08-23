import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/auth/constants";

/**
 * Convenience redirect for signed-out visitors.
 *
 * This checks only that a session cookie is *present*. It is deliberately not
 * the authorization boundary: middleware runs on the Edge runtime, where
 * node:crypto is unavailable, so the HMAC verification cannot happen here.
 *
 * The real check is `isSignedIn()`, which runs inside every page and every API
 * route via `withAdmin`. A forged cookie gets past this file and then fails
 * there. Treating middleware as the gate would be the classic mistake.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublic =
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";

  if (isPublic) return NextResponse.next();

  if (!request.cookies.get(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
