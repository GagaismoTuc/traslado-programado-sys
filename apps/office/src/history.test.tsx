import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { markInForce, TransferHistoryView, type HistoryMark, type TransferHistory } from "./TransferHistoryPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Synthetic data only.
const chofer = { userId: 4, username: "chofer-sintetico", role: "driver" };
const oficina = { userId: 1, username: "oficina-sintetica", role: "office" };
const mark = (id: string, kind: HistoryMark["kind"], phoneTime: string, extra: Partial<HistoryMark> = {}): HistoryMark => ({
  id, routeId: 9, version: 2, kind, phoneTime, serverTime: phoneTime, receiver: null, flags: [], author: chofer, ...extra,
});
const subio = mark("00000000-0000-4000-8000-000000000001", "subio", "2026-10-23T12:00:00.000Z");
const ausente = mark("00000000-0000-4000-8000-000000000002", "ausente", "2026-10-23T12:01:00.000Z", { corrects: subio.id });
const office = mark("00000000-0000-4000-8000-000000000003", "subio", "2026-10-23T12:30:00.000Z", {
  corrects: ausente.id, reason: "La escuela confirmó que viajó", author: oficina,
});
const history: TransferHistory = {
  transferId: 3,
  status: "subio",
  versions: [
    { routeId: 9, version: 1, publishedAt: "2026-10-22T21:00:00.000Z", publishedBy: "oficina-sintetica", driverName: "Chofer Sintético", pickupTime: "07:20", dropoffTime: "07:55" },
    { routeId: 9, version: 2, publishedAt: "2026-10-23T10:00:00.000Z", publishedBy: "oficina-sintetica", driverName: "Chofer Sintético", pickupTime: "07:30", dropoffTime: "08:00" },
  ],
  marks: [subio, ausente, office],
  changes: [{ action: "assigned", before: { routeId: null }, after: { routeId: 9 }, occurredAt: "2026-10-22T20:00:00.000Z", actor: { userId: 1, name: "oficina-sintetica" } }],
};

