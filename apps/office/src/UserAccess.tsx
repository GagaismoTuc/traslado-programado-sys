import { useState } from "react";
import { readError, send } from "./api";

export type DeviceSession = { id: number; device_label: string; created_at: string; last_used_at: string; current: boolean };

export function DeviceSessionList({ sessions, onRevoke }: { sessions: DeviceSession[]; onRevoke: (session: DeviceSession) => void }) {
  if (!sessions.length) return <p>No active devices.</p>;
  return <ul>{sessions.map((session) => <li key={session.id}>
    {session.device_label}{session.current ? " (this device)" : ""} - signed in {new Date(session.created_at).toLocaleString()}, last used {new Date(session.last_used_at).toLocaleString()}
    <button type="button" onClick={() => onRevoke(session)}>Revoke</button>
  </li>)}</ul>;
}

export function DeviceSessions({ userId, initialSessions = null }: { userId: number; initialSessions?: DeviceSession[] | null }) {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(initialSessions);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await send(`/users/${userId}/sessions`, "GET");
    if (response.ok) setSessions((await response.json() as { sessions: DeviceSession[] }).sessions);
    else setMessage(await readError(response, "Unable to load devices"));
  }

  async function revoke(session: DeviceSession) {
    const response = await send(`/users/${userId}/sessions/${session.id}`, "DELETE");
    setMessage(response.ok ? `Revoked ${session.device_label}` : await readError(response, "Unable to revoke the device"));
    if (response.ok) await load();
  }

  return <section>
    <button type="button" onClick={() => void load()}>{sessions ? "Refresh devices" : "Show devices"}</button>
    {message && <p role="status">{message}</p>}
    {sessions && <DeviceSessionList sessions={sessions} onRevoke={(session) => void revoke(session)} />}
  </section>;
}

export function PersistentSessionToggle({ userId, persistent }: { userId: number; persistent: boolean }) {
  const [checked, setChecked] = useState(persistent);
  const [message, setMessage] = useState("");

  async function change(next: boolean) {
    const response = await send(`/users/${userId}/persistent-session`, "PATCH", { persistent: next });
    if (response.ok) setChecked(next);
    setMessage(response.ok ? "" : await readError(response, "Unable to change the setting"));
  }

  return <label>
    <input type="checkbox" checked={checked} onChange={(event) => void change(event.currentTarget.checked)} /> Persistent session on its devices
    {message && <span role="alert"> {message}</span>}
  </label>;
}
