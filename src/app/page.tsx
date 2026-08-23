import { redirect } from "next/navigation";

import { isSignedIn } from "@/auth/session";
import Console from "@/app/console";

export const dynamic = "force-dynamic";

/**
 * The authorization boundary for the console.
 *
 * Middleware only checks that a cookie exists; this runs the actual HMAC
 * verification before any page data is rendered.
 */
export default async function Page() {
  if (!(await isSignedIn())) redirect("/login");
  return <Console />;
}
