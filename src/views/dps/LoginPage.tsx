import { type FormEvent, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/dps/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Login failed");
      window.location.assign("/lab");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1>rift-delta DPS lab</h1>
        <p>
          Private test prototype. Enter the access password to inspect the patch-pinned simulator.
        </p>
        <label>
          <span>ACCESS PASSWORD</span>
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="run" type="submit" disabled={loading || !password}>
          {loading ? "CHECKING…" : "ENTER PROTOTYPE"}
        </button>
        <small>
          Private tester access. Riot credentials and raw match archives stay server-side.
        </small>
      </form>
    </main>
  );
}