describe("Traslado history", () => {
  it("shows the planned times per version, the Marcas and Correcciones with who made them and the changes with their actors", () => {
    const markup = renderToStaticMarkup(<TransferHistoryView history={history} onCorrect={() => undefined} />);
    expect(markup).toContain("Recorrido 9 version 1 (Chofer Sintético), published by oficina-sintetica on 22/10/2026, 18:00:00: pickup 07:20, drop-off 07:55");
    expect(markup).toContain("Recorrido 9 version 2 (Chofer Sintético), published by oficina-sintetica on 23/10/2026, 07:00:00: pickup 07:30, drop-off 08:00");
    expect(markup).toContain("Subió by chofer-sintetico (driver), phone 23/10/2026, 09:00:00, server 23/10/2026, 09:00:00</li>");
    expect(markup).toContain(`Ausente by chofer-sintetico (driver), phone 23/10/2026, 09:01:00, server 23/10/2026, 09:01:00 - Corrección of ${subio.id}`);
    expect(markup).toContain(`Subió by oficina-sintetica (office), phone 23/10/2026, 09:30:00, server 23/10/2026, 09:30:00 - Corrección of ${ausente.id}`);
    expect(markup).toContain("<div>Reason: La escuela confirmó que viajó</div>");
    expect(markup).toContain("assigned by oficina-sintetica on 22/10/2026, 17:00:00: {&quot;routeId&quot;:null} → {&quot;routeId&quot;:9}");

    vi.stubGlobal("window", { location: { pathname: "/transfers/3/history" } });
    expect(renderToStaticMarkup(<App />)).toContain("<h1>Traslado 3 history</h1>");
  });

  const entregado = (id: string, receiver: HistoryMark["receiver"]) => mark(id, "entregado", "2026-10-23T12:05:00.000Z", { receiver });
  const otherAdult = (id: string, dni: string | null) => entregado(id, { kind: "other_adult", name: "Tía Sintética", dni, authorizationId: null });
  const receivers = (marks: HistoryMark[]) => renderToStaticMarkup(<TransferHistoryView history={{ ...history, status: "entregado", marks }} onCorrect={() => undefined} />);

  it("Rule 3 (#95): shows an Adulto autorizado by name and relation without a DNI, and a Destino by name", () => {
    const markup = receivers([
      entregado("00000000-0000-4000-8000-000000000011", { kind: "authorized_adult", adultId: 7, name: "Madre Sintética", relation: "madre" }),
      entregado("00000000-0000-4000-8000-000000000013", { kind: "destination", destinationId: 2, name: "Escuela Sintética" }),
      entregado("00000000-0000-4000-8000-000000000014", { kind: "base_staff" }),
    ]);
    expect(markup).toContain("Entregado, Receptor: Madre Sintética (madre) by chofer-sintetico");
    expect(markup).toContain("Entregado, Receptor: Escuela Sintética (Destino) by chofer-sintetico");
    expect(markup).toContain("Entregado, Receptor: company staff at the base by chofer-sintetico");
    expect(markup).not.toContain("DNI");
  });

  it("Rule 1 (#95): shows another adult's masked DNI as the digits it ends in", () => {
    expect(receivers([otherAdult("00000000-0000-4000-8000-000000000012", "***456")]))
      .toContain("Entregado, Receptor: Tía Sintética (another adult), DNI terminado en 456 by chofer-sintetico");
  });

  it("Rule 2 (#95): says the DNI was recorded when too short to mask, and shows no DNI line when it is empty or null", () => {
    const markup = receivers([
      otherAdult("00000000-0000-4000-8000-000000000015", "***"),
      otherAdult("00000000-0000-4000-8000-000000000016", ""),
      otherAdult("00000000-0000-4000-8000-000000000017", null),
    ]);
    expect(markup).toContain("Entregado, Receptor: Tía Sintética (another adult), DNI registrado by chofer-sintetico");
    expect(markup.match(/Entregado, Receptor: Tía Sintética \(another adult\) by chofer-sintetico/g)).toHaveLength(2);
    expect(markup.match(/DNI/g)).toHaveLength(1);
  });

  it("#33: keeps the receiving driver visible in a Trasbordo's Entregado", () => {
    // Built from JSON, as the API returns it.
    const handover = JSON.parse(JSON.stringify({
      ...history, status: "entregado",
      marks: [mark("00000000-0000-4000-8000-000000000021", "entregado", "2026-10-23T12:05:00.000Z", {
        receiver: { kind: "driver", driverId: 7 },
      })],
    })) as TransferHistory;
    const markup = renderToStaticMarkup(<TransferHistoryView history={handover} onCorrect={() => undefined} />);
    expect(markup).toContain("Entregado, Receptor: driver 7 (Chofer receptor) by chofer-sintetico");
    expect(markup).not.toContain("undefined");
  });

  it("offers a Corrección of the Marca in force only, always with a required reason", () => {
    expect(markInForce(history.marks)).toBe(office);
    expect(markInForce([subio, mark("00000000-0000-4000-8000-000000000004", "undo", "2026-10-23T12:01:00.000Z", { corrects: subio.id })])).toBeNull();
    const markup = renderToStaticMarkup(<TransferHistoryView history={history} onCorrect={() => undefined} />);
    expect(markup).toContain("<h3>Correct the Marca in force (Subió)</h3>");
    expect(markup).toContain('<textarea name="reason" required="" maxLength="1000"></textarea>');
    expect(renderToStaticMarkup(<TransferHistoryView history={{ ...history, marks: [] }} onCorrect={() => undefined} />)).not.toContain("Record Corrección");
  });

  it("selects the newer in-force Marca when phone timestamps tie", () => {
    const phoneTime = "2026-10-23T12:00:00.000Z";
    const older = mark("00000000-0000-4000-8000-000000000001", "subio", phoneTime, { serverTime: "2026-10-23T12:00:01.000Z" });
    const latest = mark("00000000-0000-4000-8000-000000000002", "subio", phoneTime, { serverTime: "2026-10-23T12:00:02.000Z" });
    expect(markInForce([older, latest])).toBe(latest);
  });

  it("puts back in force the Marca a Corrección replaced when that Corrección is undone", () => {
    const undo = mark("00000000-0000-4000-8000-000000000005", "undo", "2026-10-23T12:02:00.000Z", { corrects: ausente.id });
    expect(markInForce([subio, ausente, undo])).toBe(subio);
  });
});
