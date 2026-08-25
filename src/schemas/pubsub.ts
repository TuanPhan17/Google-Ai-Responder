import { z } from "zod";

/**
 * Wire shapes for a Cloud Pub/Sub push subscription HTTP request, and for the
 * Business Profile notification it carries.
 *
 * The outer envelope (`message.data`/`messageId`/`publishTime`/`subscription`)
 * is Pub/Sub's own format and is stable, documented infrastructure — validated
 * strictly. The inner notification body is Google Business Profile's, and its
 * exact JSON field names are, at the time this was written, not fully nailed
 * down in Google's public reference docs (the NotificationSetting reference
 * names `location_name`/`review_name` in prose but never shows the message's
 * own JSON schema). `.passthrough()` plus mostly-optional fields reflects that
 * honestly — this schema validates what we're confident about (the envelope,
 * `notificationType`) and tolerates the rest, per CLAUDE.md's Zod rule ("a
 * strict schema turns [an added field] into an outage") and per
 * docs/SPEC.md's own instruction to treat notifications as a trigger, not as
 * the authoritative data.
 */

export const pubSubMessageSchema = z
  .object({
    data: z.string().min(1),
    messageId: z.string().min(1),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  })
  .passthrough();

export const pubSubPushEnvelopeSchema = z
  .object({
    message: pubSubMessageSchema,
    subscription: z.string().optional(),
  })
  .passthrough();

export type PubSubPushEnvelope = z.infer<typeof pubSubPushEnvelopeSchema>;

/** The notification types this app acts on. Everything else (media, Q&A, Voice of Merchant, ...) is acknowledged and ignored. */
export const REVIEW_NOTIFICATION_TYPES = ["NEW_REVIEW", "UPDATED_REVIEW"] as const;

export const googleNotificationSchema = z
  .object({
    notificationType: z.string().optional(),
  })
  .passthrough();

export type GoogleNotification = z.infer<typeof googleNotificationSchema>;
