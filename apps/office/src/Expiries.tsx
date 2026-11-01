import { useEffect, useState } from "react";
import { redirectUnauthorized, send } from "./api";
import type { ExpiryItem, ExpiryPanel } from "./ExpiryBanner";
import { OfficeNav } from "./OfficeNav";

export function expiryLabel(item: Pick<ExpiryItem, "daysLeft">) {
  if (item.daysLeft === null) return "no date";
  if (item.daysLeft < 0) return "expired";
  if (item.daysLeft === 0) return "expires today";
  return `expires in ${item.daysLeft} ${item.daysLeft === 1 ? "day" : "days"}`;
}

function ownerLabel(item: ExpiryItem) {
  return `${item.owner.kind === "vehicle" ? "Vehículo" : "Chofer"} ${item.owner.label}`;
}

export function ExpiriesView({ panel }: { panel: ExpiryPanel }) {
  const line = (item: ExpiryItem) => <li key={item.id}>
    {`${ownerLabel(item)}: ${item.name}${item.expiresOn ? ` (${item.expiresOn})` : ""} - ${expiryLabel(item)}`}
  </li>;
  return <>
    <section>
      <h2>Expired or expiring within 30 days</h2>
      {panel.documents.length ? <ul>{panel.documents.map(line)}</ul> : <p>No document is expired or expiring within 30 days.</p>}
    </section>
    <section>
      <h2>No date</h2>
      {panel.undated.length ? <ul>{panel.undated.map(line)}</ul> : <p>Every document has a date.</p>}
    </section>
  </>;
}

export function ExpiriesPage() {
  const [panel, setPanel] = useState<ExpiryPanel | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await send("/expiries", "GET");
        if (await redirectUnauthorized(response)) return;
        if (!response.ok) setMessage("Unable to load Vencimientos");
        else setPanel(await response.json() as ExpiryPanel);
      } catch {
        setMessage("Unable to reach the server");
      }
    })();
  }, []);

  return <main>
    <h1>Vencimientos</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    {panel && <ExpiriesView panel={panel} />}
  </main>;
}
