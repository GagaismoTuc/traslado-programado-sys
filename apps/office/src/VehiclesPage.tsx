import { useEffect, useRef, useState, type FormEvent } from "react";
import { send } from "./api";
import { OfficeNav } from "./OfficeNav";
import type { VehicleFeature } from "./VehicleFeaturesPage";

export type VehicleItem = {
  id: number;
  plate: string;
  model: string;
  seats: number;
  front: number;
  featureIds: number[];
  features: string[];
  deactivatedAt: string | null;
};

export function VehiclesPage() {
  const [vehicles, setVehicles] = useState<VehicleItem[]>([]);
  const [features, setFeatures] = useState<VehicleFeature[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [seats, setSeats] = useState("5");
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [message, setMessage] = useState("");

  async function loadData() {
    const [vehiclesRes, featuresRes] = await Promise.all([
      send("/vehicles", "GET"),
      send("/vehicle-features", "GET"),
    ]);
    if (vehiclesRes.status === 401 || featuresRes.status === 401) {
      window.location.assign("/");
      return;
    }
    if (!vehiclesRes.ok || !featuresRes.ok) {
      setMessage("Unable to load vehicles");
      return;
    }
    setVehicles((await vehiclesRes.json() as { vehicles: VehicleItem[] }).vehicles);
    setFeatures((await featuresRes.json() as { features: VehicleFeature[] }).features);
  }

  useEffect(() => { void loadData(); }, []);

  function resetForm() {
    setEditingId(null);
    setPlate("");
    setModel("");
    setSeats("5");
    setSelectedFeatureIds([]);
  }

  function startEdit(vehicle: VehicleItem) {
    setEditingId(vehicle.id);
    setPlate(vehicle.plate);
    setModel(vehicle.model);
    setSeats(String(vehicle.seats));
    setSelectedFeatureIds(vehicle.featureIds);
  }

  function toggleFeature(id: number) {
    setSelectedFeatureIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    try {
      const payload = {
        plate,
        model,
        seats: Number(seats),
        front: 1,
        featureIds: selectedFeatureIds,
      };
      const response = editingId === null
        ? await send("/vehicles", "POST", payload)
        : await send(`/vehicles/${editingId}`, "PATCH", payload);
      if (response.ok) {
        setMessage(editingId === null ? "Vehicle saved" : "Vehicle updated");
        resetForm();
        await loadData();
      } else {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setMessage(result.error ?? "Unable to save vehicle");
      }
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  async function deactivate(id: number) {
    try {
      const response = await send(`/vehicles/${id}/deactivate`, "PATCH", {});
      if (response.ok) {
        setMessage("Vehicle deactivated");
        if (editingId === id) resetForm();
        await loadData();
      } else {
        setMessage("Unable to deactivate vehicle");
      }
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  return <main>
    <h1>Vehicles</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form onSubmit={(event) => void save(event)}>
      <h2>{editingId === null ? "New vehicle" : "Edit vehicle"}</h2>
      <label>Plate<input name="plate" maxLength={32} required value={plate} onChange={(e) => setPlate(e.target.value)} /></label>
      <label>Model<input name="model" maxLength={200} required value={model} onChange={(e) => setModel(e.target.value)} /></label>
      <label>Seats<input name="seats" type="number" min={1} max={100} step={1} required value={seats} onChange={(e) => setSeats(e.target.value)} /></label>
      <input type="hidden" name="front" value="1" />
      <p>Front seat (Asiento delantero): 1 (included in total seats)</p>
      <fieldset>
        <legend>Vehicle features</legend>
        {features.map((feature) => <label key={feature.id}>
          <input
            type="checkbox"
            checked={selectedFeatureIds.includes(feature.id)}
            onChange={() => toggleFeature(feature.id)}
          />
          {feature.name}
        </label>)}
      </fieldset>
      <button type="submit" disabled={saving}>{saving ? "Saving..." : editingId === null ? "Save vehicle" : "Update vehicle"}</button>
      {editingId !== null && <button type="button" onClick={resetForm}>Cancel</button>}
    </form>
    <h2>Fleet</h2>
    <ul>{vehicles.map((vehicle) => <li key={vehicle.id}>
      <strong>{vehicle.plate}</strong> - {vehicle.model} - {vehicle.seats} seats (front: {vehicle.front})
      {vehicle.features.length > 0 ? ` - Features: ${vehicle.features.join(", ")}` : ""}
      {vehicle.deactivatedAt ? " (deactivated)" : ""}
      {!vehicle.deactivatedAt && <>
        {" "}
        <button type="button" onClick={() => startEdit(vehicle)}>Edit</button>
        {" "}
        <button type="button" onClick={() => void deactivate(vehicle.id)}>Deactivate vehicle</button>
      </>}
    </li>)}</ul>
  </main>;
}

