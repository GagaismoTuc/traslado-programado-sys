import { markOrder } from "@traslado/shared";
import { useEffect, useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";
import { OfficeNav } from "./OfficeNav";

export type HistoryMark = {
  id: string;
  routeId: number;
  version: number;
  kind: "subio" | "ausente" | "entregado" | "undo";
  phoneTime: string;
  serverTime: string;
  receiver:
    | { kind: "authorized_adult"; adultId: number; name: string; relation: string }
    | { kind: "destination"; destinationId: number; name: string }
    | { kind: "other_adult"; name: string; dni: string; authorizationId: number | null }
    | { kind: "base_staff" }
    | null;
  flags: string[];
  corrects?: string;
  reason?: string;
  author: { userId: number; username: string; role: string };
};
export type TransferHistory = {
  transferId: number;
  status: string;
  versions: { routeId: number; version: number; publishedAt: string; publishedBy: string; driverName: string; pickupTime: string | null; dropoffTime: string | null }[];
  marks: HistoryMark[];
  changes: { action: string; before: unknown; after: unknown; occurredAt: string; actor: { userId: number | null; name: string | null } }[];
};

const KINDS: Record<HistoryMark["kind"], string> = { subio: "Subió", ausente: "Ausente", entregado: "Entregado", undo: "Undo" };
const when = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Tucuman", dateStyle: "short", timeStyle: "medium" });

/**
 * The Marca the Traslado follows now, as the server picks it: the last in `markOrder` (the history lists the Marcas in the
 * order the server stored them), that is not an undo and that no Corrección replaced. A Corrección that was undone no
 * longer replaces the Marca it corrected.
 */
export function markInForce(marks: HistoryMark[]) {
  const undone = new Set(marks.filter((mark) => mark.kind === "undo").map((mark) => mark.corrects));
  const replaced = new Set(marks.filter((mark) => mark.kind === "undo" || !undone.has(mark.id)).map((mark) => mark.corrects).filter(Boolean));
  return marks.map((mark, stored) => ({ mark, stored }))
    .filter(({ mark }) => mark.kind !== "undo" && !replaced.has(mark.id))
    .sort(markOrder(({ mark }) => mark.phoneTime, (a, b) => a.stored - b.stored)).at(-1)?.mark ?? null;
}

/** Who received the Pasajero, by name; never their DNI. */
function receiverLabel(receiver: NonNullable<HistoryMark["receiver"]>) {
  switch (receiver.kind) {
    case "authorized_adult": return `${receiver.name} (${receiver.relation})`;
    case "other_adult": return `${receiver.name} (another adult)`;
    case "destination": return `${receiver.name} (Destino)`;
    case "base_staff": return "company staff at the base";
  }
}

function markLine(mark: HistoryMark) {
  const corrects = mark.corrects ? ` - Corrección of ${mark.corrects}` : "";
  const receiver = mark.receiver ? `, Receptor: ${receiverLabel(mark.receiver)}` : "";
  return `${KINDS[mark.kind]}${receiver} by ${mark.author.username} (${mark.author.role}), phone ${when.format(new Date(mark.phoneTime))}, `
    + `server ${when.format(new Date(mark.serverTime))}${corrects}`;
}

/**
 * The Traslado's history and the Oficina's Corrección of the Marca in force, which always needs a reason. Entregado is
 * corrected here only by undoing it.
 */
export function TransferHistoryView({ history, onCorrect }: {
  history: TransferHistory; onCorrect: (markId: string, kind: string, reason: string) => void;
}) {
  const current = markInForce(history.marks);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    onCorrect(current!.id, String(values.get("kind")), String(values.get("reason")));
  }
  return <>
    <p>{`State now: ${history.status}`}</p>
    <h2>Planned times</h2>
    {history.versions.length
      ? <ul>{history.versions.map((item) => <li key={`${item.routeId}-${item.version}`}>
        {`Recorrido ${item.routeId} version ${item.version} (${item.driverName}), published by ${item.publishedBy} on ${when.format(new Date(item.publishedAt))}: `
          + `pickup ${item.pickupTime ?? "-"}, drop-off ${item.dropoffTime ?? "-"}`}
      </li>)}</ul>
      : <p>Never published.</p>}
    <h2>Marcas</h2>
    {history.marks.length
      ? <ul>{history.marks.map((mark) => <li key={mark.id}>
        {markLine(mark)}
        {mark.reason && <div>{`Reason: ${mark.reason}`}</div>}
        {mark.flags.length > 0 && <div>{`Flagged: ${mark.flags.join(", ")}`}</div>}
      </li>)}</ul>
      : <p>No Marcas.</p>}
    {current && <form onSubmit={submit}>
      <h3>{`Correct the Marca in force (${KINDS[current.kind]})`}</h3>
      <label>
        Corrected outcome
        <select name="kind" required>
          <option value="undo">Undo it</option>
          <option value="subio">Subió</option>
          <option value="ausente">Ausente</option>
        </select>
      </label>
      <label>Reason<textarea name="reason" required maxLength={1000} /></label>
      <button type="submit">Record Corrección</button>
    </form>}
    <h2>Changes</h2>
    {history.changes.length
      ? <ul>{history.changes.map((change, index) => <li key={index}>
        {`${change.action} by ${change.actor.name ?? "system"} on ${when.format(new Date(change.occurredAt))}: `
          + `${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`}
      </li>)}</ul>
      : <p>No changes.</p>}
  </>;
}

export function TransferHistoryPage({ id }: { id: number }) {
  const [history, setHistory] = useState<TransferHistory | null>(null);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await send(`/transfers/${id}/history`, "GET");
    if (await redirectUnauthorized(response)) return;
    if (!response.ok) return setMessage(await readError(response, "Unable to load the history"));
    setHistory(await response.json() as TransferHistory);
  }

  useEffect(() => { void load(); }, [id]);

  async function correct(markId: string, kind: string, reason: string) {
    const response = await send(`/marks/${markId}/corrections`, "POST", { kind, reason });
    if (await redirectUnauthorized(response)) return;
    setMessage(response.ok ? "Corrección recorded" : await readError(response, "Unable to record the Corrección"));
    await load();
  }

  return <main>
    <OfficeNav />
    <h1>{`Traslado ${id} history`}</h1>
    {message && <p role="status">{message}</p>}
    {history ? <TransferHistoryView history={history} onCorrect={(markId, kind, reason) => void correct(markId, kind, reason)} /> : <p>Loading...</p>}
  </main>;
}
