import { useEffect, useState } from "react";
import { redirectUnauthorized, send } from "./api";
import { DocumentsPanel, type DocumentItem } from "./DocumentsPanel";
import { OfficeNav } from "./OfficeNav";
import type { VehicleItem } from "./VehiclesPage";

/** One Vehículo's data (plate, model, seats, Adaptaciones) and its documents. */
export function VehicleDetailPage({ id, initialVehicle = null, initialDocuments }: {
  id: number;
  initialVehicle?: VehicleItem | null;
  initialDocuments?: DocumentItem[];
}) {
  const [vehicle, setVehicle] = useState<VehicleItem | null>(initialVehicle);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await send("/vehicles", "GET");
        if (await redirectUnauthorized(response)) return;
        const found = response.ok ? (await response.json() as { vehicles: VehicleItem[] }).vehicles.find((item) => item.id === id) : undefined;
        if (found) setVehicle(found);
        else setMessage(response.ok ? "Vehicle not found" : "Unable to load the vehicle");
      } catch {
        setMessage("Unable to reach the server");
      }
    })();
  }, [id]);

  return <main>
    <h1>{vehicle ? `Vehicle ${vehicle.plate}` : "Vehicle"}</h1>
    <OfficeNav />
    {message && <p role="status">{message}</p>}
    {vehicle && <>
      <dl>
        <dt>Plate</dt><dd>{vehicle.plate}</dd>
        <dt>Model</dt><dd>{vehicle.model}</dd>
        <dt>Seats</dt><dd>{`${vehicle.seats} (front: ${vehicle.front})`}</dd>
        <dt>Vehicle features</dt><dd>{vehicle.features.length ? vehicle.features.join(", ") : "None"}</dd>
        {vehicle.deactivatedAt && <><dt>Status</dt><dd>Deactivated</dd></>}
      </dl>
      <DocumentsPanel owner={{ kind: "vehicle", id: vehicle.id }} initialDocuments={initialDocuments} />
    </>}
  </main>;
}
