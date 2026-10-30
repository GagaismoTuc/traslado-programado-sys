import { useEffect, useRef, useState, type FormEvent } from "react";
import { send } from "./api";
import { OfficeNav } from "./OfficeNav";

export type VehicleFeature = { id: number; name: string };

export function VehicleFeaturesPage() {
  const [features, setFeatures] = useState<VehicleFeature[]>([]);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [message, setMessage] = useState("");

  async function loadFeatures() {
    const response = await send("/vehicle-features", "GET");
    if (response.status === 401) {
      window.location.assign("/");
      return;
    }
    if (!response.ok) {
      setMessage("Unable to load vehicle features");
      return;
    }
    setFeatures((await response.json() as { features: VehicleFeature[] }).features);
  }

  useEffect(() => { void loadFeatures(); }, []);

  async function createFeature(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      const response = await send("/vehicle-features", "POST", { name: values.get("name") });
      if (response.ok) {
        setMessage("Vehicle feature saved");
        form.reset();
        await loadFeatures();
      } else {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setMessage(result.error ?? "Unable to save vehicle feature");
      }
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  async function updateFeature(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      const response = await send(`/vehicle-features/${id}`, "PATCH", { name: values.get("name") });
      if (response.ok) {
        setMessage("Vehicle feature updated");
        await loadFeatures();
      } else {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setMessage(result.error ?? "Unable to update vehicle feature");
      }
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  return <main>
    <h1>Vehicle features</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form onSubmit={(event) => void createFeature(event)}>
      <h2>New vehicle feature</h2>
      <label>Name<input name="name" maxLength={200} required /></label>
      <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save feature"}</button>
    </form>
    <h2>Current vehicle features</h2>
    <ul>{features.map((feature) => <li key={feature.id}>
      <strong>{feature.name}</strong>
      <form onSubmit={(event) => void updateFeature(event, feature.id)}>
        <label>Rename<input name="name" defaultValue={feature.name} maxLength={200} required /></label>
        <button type="submit">Update feature</button>
      </form>
    </li>)}</ul>
  </main>;
}

