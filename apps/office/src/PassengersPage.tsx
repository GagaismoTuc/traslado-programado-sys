import { useEffect, useRef, useState, type FormEvent } from "react";
import { readError, send, suggestAddressPin } from "./api";
import { OfficeNav } from "./OfficeNav";
import { PinPicker, type LatLng } from "./PinPicker";
import type { VehicleFeature } from "./VehicleFeaturesPage";

type PassengerItem = {
  id: number;
  name: string;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  accessNotes: string | null;
  companions: number;
  frontSeat: boolean;
  wheelchair: boolean;
  featureIds: number[];
  features: string[];
  maxRideTimeMinutes: number;
  pickupDurationMinutes: number;
  dropoffDurationMinutes: number;
  medicalAlert: string | null;
  deactivatedAt: string | null;
};

// Proposed by the form only; the Oficina confirms or changes them for each Pasajero.
const DEFAULT_MAX_RIDE_MINUTES = "60";
const DEFAULT_BOARDING_MINUTES = "5";

export function PassengersPage() {
  const [passengers, setPassengers] = useState<PassengerItem[]>([]);
  const [features, setFeatures] = useState<VehicleFeature[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [homeAddress, setHomeAddress] = useState("");
  const [accessNotes, setAccessNotes] = useState("");
  const [companions, setCompanions] = useState("0");
  const [frontSeat, setFrontSeat] = useState(false);
  const [wheelchair, setWheelchair] = useState(false);
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<number[]>([]);
  const [maxRide, setMaxRide] = useState(DEFAULT_MAX_RIDE_MINUTES);
  const [pickup, setPickup] = useState(DEFAULT_BOARDING_MINUTES);
  const [dropoff, setDropoff] = useState(DEFAULT_BOARDING_MINUTES);
  const [medicalAlert, setMedicalAlert] = useState("");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [suggestion, setSuggestion] = useState<LatLng | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [geocodeMessage, setGeocodeMessage] = useState("");
  const [message, setMessage] = useState("");

  async function loadData() {
    const [passengersRes, featuresRes] = await Promise.all([
      send("/passengers", "GET"),
      send("/vehicle-features", "GET"),
    ]);
    if (passengersRes.status === 401 || featuresRes.status === 401) {
      window.location.assign("/");
      return;
    }
    if (!passengersRes.ok || !featuresRes.ok) {
      setMessage("Unable to load passengers");
      return;
    }
    setPassengers((await passengersRes.json() as { passengers: PassengerItem[] }).passengers);
    setFeatures((await featuresRes.json() as { features: VehicleFeature[] }).features);
  }

  useEffect(() => { void loadData(); }, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setHomeAddress("");
    setAccessNotes("");
    setCompanions("0");
    setFrontSeat(false);
    setWheelchair(false);
    setSelectedFeatureIds([]);
    setMaxRide(DEFAULT_MAX_RIDE_MINUTES);
    setPickup(DEFAULT_BOARDING_MINUTES);
    setDropoff(DEFAULT_BOARDING_MINUTES);
    setMedicalAlert("");
    setPin(null);
    setSuggestion(null);
    setGeocodeMessage("");
  }

  function startEdit(passenger: PassengerItem) {
    setEditingId(passenger.id);
    setName(passenger.name);
    setHomeAddress(passenger.homeAddress);
    setAccessNotes(passenger.accessNotes ?? "");
    setCompanions(String(passenger.companions));
    setFrontSeat(passenger.frontSeat);
    setWheelchair(passenger.wheelchair);
    setSelectedFeatureIds(passenger.featureIds);
    setMaxRide(String(passenger.maxRideTimeMinutes));
    setPickup(String(passenger.pickupDurationMinutes));
    setDropoff(String(passenger.dropoffDurationMinutes));
    setMedicalAlert(passenger.medicalAlert ?? "");
    setPin({ lat: passenger.homeLat, lng: passenger.homeLng });
    setSuggestion(null);
    setGeocodeMessage("");
  }

  function toggleFeature(id: number) {
    setSelectedFeatureIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  function choosePin(value: LatLng) {
    setPin(value);
    setSuggestion(null);
  }

  async function suggestPin() {
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
      const payload = {
        name,
        homeAddress,
        homeLat: pin.lat,
        homeLng: pin.lng,
        accessNotes,
        companions: Number(companions),
        frontSeat,
        wheelchair,
        featureIds: selectedFeatureIds,
        maxRideTimeMinutes: Number(maxRide),
        pickupDurationMinutes: Number(pickup),
        dropoffDurationMinutes: Number(dropoff),
        medicalAlert,
      };
      const response = editingId === null
        ? await send("/passengers", "POST", payload)
        : await send(`/passengers/${editingId}`, "PATCH", payload);
      if (response.ok) {
        setMessage(editingId === null ? "Passenger saved" : "Passenger updated");
        resetForm();
        await loadData();
      } else {
        setMessage(await readError(response, "Unable to save passenger"));
      }
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  async function setActive(id: number, active: boolean) {
    try {
      const response = await send(`/passengers/${id}/${active ? "reactivate" : "deactivate"}`, "PATCH", {});
      if (response.ok) {
        setMessage(active ? "Passenger reactivated" : "Passenger deactivated");
        if (editingId === id) resetForm();
        await loadData();
      } else {
        setMessage(await readError(response, active ? "Unable to reactivate passenger" : "Unable to deactivate passenger"));
      }
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  return <main>
    <h1>Passengers</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form onSubmit={(event) => void save(event)}>
      <h2>{editingId === null ? "New passenger" : "Edit passenger"}</h2>
      <label>Name<input name="name" maxLength={200} required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Home address<input name="homeAddress" maxLength={500} required value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} /></label>
      <button type="button" onClick={() => void suggestPin()} disabled={suggesting}>{suggesting ? "Searching..." : "Suggest pin"}</button>
      {geocodeMessage && <p role="alert">{geocodeMessage}</p>}
      <PinPicker value={pin} onChange={choosePin} suggestion={suggestion} />
      <label>Access notes<textarea name="accessNotes" maxLength={1000} value={accessNotes} onChange={(e) => setAccessNotes(e.target.value)} /></label>
      <label>
        Companions by default
        <select name="companions" value={companions} onChange={(e) => setCompanions(e.target.value)}>
          <option value="0">0</option>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
      </label>
      <label><input type="checkbox" name="frontSeat" checked={frontSeat} onChange={(e) => setFrontSeat(e.target.checked)} />Must travel in the front seat</label>
      <label><input type="checkbox" name="wheelchair" checked={wheelchair} onChange={(e) => setWheelchair(e.target.checked)} />Uses a wheelchair</label>
      <fieldset>
        <legend>Required vehicle features</legend>
        {features.map((feature) => <label key={feature.id}>
          <input
            type="checkbox"
            checked={selectedFeatureIds.includes(feature.id)}
            onChange={() => toggleFeature(feature.id)}
          />
          {feature.name}
        </label>)}
      </fieldset>
      <label>Maximum ride time (minutes)<input name="maxRideTimeMinutes" type="number" min={1} step={1} required value={maxRide} onChange={(e) => setMaxRide(e.target.value)} /></label>
      <label>Boarding minutes<input name="pickupDurationMinutes" type="number" min={1} step={1} required value={pickup} onChange={(e) => setPickup(e.target.value)} /></label>
      <label>Alighting minutes<input name="dropoffDurationMinutes" type="number" min={1} step={1} required value={dropoff} onChange={(e) => setDropoff(e.target.value)} /></label>
      <label>Medical alert<input name="medicalAlert" maxLength={140} value={medicalAlert} onChange={(e) => setMedicalAlert(e.target.value)} /></label>
      <button type="submit" disabled={!pin || saving}>{saving ? "Saving..." : editingId === null ? "Save passenger" : "Update passenger"}</button>
      {editingId !== null && <button type="button" onClick={resetForm}>Cancel</button>}
    </form>
    <h2>Passengers</h2>
    <ul>{passengers.map((passenger) => <li key={passenger.id}>
      <strong>{passenger.name}</strong> - {passenger.homeAddress}
      {` - Companions: ${passenger.companions}`}
      {passenger.frontSeat ? " - Front seat" : ""}
      {passenger.wheelchair ? " - Wheelchair" : ""}
      {` - Max ride: ${passenger.maxRideTimeMinutes} min`}
      {passenger.medicalAlert ? ` - Alert: ${passenger.medicalAlert}` : ""}
      {passenger.deactivatedAt ? " (deactivated)" : ""}
      {" "}
      {passenger.deactivatedAt
        ? <button type="button" onClick={() => void setActive(passenger.id, true)}>Reactivate passenger</button>
        : <>
          <button type="button" onClick={() => startEdit(passenger)}>Edit</button>
          {" "}
          <button type="button" onClick={() => void setActive(passenger.id, false)}>Deactivate passenger</button>
        </>}
    </li>)}</ul>
  </main>;
}
