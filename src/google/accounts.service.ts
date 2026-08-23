import { ACCOUNT_MANAGEMENT_BASE, GOOGLE_MAX_PAGE_SIZE } from "@/config/google-api";
import { googleRequest, paginate } from "@/google/client";
import { extractAccountId, listAccountsResponseSchema } from "@/schemas/google";
import type { AccountSummary } from "@/types/review";

/**
 * Account Management API — mybusinessaccountmanagement.googleapis.com/v1
 *
 * This is one of the endpoints Google migrated off the old v4 host. An account
 * is the container that owns locations; a business owner typically has exactly
 * one, an agency has many.
 */
export async function listAccounts(): Promise<AccountSummary[]> {
  const accounts = await paginate(
    (pageToken) =>
      googleRequest(
        {
          url: `${ACCOUNT_MANAGEMENT_BASE}/accounts`,
          searchParams: { pageSize: GOOGLE_MAX_PAGE_SIZE, pageToken },
          label: "accounts.list",
        },
        listAccountsResponseSchema,
      ),
    (page) => page.accounts ?? [],
    (page) => page.nextPageToken,
  );

  return accounts.map((account) => ({
    name: account.name,
    accountId: extractAccountId(account.name),
    accountName: account.accountName ?? null,
    type: account.type ?? null,
    verificationState: account.verificationState ?? null,
  }));
}
