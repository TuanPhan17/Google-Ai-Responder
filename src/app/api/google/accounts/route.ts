import { syncAccounts } from "@/reviews/sync.service";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

export async function GET() {
  return withAdmin("google.accounts", async () => ({ accounts: await syncAccounts() }));
}
