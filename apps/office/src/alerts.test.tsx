import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertList, ALERT_POLL_MS, startPolling, type Alert } from "./AlertsPage";
import { App } from "./App";
import { AuthorizationList, authorizationBody, consentSigner, type OneOffAuthorization } from "./OneOffAuthorizationPanel";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Synthetic data only.
const alert = (kind: string, details: Record<string, unknown>, extra: Partial<Alert> = {}): Alert => ({
  id: 1, kind, createdAt: "2026-10-23T12:00:00.000Z", transferId: 3, routeId: 9, markId: "00000000-0000-4000-8000-000000000001",
  passengerName: "Pasajero Sintético", driverName: "Chofer Sintético", details, resolution: null, ...extra,
});

describe("Oficina alert inbox", () => {
  it("asks the server for the alerts on open and every 15 seconds until it closes", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const stop = startPolling(load);
    expect(ALERT_POLL_MS).toBe(15_000);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(14_999);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("renders the inbox page at /alerts with the office navigation", () => {
    vi.stubGlobal("window", { location: { pathname: "/alerts" } });
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("<h1>Alerts</h1>");
    expect(markup).toContain('<a href="/alerts">Alerts</a>');
    expect(markup).toContain("Loading alerts...");
  });

  it("shows each alert with its Pasajero and Chofer, marking an authorised handover", () => {
    const handedOver = { name: "Tía Sintética", dni: "-3000001" };
    expect(renderToStaticMarkup(<AlertList alerts={[
      alert("other_adult_handover", { ...handedOver, authorized: true }),
      alert("other_adult_handover", { ...handedOver, authorized: false }, { id: 2 }),
      alert("mark_flagged", { reasons: ["transfer_moved", "consent_mismatch"] }, { id: 3 }),
    ]} />)).toBe(
      "<ul><li><time dateTime=\"2026-10-23T12:00:00.000Z\">09:00</time> Pasajero Sintético was handed to another adult, Tía Sintética (DNI -3000001) (Chofer Sintético) - authorised by an Autorización puntual</li>"
      + "<li><time dateTime=\"2026-10-23T12:00:00.000Z\">09:00</time> Pasajero Sintético was handed to another adult, Tía Sintética (DNI -3000001) (Chofer Sintético)</li>"
      + "<li><time dateTime=\"2026-10-23T12:00:00.000Z\">09:00</time> Marca accepted with a warning for Pasajero Sintético (Chofer Sintético): the Traslado had been moved, the Receptor does not match the Consentimiento</li></ul>",
    );
    expect(renderToStaticMarkup(<AlertList alerts={[]} />)).toBe("<p>No alerts.</p>");
  });

  it("lists the Pasajero's remaining Traslados of the day after an Ausente on an entrada, for the Oficina to decide", () => {
    const markup = renderToStaticMarkup(<AlertList alerts={[alert("absent_on_entrada", {
      remaining: [
        { transferId: 4, direction: "entrada", targetTime: "11:00", destinationName: "Escuela Sintética", originDestinationName: "Terapia Sintética" },
        { transferId: 5, direction: "salida", targetTime: "13:00", destinationName: "Escuela Sintética", originDestinationName: null },
      ],
    })]} />);
    expect(markup).toContain("Pasajero Sintético was marked Ausente on an entrada (Chofer Sintético). Decide about the rest of the day:"
      + "<ul><li>11:00 entrada, Terapia Sintética → Escuela Sintética</li><li>13:00 salida, Escuela Sintética → home</li></ul>");
    expect(renderToStaticMarkup(<AlertList alerts={[alert("absent_on_entrada", { remaining: [] })]} />)).toContain("No other Traslados today.");
  });

  it("Rule 2 (#83): shows an Ausente alert resolved by a Corrección as resolved, with who made it, when and why", () => {
    const remaining = [{ transferId: 5, direction: "salida", targetTime: "13:00", destinationName: "Escuela Sintética", originDestinationName: null }];
    const pending = renderToStaticMarkup(<AlertList alerts={[alert("absent_on_entrada", { remaining })]} />);
    expect(pending).toContain("Pasajero Sintético was marked Ausente on an entrada (Chofer Sintético). Decide about the rest of the day:");
    expect(pending).not.toContain("Resolved");

    const resolution = {
      markId: "00000000-0000-4000-8000-000000000002", kind: "subio", at: "2026-10-23T12:30:00.000Z", reason: "La escuela confirmó que viajó",
      author: { userId: 1, username: "oficina-sintetica", role: "office" },
    };
    const resolved = renderToStaticMarkup(<AlertList alerts={[alert("absent_on_entrada", { remaining }, { resolution })]} />);
    expect(resolved).toContain("Pasajero Sintético was marked Ausente on an entrada (Chofer Sintético).");
    expect(resolved).toContain("<div>Resolved by a Corrección to Subió by oficina-sintetica (office) at 09:30. Reason: La escuela confirmó que viajó</div>");
    expect(resolved).not.toContain("Decide about the rest of the day");
    expect(resolved).toContain("The rest of the day when it was raised:<ul><li>");
    const undone = renderToStaticMarkup(<AlertList alerts={[alert("absent_on_entrada", { remaining }, {
      resolution: { ...resolution, kind: "undo", at: "2026-10-23T12:01:00.000Z", reason: null, author: { userId: 4, username: "chofer-sintetico", role: "driver" } },
    })]} />);
    expect(undone).toContain("<div>Resolved by a Corrección that undid it by chofer-sintetico (driver) at 09:01</div>");
  });

  it("lists the Traslados still open when a Chofer could not close a Recorrido", () => {
    expect(renderToStaticMarkup(<AlertList alerts={[alert("close_refused", {
      transfers: [
        { transferId: 3, passengerName: "Pasajero Sintético", direction: "salida", status: "subio" },
        { transferId: 4, passengerName: "Pasajera Sintética", direction: "entrada", status: "planificado" },
      ],
    }, { transferId: null, markId: null, passengerName: null })]} />)).toBe(
      "<ul><li><time dateTime=\"2026-10-23T12:00:00.000Z\">09:00</time> Chofer Sintético tried to close Recorrido 9 with Traslados still open:"
      + "<ul><li>Pasajero Sintético: on board without Entregado</li><li>Pasajera Sintética: not marked</li></ul></li></ul>",
    );
    expect(renderToStaticMarkup(<AlertList alerts={[alert("mark_flagged", { reasons: ["route_closed"] })]} />))
      .toContain("Marca accepted with a warning for Pasajero Sintético (Chofer Sintético): the Recorrido was already closed");
  });
});

describe("Autorización puntual in the Plan diario", () => {
  it("sends only a call the Oficina made as outgoing and names who receives, never a place", () => {
    expect(authorizationBody({ legalGuardianId: "7", name: "Tía Sintética", dni: "-3000001", calledRegisteredPhone: true }))
      .toEqual({ legalGuardianId: 7, call: "outgoing", name: "Tía Sintética", dni: "-3000001" });
    expect(authorizationBody({ legalGuardianId: "7", name: "Tía Sintética", dni: "-3000001", calledRegisteredPhone: false }).call).toBe("incoming");
  });

  it("offers as Responsable legal only the adult who signed the Consentimiento", () => {
    const adults = [
      { id: 7, name: "Madre Sintética", phone: "381-000-0001" },
      { id: 8, name: "Padre Sintético", phone: "381-000-0002" },
    ];
    expect(consentSigner(adults, { signedByAdultId: 8 })).toEqual([{ id: 8, name: "Padre Sintético", phone: "381-000-0002" }]);
    expect(consentSigner(adults, null)).toEqual([]);
  });

  it("offers to revoke only an Autorización puntual still unused", () => {
    const item = (id: number, status: OneOffAuthorization["status"]): OneOffAuthorization => ({
      id, authorizedBy: { adultId: 7, name: "Madre Sintética" }, calledPhone: "381-000-0001", name: "Tía Sintética", dni: "-3000001",
      recordedAt: "2026-10-23T12:00:00.000Z", status,
    });
    const markup = renderToStaticMarkup(<AuthorizationList authorizations={[item(1, "valid"), item(2, "used")]} onRevoke={() => undefined} />);
    expect(markup).toBe(
      "<ul><li>Tía Sintética (DNI -3000001), authorised by Madre Sintética on 381-000-0001: valid<button type=\"button\">Revoke</button></li>"
      + "<li>Tía Sintética (DNI -3000001), authorised by Madre Sintética on 381-000-0001: used</li></ul>",
    );
  });
});
