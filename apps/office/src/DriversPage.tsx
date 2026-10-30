import { useEffect, useRef, useState, type FormEvent } from "react";
import { send, suggestAddressPin } from "./api";
import { OfficeNav } from "./OfficeNav";
import { PinPicker, type LatLng } from "./PinPicker";
import type { VehicleItem } from "./VehiclesPage";

type UserOption = { id: number; username: string; role: "office" | "driver"; disabled_at: string | null };

type DriverItem = {
  id: number;
  userId: number;
  username: string;
  name: string;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  usualVehicleId: number | null;
  usualVehiclePlate: string | null;
};

export function DriversPage() {
  const [drivers, setDrivers] = useState<DriverItem[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [vehicles, setVehicles] = useState<VehicleItem[]>([]);
  const [editing, setEditing] = useState<DriverItem | null>(null);
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [homeAddress, setHomeAddress] = useState("");
  const [usualVehicleId, setUsualVehicleId] = useState("");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [suggestion, setSuggestion] = useState<LatLng | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [geocodeMessage, setGeocodeMessage] = useState("");
  const [message, setMessage] = useState("");

  async function loadData() {
    const [driversRes, usersRes, vehiclesRes] = await Promise.all([
      send("/drivers", "GET"),
      send("/users", "GET"),
      send("/vehicles", "GET"),
    ]);
    if (driversRes.status === 401 || usersRes.status === 401 || vehiclesRes.status === 401) {
      window.location.assign("/");
      return;
    }
    if (!driversRes.ok || !usersRes.ok || !vehiclesRes.ok) {
      setMessage("Unable to load drivers");
      return;
    }
    setDrivers((await driversRes.json() as { drivers: DriverItem[] }).drivers);
    setUsers((await usersRes.json() as { users: UserOption[] }).users);
    setVehicles((await vehiclesRes.json() as { vehicles: VehicleItem[] }).vehicles);
  }

  useEffect(() => { void loadData(); }, []);

  const linkedUserIds = new Set(drivers.map((driver) => driver.userId));
  const availableDriverUsers = users.filter(
    (user) => user.role === "driver" && !user.disabled_at && !linkedUserIds.has(user.id),
  );
  const activeVehicles = vehicles.filter((vehicle) => !vehicle.deactivatedAt);

  function resetForm() {
    setEditing(null);
    setUserId("");
    setName("");
    setHomeAddress("");
    setUsualVehicleId("");
    setPin(null);
    setSuggestion(null);
    setGeocodeMessage("");
  }

  function startEdit(driver: DriverItem) {
    setEditing(driver);
    setUserId(String(driver.userId));
    setName(driver.name);
    setHomeAddress(driver.homeAddress);
    setUsualVehicleId(driver.usualVehicleId === null ? "" : String(driver.usualVehicleId));
    setPin({ lat: driver.homeLat, lng: driver.homeLng });
    setSuggestion(null);
    setGeocodeMessage("");
  }

  function choosePin(value: LatLng) {
    setPin(value);
    setSuggestion(null);
  }

  async function suggestPin() {
    if (!homeAddress.trim()) {
      setGeocodeMessage("Write the address first.");
      return;
    }
    setSuggesting(true);
    setGeocodeMessage("");
    const result = await suggestAddressPin(homeAddress);
    if (result.ok) {
      setPin(null);
      setSuggestion(result.point);
    }
    setGeocodeMessage(result.message);
    setSuggesting(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pin || savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    try {
      const vehicleIdValue = usualVehicleId ? Number(usualVehicleId) : null;
      const response = editing === null
        ? await send("/drivers", "POST", {
          userId: Number(userId),
          name,
          homeAddress,
          homeLat: pin.lat,
          homeLng: pin.lng,
          usualVehicleId: vehicleIdValue,
        })
        : await send(`/drivers/${editing.id}`, "PATCH", {
          name,
          homeAddress,
          homeLat: pin.lat,
          homeLng: pin.lng,
          usualVehicleId: vehicleIdValue,
        });
      if (response.ok) {
        setMessage(editing === null ? "Driver saved" : "Driver updated");
        resetForm();
        await loadData();
      } else {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setMessage(result.error ?? "Unable to save driver");
      }
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  return <main>
    <h1>Drivers</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form onSubmit={(event) => void save(event)}>
      <h2>{editing === null ? "New driver" : `Edit driver (${editing.username})`}</h2>
      {editing === null && <label>
        Driver user
        <select name="userId" required value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Select a driver account</option>
          {availableDriverUsers.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
        </select>
      </label>}
      <label>Name<input name="name" maxLength={200} required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Home address<input name="homeAddress" maxLength={500} required value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} /></label>
      <button type="button" onClick={() => void suggestPin()} disabled={suggesting}>{suggesting ? "Searching..." : "Suggest pin"}</button>
      {geocodeMessage && <p role="alert">{geocodeMessage}</p>}
      <PinPicker value={pin} onChange={choosePin} suggestion={suggestion} />
      <label>
        Usual vehicle
        <select name="usualVehicleId" value={usualVehicleId} onChange={(e) => setUsualVehicleId(e.target.value)}>
          <option value="">None</option>
          {activeVehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.plate} - {vehicle.model}</option>)}
        </select>
      </label>
      <button type="submit" disabled={!pin || saving}>{saving ? "Saving..." : editing === null ? "Save driver" : "Update driver"}</button>
      {editing !== null && <button type="button" onClick={resetForm}>Cancel</button>}
    </form>
    <h2>Drivers</h2>
    <ul>{drivers.map((driver) => <li key={driver.id}>
      <strong>{driver.name}</strong> (@{driver.username}) - {driver.homeAddress}
      {" - "}
      {driver.usualVehiclePlate ? `Usual vehicle: ${driver.usualVehiclePlate}` : "No usual vehicle"}
      {" "}
      <button type="button" onClick={() => startEdit(driver)}>Edit</button>
    </li>)}</ul>
  </main>;
}

