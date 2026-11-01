import { useEffect, useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";

type AuthorizedAdult = { id: number; name: string; dni: string; relation: string; phone: string; legalGuardian: boolean };
type Consent = { signedByAdultId: number; signedByName: string; signedAt: string; otherAdultAllowed: boolean };

/** The Adultos autorizados and the Consentimiento of one Pasajero; without a Consentimiento the Pasajero cannot be assigned. */
export function AuthorizedAdultsPanel({ passenger, onClose }: { passenger: { id: number; name: string }; onClose: () => void }) {
  const [adults, setAdults] = useState<AuthorizedAdult[]>([]);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [dni, setDni] = useState("");
  const [relation, setRelation] = useState("");
  const [phone, setPhone] = useState("");
  const [legalGuardian, setLegalGuardian] = useState(false);
  const [signerId, setSignerId] = useState("");
  const [signedAt, setSignedAt] = useState("");
  const [otherAdultAllowed, setOtherAdultAllowed] = useState(false);
  const [message, setMessage] = useState("");

  async function loadData() {
    const [adultsRes, consentRes] = await Promise.all([
      send(`/passengers/${passenger.id}/authorized-adults`, "GET"),
      send(`/passengers/${passenger.id}/consent`, "GET"),
    ]);
    if (await redirectUnauthorized(adultsRes, consentRes)) return;
    if (!adultsRes.ok || !consentRes.ok) {
      setMessage("Unable to load authorized adults");
      return;
    }
    setAdults((await adultsRes.json() as { adults: AuthorizedAdult[] }).adults);
    const current = (await consentRes.json() as { consent: Consent | null }).consent;
    setConsent(current);
    setSignerId(current ? String(current.signedByAdultId) : "");
    setSignedAt(current?.signedAt ?? "");
    setOtherAdultAllowed(current?.otherAdultAllowed ?? false);
  }

  useEffect(() => { void loadData(); }, [passenger.id]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDni("");
    setRelation("");
    setPhone("");
    setLegalGuardian(false);
  }

  function startEdit(adult: AuthorizedAdult) {
    setEditingId(adult.id);
    setName(adult.name);
    setDni(adult.dni);
    setRelation(adult.relation);
    setPhone(adult.phone);
    setLegalGuardian(adult.legalGuardian);
  }

  async function write(request: Promise<Response>, done: string, failed: string) {
    try {
      const response = await request;
      if (response.ok) {
        setMessage(done);
        await loadData();
        return true;
      }
      setMessage(await readError(response, failed));
    } catch {
      setMessage("Unable to reach the server");
    }
    return false;
  }

  async function saveAdult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = { name, dni, relation, phone, legalGuardian };
    const saved = await write(
      editingId === null
        ? send(`/passengers/${passenger.id}/authorized-adults`, "POST", payload)
        : send(`/authorized-adults/${editingId}`, "PATCH", payload),
      editingId === null ? "Authorized adult saved" : "Authorized adult updated",
      "Unable to save authorized adult",
    );
    if (saved) resetForm();
  }

  async function saveConsent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await write(
      send(`/passengers/${passenger.id}/consent`, "POST", { signedByAdultId: Number(signerId), signedAt, otherAdultAllowed }),
      "Consent saved",
      "Unable to save consent",
    );
  }

  return <section aria-label="Authorized adults and consent">
    <h2>Authorized adults and consent: {passenger.name}</h2>
    <button type="button" onClick={onClose}>Close</button>
    {message && <p role="status">{message}</p>}
    <ul>{adults.map((adult) => <li key={adult.id}>
      <strong>{adult.name}</strong>{` - DNI ${adult.dni} - ${adult.relation} - ${adult.phone}`}
      {adult.legalGuardian ? " - Legal guardian" : ""}
      {" "}
      <button type="button" onClick={() => startEdit(adult)}>Edit adult</button>
      {" "}
      <button
        type="button"
        onClick={() => void write(send(`/authorized-adults/${adult.id}`, "DELETE"), "Authorized adult removed", "Unable to remove authorized adult")}
      >Remove adult</button>
    </li>)}</ul>
    <form onSubmit={(event) => void saveAdult(event)}>
      <h3>{editingId === null ? "New authorized adult" : "Edit authorized adult"}</h3>
      <label>Name<input name="adultName" maxLength={200} required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>DNI<input name="dni" maxLength={20} required value={dni} onChange={(e) => setDni(e.target.value)} /></label>
      <label>Relation<input name="relation" maxLength={100} required value={relation} onChange={(e) => setRelation(e.target.value)} /></label>
      <label>Phone<input name="phone" type="tel" maxLength={50} required value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <label>
        <input type="checkbox" name="legalGuardian" checked={legalGuardian} onChange={(e) => setLegalGuardian(e.target.checked)} />
        Legal guardian (signed the consent; only they can give a one-off authorization)
      </label>
      <button type="submit">{editingId === null ? "Save adult" : "Update adult"}</button>
      {editingId !== null && <button type="button" onClick={resetForm}>Cancel</button>}
    </form>
    <form onSubmit={(event) => void saveConsent(event)}>
      <h3>Consent</h3>
      <p>{consent ? `Signed by ${consent.signedByName} on ${consent.signedAt}` : "No consent recorded: this passenger cannot be assigned to a Recorrido."}</p>
      <label>
        Signed by
        <select name="signedByAdultId" required value={signerId} onChange={(e) => setSignerId(e.target.value)}>
          <option value="">Choose a legal guardian</option>
          {adults.filter((adult) => adult.legalGuardian).map((adult) => <option key={adult.id} value={adult.id}>{adult.name}</option>)}
        </select>
      </label>
      <label>Signed on<input type="date" name="signedAt" required value={signedAt} onChange={(e) => setSignedAt(e.target.value)} /></label>
      <label>
        <input type="checkbox" name="otherAdultAllowed" checked={otherAdultAllowed} onChange={(e) => setOtherAdultAllowed(e.target.checked)} />
        May be handed to another adult at home
      </label>
      <button type="submit">Save consent</button>
    </form>
  </section>;
}
