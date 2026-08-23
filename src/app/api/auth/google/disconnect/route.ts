import { getConnection, deleteConnection } from "@/database/repositories/connection.repository";
import { recordEvent } from "@/database/repositories/review.repository";
import { revokeToken } from "@/auth/google-oauth";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

/**
 * Disconnects Google.
 *
 * Revocation is attempted at Google first so the grant actually disappears
 * from the user's account, then the local row is deleted regardless of whether
 * that succeeded — a network failure at Google must not leave a credential
 * sitting in our database that the operator believes they removed.
 */
export async function POST() {
  return withAdmin("auth.disconnect", async () => {
    const connection = await getConnection();

    if (connection) {
      await revokeToken(connection.refreshToken);
      await deleteConnection();
      await recordEvent(null, "GOOGLE_DISCONNECTED", {}, "admin");
    }

    return { disconnected: true };
  });
}
