import {
  BUSINESS_INFORMATION_BASE,
  GOOGLE_MAX_PAGE_SIZE,
  LOCATION_READ_MASK,
} from "@/config/google-api";
import { googleRequest, paginate } from "@/google/client";
import { extractLocationId, listLocationsResponseSchema } from "@/schemas/google";
import type { LocationSummary } from "@/types/review";

/**
 * Business Information API — mybusinessbusinessinformation.googleapis.com/v1
 *
 * Note the shape change from the old v4 API: location resource names are now
 * `locations/{locationId}`, not `accounts/{a}/locations/{l}`. The Reviews API
 * still wants the two-segment form, so callers have to recombine the location
 * ID with an account ID. That mismatch is a legacy of the split, not a mistake.
 */
export async function listLocations(accountResourceName: string): Promise<LocationSummary[]> {
  const locations = await paginate(
    (pageToken) =>
      googleRequest(
        {
          url: `${BUSINESS_INFORMATION_BASE}/${accountResourceName}/locations`,
          // readMask is REQUIRED here. Omitting it returns 400, not a default set.
          searchParams: { readMask: LOCATION_READ_MASK, pageSize: GOOGLE_MAX_PAGE_SIZE, pageToken },
          label: "locations.list",
        },
        listLocationsResponseSchema,
      ),
    (page) => page.locations ?? [],
    (page) => page.nextPageToken,
  );

  return locations.map((location) => {
    const address = location.storefrontAddress;
    const addressLine = address
      ? [...(address.addressLines ?? []), address.locality, address.administrativeArea, address.postalCode]
          .filter((part): part is string => Boolean(part))
          .join(", ")
      : null;

    return {
      name: location.name,
      locationId: extractLocationId(location.name),
      title: location.title ?? null,
      storeCode: location.storeCode ?? null,
      websiteUri: location.websiteUri ?? null,
      mapsUri: location.metadata?.mapsUri ?? null,
      placeId: location.metadata?.placeId ?? null,
      address: addressLine || null,
    };
  });
}
