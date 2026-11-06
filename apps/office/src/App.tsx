import { useEffect, useState, type FormEvent } from "react";
import { hc } from "hono/client";
import type { AppType } from "@traslado/api";
import { apiUrl, readError, redirectUnauthorized, send } from "./api";
import { AlertsPage } from "./AlertsPage";
import { TransferHistoryPage } from "./TransferHistoryPage";
import { DestinationsPage } from "./DestinationsPage";
import { DriversPage } from "./DriversPage";
import { ExpiriesPage } from "./Expiries";
import { LiveMapPage } from "./LiveMapPage";
import { OfficeNav } from "./OfficeNav";
import { PassengersPage } from "./PassengersPage";
import { PlanPage } from "./PlanPage";
import { SecondFactorPage } from "./SecondFactor";
import { DeviceSessions, PersistentSessionToggle } from "./UserAccess";
import { VehicleDetailPage } from "./VehicleDetailPage";
import { VehicleFeaturesPage } from "./VehicleFeaturesPage";
import { VehiclesPage } from "./VehiclesPage";

const api = hc<AppType>(apiUrl);
void api.health.$get;

type User = { id: number; username: string; role: "office" | "driver"; disabled_at: string | null; persistent_session: boolean };

function SignInPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const values = new FormData(event.currentTarget);
    try {
      const response = await send("/auth/login", "POST", {
        username: values.get("username"),
        password: values.get("password"),
        deviceLabel: values.get("deviceLabel"),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setError(result.error ?? "Sign-in failed");
      } else {
        const result = await response.json() as { secondFactor?: string };
        window.location.assign(result.secondFactor ? "/second-factor" : "/live");
      }
    } catch {
      setError("Unable to reach the server");
    } finally {
      setLoading(false);
    }
  }

  return <main>
    <h1>Office sign-in</h1>
    <form onSubmit={submit}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <label>Device name<input name="deviceLabel" defaultValue="Office browser" maxLength={100} required /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
    </form>
  </main>;
}

function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [message, setMessage] = useState("");

  async function loadUsers() {
    const response = await send("/users", "GET");
    if (await redirectUnauthorized(response)) return;
    if (!response.ok) {
      setMessage("Unable to load users");
      return;
    }
    setUsers((await response.json() as { users: User[] }).users);
  }

  useEffect(() => { void loadUsers(); }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const response = await send("/users", "POST", {
      username: values.get("username"),
      password: values.get("password"),
      role: values.get("role"),
    });
    setMessage(response.ok ? "User created" : "Unable to create user");
    if (response.ok) {
      form.reset();
      await loadUsers();
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const response = await send(`/users/${id}/password`, "PATCH", { password: values.get("password") });
    setMessage(response.ok ? "Password reset" : "Unable to reset password");
    if (response.ok) form.reset();
  }

  async function disableUser(id: number) {
    const response = await send(`/users/${id}/disable`, "PATCH", {});
    setMessage(response.ok ? "User disabled" : await readError(response, "Unable to disable user"));
    if (response.ok) await loadUsers();
  }

  async function logout() {
    await send("/auth/logout", "POST", {});
    window.location.assign("/");
  }

  return <main>
    <h1>Users</h1>
    <button type="button" onClick={() => void logout()}>Sign out</button>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form onSubmit={createUser}>
      <h2>Create user</h2>
      <label>Username<input name="username" autoComplete="off" required /></label>
      <label>Temporary password<input name="password" type="password" autoComplete="new-password" required /></label>
      <label>Role<select name="role"><option value="office">Office</option><option value="driver">Driver</option></select></label>
      <button type="submit">Create user</button>
    </form>
    <h2>Current users</h2>
    <ul>{users.map((user) => <li key={user.id}>
      <strong>{user.username}</strong> - {user.role === "office" ? "Office" : "Driver"} {user.disabled_at ? "(disabled)" : ""}
      {!user.disabled_at && <>
        <form onSubmit={(event) => void resetPassword(event, user.id)}>
          <label>New password<input name="password" type="password" autoComplete="new-password" required /></label>
          <button type="submit">Reset password</button>
        </form>
        <button type="button" onClick={() => void disableUser(user.id)}>Disable user</button>
        {user.role === "office" && <PersistentSessionToggle userId={user.id} persistent={user.persistent_session} />}
        <DeviceSessions userId={user.id} driver={user.role === "driver"} />
      </>}
    </li>)}</ul>
  </main>;
}

export function App() {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  if (path === "/live" || path === "/map") return <LiveMapPage />;
  if (path === "/second-factor") return <SecondFactorPage />;
  if (path === "/destinations") return <DestinationsPage />;
  if (path === "/vehicle-features") return <VehicleFeaturesPage />;
  if (path === "/vehicles") return <VehiclesPage />;
  const vehicleId = /^\/vehicles\/(\d+)$/.exec(path)?.[1];
  if (vehicleId) return <VehicleDetailPage id={Number(vehicleId)} />;
  if (path === "/expiries") return <ExpiriesPage />;
  if (path === "/drivers") return <DriversPage />;
  if (path === "/passengers") return <PassengersPage />;
  if (path === "/plan") return <PlanPage />;
  if (path === "/alerts") return <AlertsPage />;
  const transferId = /^\/transfers\/(\d+)\/history$/.exec(path)?.[1];
  if (transferId) return <TransferHistoryPage id={Number(transferId)} />;
  return path === "/users" ? <UsersPage /> : <SignInPage />;
}
