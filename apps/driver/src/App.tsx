import { useState, type FormEvent } from "react";
import { hc } from "hono/client";
import type { AppType } from "@traslado/api";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const api = hc<AppType>(apiUrl);
void api.health.$get;

export function App() {
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const values = new FormData(event.currentTarget);
    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: values.get("username"),
          password: values.get("password"),
          deviceLabel: values.get("deviceLabel"),
        }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setError(result.error ?? "Sign-in failed");
      } else {
        setSignedIn(true);
      }
    } catch {
      setError("Unable to reach the server");
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include" });
    setSignedIn(false);
  }

  if (signedIn) {
    return <main><h1>Driver</h1><p>Signed in.</p><button type="button" onClick={() => void logout()}>Sign out</button></main>;
  }

  return <main>
    <h1>Driver sign-in</h1>
    <form onSubmit={submit}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <label>Device name<input name="deviceLabel" defaultValue="Driver browser" maxLength={100} required /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
    </form>
  </main>;
}
