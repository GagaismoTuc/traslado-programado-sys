import { useEffect, useRef, useState, type FormEvent } from "react";
import { redirectUnauthorized, send, suggestAddressPin } from "./api";
import { OfficeNav } from "./OfficeNav";
import { PinPicker, type LatLng } from "./PinPicker";

type Destination = {
  id: number;
  name: string;
  kind: string;
  address: string;
  accessNotes: string | null;
  lat: number;
  lng: number;
  arrivalToleranceMinutes: number;
};

const KINDS = [
  ["school", "School"],
  ["clinic", "Clinic"],
  ["therapy", "Therapy centre"],
  ["day_centre", "Day centre"],
  ["other", "Other"],
] as const;
const kindLabel = new Map<string, string>(KINDS);

export function DestinationsPage() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [suggestion, setSuggestion] = useState<LatLng | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [geocodeMessage, setGeocodeMessage] = useState("");
  const [message, setMessage] = useState("");
  const form = useRef<HTMLFormElement>(null);

  async function loadDestinations() {
    const response = await send("/destinations", "GET");
    if (await redirectUnauthorized(response)) return;
    if (!response.ok) {
      setMessage("Unable to load destinations");
      return;
    }
    setDestinations((await response.json() as { destinations: Destination[] }).destinations);
  }

  useEffect(() => { void loadDestinations(); }, []);

  function choosePin(value: LatLng) {
    setPin(value);
    setSuggestion(null);
  }

  async function suggestPin() {
    const query = String(new FormData(form.current!).get("address") ?? "");
    setSuggesting(true);
    setGeocodeMessage("");
    const result = await suggestAddressPin(query);
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
    const target = event.currentTarget;
    const values = new FormData(target);
    try {
      const response = await send("/destinations", "POST", {
        name: values.get("name"),
        kind: values.get("kind"),
        address: values.get("address"),
        accessNotes: values.get("accessNotes"),
        // Left empty, the API takes it from the kind: 30 minutes for schools and day centres, 0 otherwise.
        arrivalToleranceMinutes: values.get("arrivalToleranceMinutes") ? Number(values.get("arrivalToleranceMinutes")) : null,
        lat: pin.lat,
        lng: pin.lng,
      });
      setMessage(response.ok ? "Destination saved" : "Unable to save the destination");
      if (response.ok) {
        target.reset();
        setPin(null);
        setSuggestion(null);
        setGeocodeMessage("");
        await loadDestinations();
      }
    } catch {
      setMessage("Unable to reach the server");
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }

  async function saveTolerance(event: FormEvent<HTMLFormElement>, destination: Destination) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("arrivalToleranceMinutes");
    try {
      const response = await send(`/destinations/${destination.id}`, "PATCH", { arrivalToleranceMinutes: Number(value) });
      if (await redirectUnauthorized(response)) return;
      setMessage(response.ok ? `Arrival tolerance of ${destination.name} saved` : "Unable to save the arrival tolerance");
      if (response.ok) await loadDestinations();
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  return <main>
    <h1>Destinations</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    <form ref={form} onSubmit={(event) => void save(event)}>
      <h2>New destination</h2>
      <label>Name<input name="name" maxLength={200} required /></label>
      <label>Kind<select name="kind">{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Address<input name="address" maxLength={500} required /></label>
      <label>Access notes<textarea name="accessNotes" maxLength={1000} /></label>
      <label>
        Arrival tolerance in minutes (empty: 30 for schools and day centres, 0 otherwise)
        <input type="number" name="arrivalToleranceMinutes" min={0} max={240} step={1} />
      </label>
      <button type="button" onClick={() => void suggestPin()} disabled={suggesting}>{suggesting ? "Searching..." : "Suggest pin"}</button>
      {geocodeMessage && <p role="alert">{geocodeMessage}</p>}
      <PinPicker value={pin} onChange={choosePin} suggestion={suggestion} />
      <button type="submit" disabled={!pin || saving}>{saving ? "Saving..." : "Save destination"}</button>
    </form>
    <h2>Destinations</h2>
    <ul>{destinations.map((destination) => <li key={destination.id}>
      <strong>{destination.name}</strong> - {kindLabel.get(destination.kind) ?? destination.kind} - {destination.address}
      <form key={destination.arrivalToleranceMinutes} onSubmit={(event) => void saveTolerance(event, destination)}>
        <label>
          Arrival tolerance of {destination.name} (minutes)
          <input type="number" name="arrivalToleranceMinutes" min={0} max={240} step={1} required defaultValue={destination.arrivalToleranceMinutes} />
        </label>
        <button type="submit">Save tolerance</button>
      </form>
    </li>)}</ul>
  </main>;
}
