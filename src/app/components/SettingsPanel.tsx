"use client";

import { useEffect, useState } from "react";

import { call, type Notice } from "@/app/components/api-client";

interface LocationRow {
  id: string;
  google_location_id: string;
  title: string | null;
  address: string | null;
}

interface BusinessSettingsRow {
  business_name: string | null;
  business_description: string | null;
  brand_voice: string | null;
  preferred_tone: string | null;
  max_response_chars: number;
  contact_phone: string | null;
  contact_email: string | null;
  escalation_instructions: string | null;
  phrases_to_avoid: string[];
  approved_policies: string[];
  location_notes: string | null;
  auto_publish_five_star: boolean;
  auto_publish_four_star: boolean;
  min_auto_publish_rating: number;
}

interface Entry {
  location: LocationRow;
  settings: BusinessSettingsRow | null;
}

interface FormState {
  businessName: string;
  businessDescription: string;
  brandVoice: string;
  preferredTone: string;
  maxResponseChars: number;
  contactPhone: string;
  contactEmail: string;
  escalationInstructions: string;
  phrasesToAvoid: string;
  approvedPolicies: string;
  locationNotes: string;
  autoPublishFiveStar: boolean;
  autoPublishFourStar: boolean;
  minAutoPublishRating: number;
}

const EMPTY_FORM: FormState = {
  businessName: "",
  businessDescription: "",
  brandVoice: "",
  preferredTone: "",
  maxResponseChars: 600,
  contactPhone: "",
  contactEmail: "",
  escalationInstructions: "",
  phrasesToAvoid: "",
  approvedPolicies: "",
  locationNotes: "",
  autoPublishFiveStar: false,
  autoPublishFourStar: false,
  minAutoPublishRating: 4,
};

