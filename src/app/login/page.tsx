"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (response.ok) {
      router.replace("/");
      router.refresh();
      return;
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    setError(payload?.error ?? "Sign-in failed.");
    setBusy(false);
  }

  return (
    <main className="signin">
      <form onSubmit={submit}>
        <span className="eyebrow">Review console</span>
        <h1>Sign in</h1>
        <p>Use the console password from your environment configuration.</p>

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Console password"
          autoComplete="current-password"
          autoFocus
          required
        />

        <button type="submit" data-tone="primary" disabled={busy || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {error ? (
          <div className="notice" data-tone="error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </main>
  );
}
