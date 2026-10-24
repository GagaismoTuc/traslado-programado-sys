import { useEffect, useRef, useState, type FormEvent } from "react";
import { send } from "./api";
import { PinPicker, type LatLng } from "./PinPicker";

type Destination = { id: number; name: string; kind: string; address: string; accessNotes: string | null; lat: number; lng: number };

const KINDS = [
  ["school", "School"],
  ["clinic", "Clinic"],
  ["therapy", "Therapy centre"],
  ["day_centre", "Day centre"],
  ["other", "Other"],
] as const;
const kindLabel = new Map<string, string>(KINDS);

const geocodeErrors: Record<number, string> = {
  404: "No match for this address. Place the pin on the map by hand.",
  429: "Too many address searches. Wait a second and try again, or place the pin on the map by hand.",
};

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
    if (response.status === 401) {
      window.location.assign("/");
      return;
    }
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
    const query = String(new FormData(form.current!).get("address") ?? "").trim();
    if (!query) {
      setGeocodeMessage("Write the address first.");
      return;
    }
    setSuggesting(true);
    setGeocodeMessage("");
    try {
      const response = await send("/geocode", "POST", { query });
      if (response.ok) {
        const result = await response.json() as LatLng & { displayName: string };
        setPin(null);
        setSuggestion({ lat: result.lat, lng: result.lng });
        setGeocodeMessage(`Suggested: ${result.displayName}. Confirm the pin or move it.`);
      } else {
        setGeocodeMessage(geocodeErrors[response.status] ?? "Address search is unavailable. Place the pin on the map by hand.");
      }
    } catch {
      setGeocodeMessage("Address search is unavailable. Place the pin on the map by hand.");
    } finally {
      setSuggesting(false);
    }
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

  return <main>
    <h1>Destinations</h1>
    <a href="/users">Users</a>
    {message && <p role="status">{message}</p>}
    <form ref={form} onSubmit={(event) => void save(event)}>
      <h2>New destination</h2>
      <label>Name<input name="name" maxLength={200} required /></label>
      <label>Kind<select name="kind">{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Address<input name="address" maxLength={500} required /></label>
      <label>Access notes<textarea name="accessNotes" maxLength={1000} /></label>
      <button type="button" onClick={() => void suggestPin()} disabled={suggesting}>{suggesting ? "Searching..." : "Suggest pin"}</button>
      {geocodeMessage && <p role="alert">{geocodeMessage}</p>}
      <PinPicker value={pin} onChange={choosePin} suggestion={suggestion} />
      <button type="submit" disabled={!pin || saving}>{saving ? "Saving..." : "Save destination"}</button>
    </form>
    <h2>Destinations</h2>
    <ul>{destinations.map((destination) => <li key={destination.id}>
      <strong>{destination.name}</strong> - {kindLabel.get(destination.kind) ?? destination.kind} - {destination.address}
    </li>)}</ul>
  </main>;
}
