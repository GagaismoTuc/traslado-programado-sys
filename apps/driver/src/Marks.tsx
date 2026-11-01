// Marks made with signal: the offline queue comes later, so a Marca that cannot reach the server keeps its UUID and is
// sent again by the Chofer.

// "undo" is only a Corrección of the Chofer's own last Marca.
export type MarkKind = "subio" | "ausente" | "entregado" | "undo";
export type Receiver =
  | { kind: "authorized_adult"; adultId: number }
  | { kind: "destination"; destinationId: number }
  | { kind: "other_adult"; name: string; dni: string; authorizationId?: number }
  | { kind: "base_staff" };
export type Location = { lat: number; lng: number } | null;
export type Mark = {
  id: string;
  transferId: number;
  kind: MarkKind;
  phoneTime: string;
  location: Location;
  version: number;
  receiver?: Receiver;
  // The UUID of the Marca this Corrección replaces.
  corrects?: string;
};
/** What the Chofer needs at a home drop-off, downloaded from the server; authorizations are only the valid ones. */
export type Handover = {
  transferId: number;
  otherAdultAllowed: boolean;
  adults: { id: number; name: string; relation: string }[];
  authorizations: { id: number; name: string; dni: string }[];
  base: { address: string } | null;
};
export type OtherAdult = { name: string; dni: string; adultConfirmed: boolean };

export const CALL_THE_OFFICE = "no entregues, llamá a la Oficina";

/** Builds a Marca once, so sending it again after a failure repeats its UUID and phone time. */
export function newMark(fields: Omit<Mark, "id" | "phoneTime">, now = new Date(), id: string = crypto.randomUUID()): Mark {
  return { id, phoneTime: now.toISOString(), ...fields };
}

/**
 * "Deshacer": a Corrección that takes back `mark`. The server accepts it when both phone times are within 2 minutes, so it
 * works without signal; later it answers to call the Oficina.
 */
export function undoMark(mark: Mark, version: number, location: Location, now = new Date(), id: string = crypto.randomUUID()): Mark {
  return newMark({ transferId: mark.transferId, kind: "undo", corrects: mark.id, location, version }, now, id);
}

function normalizeDni(value: string) {
  return value.replace(/[.\s]/g, "");
}

/**
 * The case table for handing the Pasajero to someone who is not an Adulto autorizado. With the Consentimiento allowing
 * another adult, name and DNI are enough (row 1). Otherwise only an Autorización puntual whose DNI matches the one typed
 * at the door, with the Chofer confirming the receiver is an adult, lets it through (row 4); anything else blocks
 * (rows 3, 5, 6 and 8). An Adulto autorizado (row 2) and company staff at the base are always allowed.
 */
export function otherAdultReceiver(handover: Pick<Handover, "otherAdultAllowed" | "authorizations">, typed: OtherAdult):
  { ok: true; receiver: Receiver } | { ok: false; message: string } {
  const name = typed.name.trim();
  const dni = typed.dni.trim();
  if (!name || !dni) return { ok: false, message: "Write the receiver's name and DNI" };
  if (handover.otherAdultAllowed) return { ok: true, receiver: { kind: "other_adult", name, dni } };
  if (!handover.authorizations.length) return { ok: false, message: CALL_THE_OFFICE };
  const authorization = handover.authorizations.find((item) => normalizeDni(item.dni) === normalizeDni(dni));
  if (!authorization) return { ok: false, message: `The DNI does not match the Autorización puntual: ${CALL_THE_OFFICE}` };
  if (!typed.adultConfirmed) return { ok: false, message: "Confirm the receiver is an adult" };
  return { ok: true, receiver: { kind: "other_adult", name, dni, authorizationId: authorization.id } };
}

/** The phone's position, or null when it is not available within the timeout: a Marca never waits for the GPS. */
export async function currentLocation(geolocation: Pick<Geolocation, "getCurrentPosition"> | undefined, timeoutMs = 5000): Promise<Location> {
  if (!geolocation) return null;
  return await new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export async function sendMark(apiUrl: string, routeId: number, mark: Mark) {
  return await fetch(`${apiUrl}/driver/routes/${routeId}/marks`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mark),
  });
}

export async function startRoute(apiUrl: string, routeId: number) {
  return await fetch(`${apiUrl}/driver/routes/${routeId}/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

/** Downloads the handover data again, never from a cache: "buscar autorización" uses it to get one just recorded. */
export async function fetchHandover(apiUrl: string, routeId: number, transferId: number) {
  return await fetch(`${apiUrl}/driver/routes/${routeId}/transfers/${transferId}/handover`, { credentials: "include", cache: "no-store" });
}

export type HandoverActions = {
  onReceiver: (receiver: Receiver) => void;
  onOtherAdult: (typed: OtherAdult) => void;
  onSearch: () => void;
};

/**
 * The home drop-off: the Adultos autorizados, another adult (blocked unless the Consentimiento or an Autorización
 * puntual allows it), "buscar autorización" and company staff at the base. `blocked` is the last refusal shown.
 */
export function HandoverView({ handover, blocked, searching, actions }: {
  handover: Handover; blocked: string | null; searching: boolean; actions: HandoverActions;
}) {
  const needsAuthorization = !handover.otherAdultAllowed;
  return <section>
    <h4>Who receives?</h4>
    <ul>{handover.adults.map((adult) => <li key={adult.id}>
      <button type="button" onClick={() => actions.onReceiver({ kind: "authorized_adult", adultId: adult.id })}>
        {`${adult.name} (${adult.relation})`}
      </button>
    </li>)}</ul>
    {needsAuthorization && !handover.authorizations.length && <p role="alert">{CALL_THE_OFFICE}</p>}
    {needsAuthorization && handover.authorizations.map((item) => <p key={item.id}>{`Autorización puntual: ${item.name}. Type the DNI shown to you at the door.`}</p>)}
    <form onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      actions.onOtherAdult({
        name: String(values.get("name") ?? ""), dni: String(values.get("dni") ?? ""), adultConfirmed: values.get("adultConfirmed") === "on",
      });
    }}>
      <label>Another adult<input name="name" maxLength={200} /></label>
      <label>DNI<input name="dni" maxLength={20} /></label>
      {needsAuthorization && <label><input type="checkbox" name="adultConfirmed" />The receiver is an adult</label>}
      <button type="submit">Hand to this adult</button>
    </form>
    {blocked && <p role="alert">{blocked}</p>}
    {needsAuthorization && <button type="button" disabled={searching} onClick={actions.onSearch}>Buscar autorización</button>}
    <button type="button" onClick={() => actions.onReceiver({ kind: "base_staff" })}>
      {handover.base ? `Company staff at the base (${handover.base.address})` : "Company staff at the base"}
    </button>
  </section>;
}
