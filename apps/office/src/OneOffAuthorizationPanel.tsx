import { useEffect, useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";

type Guardian = { id: number; name: string; phone: string };
export type OneOffAuthorization = {
  id: number;
  authorizedBy: { adultId: number; name: string };
  calledPhone: string;
  name: string;
  dni: string;
  recordedAt: string;
  status: "valid" | "used" | "revoked" | "expired";
};

/** The body of an Autorización puntual: it names who receives, never a place, and counts only a call the Oficina made. */
export function authorizationBody(values: { legalGuardianId: string; name: string; dni: string; calledRegisteredPhone: boolean }) {
  return {
    legalGuardianId: Number(values.legalGuardianId),
    call: values.calledRegisteredPhone ? "outgoing" : "incoming",
    name: values.name,
    dni: values.dni,
  };
}

/** The Responsable legal is the Adulto autorizado who signed the Consentimiento; without one, nobody can authorise. */
export function consentSigner(adults: Guardian[], consent: { signedByAdultId: number } | null): Guardian[] {
  return adults.filter((adult) => adult.id === consent?.signedByAdultId);
}

export function AuthorizationList({ authorizations, onRevoke }: { authorizations: OneOffAuthorization[]; onRevoke: (id: number) => void }) {
  if (!authorizations.length) return <p>No Autorización puntual on this Traslado.</p>;
  return <ul>{authorizations.map((item) => <li key={item.id}>
    {`${item.name} (DNI ${item.dni}), authorised by ${item.authorizedBy.name} on ${item.calledPhone}: ${item.status}`}
    {item.status === "valid" && <button type="button" onClick={() => onRevoke(item.id)}>Revoke</button>}
  </li>)}</ul>;
}

/**
 * Autorizaciones puntuales of one salida whose Consentimiento does not allow another adult: the Oficina calls the
 * Responsable legal on their registered phone and records the one person they authorise.
 */
export function OneOffAuthorizationPanel({ transferId, passengerId }: { transferId: number; passengerId: number }) {
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [authorizations, setAuthorizations] = useState<OneOffAuthorization[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    const [adultsRes, consentRes, listRes] = await Promise.all([
      send(`/passengers/${passengerId}/authorized-adults`, "GET"),
      send(`/passengers/${passengerId}/consent`, "GET"),
      send(`/transfers/${transferId}/authorizations`, "GET"),
    ]);
    if (await redirectUnauthorized(adultsRes, consentRes, listRes)) return;
    if (!adultsRes.ok || !consentRes.ok || !listRes.ok) {
      setMessage("Unable to load the Autorizaciones puntuales");
      return;
    }
    const { consent } = await consentRes.json() as { consent: { signedByAdultId: number } | null };
    setGuardians(consentSigner((await adultsRes.json() as { adults: Guardian[] }).adults, consent));
    setAuthorizations((await listRes.json() as { authorizations: OneOffAuthorization[] }).authorizations);
  }

  useEffect(() => { void load(); }, [transferId, passengerId]);

  async function write(request: Promise<Response>, done: string) {
    const response = await request;
    if (await redirectUnauthorized(response)) return;
    setMessage(response.ok ? done : await readError(response, "Unable to save the Autorización puntual"));
    await load();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void write(send(`/transfers/${transferId}/authorizations`, "POST", authorizationBody({
      legalGuardianId: String(values.get("legalGuardianId")),
      name: String(values.get("name")),
      dni: String(values.get("dni")),
      calledRegisteredPhone: values.get("calledRegisteredPhone") === "on",
    })), "Autorización puntual recorded").then(() => form.reset());
  }

  return <section>
    <h3>Autorización puntual</h3>
    {message && <p role="status">{message}</p>}
    <AuthorizationList
      authorizations={authorizations}
      onRevoke={(id) => void write(send(`/authorizations/${id}/revocation`, "POST", {}), "Autorización puntual revoked")}
    />
    <form onSubmit={submit}>
      <label>
        Responsable legal
        <select name="legalGuardianId" required>
          {guardians.map((guardian) => <option key={guardian.id} value={guardian.id}>{`${guardian.name} (${guardian.phone})`}</option>)}
        </select>
      </label>
      <label><input type="checkbox" name="calledRegisteredPhone" />The Oficina called this registered phone (an incoming call does not count)</label>
      <label>Authorised person<input name="name" required maxLength={200} /></label>
      <label>DNI<input name="dni" required maxLength={20} /></label>
      <button type="submit">Record Autorización puntual</button>
    </form>
  </section>;
}
