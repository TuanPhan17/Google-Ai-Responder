import { getBusinessSettings, listLocationRows } from "@/database/repositories/settings.repository";
import { withAdmin } from "@/app/api/_lib/handler";

export const dynamic = "force-dynamic";

/**
 * One row per synced location, each paired with its `business_settings` row
 * (`null` when nobody has configured that location yet — the dashboard
 * renders that as an empty form, not an error).
 */
export async function GET() {
  return withAdmin("settings.list", async () => {
    const locations = await listLocationRows();
    const entries = await Promise.all(
      locations.map(async (location) => ({
        location,
        settings: await getBusinessSettings(location.id),
      })),
    );
    return { entries };
  });
}