function toForm(settings: BusinessSettingsRow | null): FormState {
  if (!settings) return EMPTY_FORM;
  return {
    businessName: settings.business_name ?? "",
    businessDescription: settings.business_description ?? "",
    brandVoice: settings.brand_voice ?? "",
    preferredTone: settings.preferred_tone ?? "",
    maxResponseChars: settings.max_response_chars,
    contactPhone: settings.contact_phone ?? "",
    contactEmail: settings.contact_email ?? "",
    escalationInstructions: settings.escalation_instructions ?? "",
    phrasesToAvoid: settings.phrases_to_avoid.join("\n"),
    approvedPolicies: settings.approved_policies.join("\n"),
    locationNotes: settings.location_notes ?? "",
    autoPublishFiveStar: settings.auto_publish_five_star,
    autoPublishFourStar: settings.auto_publish_four_star,
    minAutoPublishRating: settings.min_auto_publish_rating,
  };
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Business voice, contact info, and auto-publish configuration — per
 * docs/SPEC.md Phase 8's Settings section. Scoped to one location at a
 * time, since `business_settings` is keyed by `location_id`
 * (`business_settings_location_unique`): a multi-location business
 * configures each location's voice and thresholds independently.
 */
export function SettingsPanel({ notify }: { notify: (notice: Notice) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const data = await call<{ entries: Entry[] }>("/api/settings");
        setEntries(data.entries);
        const first = data.entries[0];
        if (first) {
          setSelectedId(first.location.id);
          setForm(toForm(first.settings));
        }
      } catch (error) {
        notify({ tone: "error", text: error instanceof Error ? error.message : "Could not load settings." });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectLocation(locationId: string) {
    setSelectedId(locationId);
    const entry = entries.find((item) => item.location.id === locationId);
    setForm(toForm(entry?.settings ?? null));
  }

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const data = await call<{ settings: BusinessSettingsRow }>(`/api/settings/${selectedId}`, {
        method: "PUT",
        body: JSON.stringify({
          businessName: form.businessName,
          businessDescription: form.businessDescription,
          brandVoice: form.brandVoice,
          preferredTone: form.preferredTone,
          maxResponseChars: form.maxResponseChars,
          contactPhone: form.contactPhone,
          contactEmail: form.contactEmail,
          escalationInstructions: form.escalationInstructions,
          phrasesToAvoid: splitLines(form.phrasesToAvoid),
          approvedPolicies: splitLines(form.approvedPolicies),
          locationNotes: form.locationNotes,
          autoPublishFiveStar: form.autoPublishFiveStar,
          autoPublishFourStar: form.autoPublishFourStar,
          minAutoPublishRating: form.minAutoPublishRating,
        }),
      });
      setEntries((prev) =>
        prev.map((entry) => (entry.location.id === selectedId ? { ...entry, settings: data.settings } : entry)),
      );
      notify({ tone: "ok", text: "Settings saved." });
    } catch (error) {
      notify({ tone: "error", text: error instanceof Error ? error.message : "Could not save settings." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="panel">
        <h2>Settings</h2>
        <p className="hint">Loading…</p>
      </section>
    );
  }

  if (entries.length === 0) {
    return (
      <section className="panel">
        <h2>Settings</h2>
        <p className="empty-state">
          No locations synced yet. Load accounts and locations from the Connection tab first.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Settings</h2>
      <p className="hint">
        Only what's configured here is ever shown to the AI as verified fact — see CLAUDE.md's "never invent
        business facts" rule. Auto-publish toggles below can only make publishing stricter than the
        mandatory rules already enforce, never looser.
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <select value={selectedId} onChange={(event) => selectLocation(event.target.value)} aria-label="Location">
          {entries.map((entry) => (
            <option key={entry.location.id} value={entry.location.id}>
              {entry.location.title ?? entry.location.google_location_id}
              {entry.location.address ? ` — ${entry.location.address}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="form-grid">
        <label>
          Business name
          <input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
        </label>
        <label>
          Preferred tone
          <input value={form.preferredTone} onChange={(e) => setForm({ ...form, preferredTone: e.target.value })} />
        </label>
        <label className="span-2">
          Business description
          <textarea
            rows={2}
            value={form.businessDescription}
            onChange={(e) => setForm({ ...form, businessDescription: e.target.value })}
          />
        </label>
        <label className="span-2">
          Brand voice
          <textarea rows={2} value={form.brandVoice} onChange={(e) => setForm({ ...form, brandVoice: e.target.value })} />
        </label>
        <label>
          Contact phone
          <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
        </label>
        <label>
          Contact email
          <input
            type="email"
            value={form.contactEmail}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
          />
        </label>
        <label className="span-2">
          Complaint escalation instructions
          <textarea
            rows={2}
            value={form.escalationInstructions}
            onChange={(e) => setForm({ ...form, escalationInstructions: e.target.value })}
          />
        </label>
        <label className="span-2">
          Location-specific information
          <textarea rows={2} value={form.locationNotes} onChange={(e) => setForm({ ...form, locationNotes: e.target.value })} />
        </label>
        <label className="span-2">
          Phrases to avoid <span className="hint">(one per line)</span>
          <textarea rows={3} value={form.phrasesToAvoid} onChange={(e) => setForm({ ...form, phrasesToAvoid: e.target.value })} />
        </label>
        <label className="span-2">
          Approved business policies <span className="hint">(one per line — e.g. refund policy wording)</span>
          <textarea
            rows={3}
            value={form.approvedPolicies}
            onChange={(e) => setForm({ ...form, approvedPolicies: e.target.value })}
          />
        </label>
        <label>
          Max response length (characters)
          <input
            type="number"
            min={120}
            max={2000}
            value={form.maxResponseChars}
            onChange={(e) => setForm({ ...form, maxResponseChars: Number(e.target.value) })}
          />
        </label>
        <label>
          Minimum rating that may auto-publish
          <select
            value={form.minAutoPublishRating}
            onChange={(e) => setForm({ ...form, minAutoPublishRating: Number(e.target.value) })}
          >
            <option value={4}>4 stars</option>
            <option value={5}>5 stars only</option>
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.autoPublishFourStar}
            onChange={(e) => setForm({ ...form, autoPublishFourStar: e.target.checked })}
          />
          Allow low-risk 4-star reviews to auto-publish
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.autoPublishFiveStar}
            onChange={(e) => setForm({ ...form, autoPublishFiveStar: e.target.checked })}
          />
          Allow low-risk 5-star reviews to auto-publish
        </label>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button data-tone="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}
