import { useEffect, useState, type FormEvent } from "react";
import { hc } from "hono/client";
import type { AppType } from "@traslado/api";
import { DriverHome } from "./Days";
import { indexedDbStore, isRevoked } from "./offline";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const api = hc<AppType>(apiUrl);
void api.health.$get;

// Set while a Chofer is signed in on this phone, so the app opens on the plan saved on the phone without signal.
const SIGNED_IN_KEY = "driver-signed-in";

function rememberedSignIn() {
  try {
    return globalThis.localStorage?.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}

export function App() {
  const [error, setError] = useState("");
  const [signedIn, setSignedInState] = useState(rememberedSignIn);
  const [loading, setLoading] = useState(false);

  function setSignedIn(value: boolean) {
    try {
      if (value) localStorage.setItem(SIGNED_IN_KEY, "1");
      else localStorage.removeItem(SIGNED_IN_KEY);
    } catch {
      // Without storage the app still works online.
    }
    setSignedInState(value);
  }

  // On open, a Chofer whose session is still valid goes straight to the Recorridos; without signal the phone's memory
  // decides. A 401 asks to sign in again, keeping the queue, unless the device was revoked: then the phone is wiped.
  useEffect(() => {
    fetch(`${apiUrl}/auth/me`, { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) {
          if (await isRevoked(response)) await indexedDbStore().clear().catch(() => undefined);
          setSignedIn(false);
          return;
        }
        const result = response.ok ? await response.json() as { user?: { role?: string } } : null;
        if (result?.user?.role === "driver") setSignedIn(true);
      })
      .catch(() => undefined);
  }, []);

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
    return <main>
      <h1>Driver</h1>
      <button type="button" onClick={() => void logout()}>Sign out</button>
      <DriverHome apiUrl={apiUrl} onSignedOut={() => setSignedIn(false)} />
    </main>;
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
