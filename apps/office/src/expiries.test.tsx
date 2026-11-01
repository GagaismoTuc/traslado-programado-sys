import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ExpiriesView } from "./Expiries";
import { bannerVisible, dismissalOf, ExpiryBannerView, type ExpiryItem, type ExpiryPanel } from "./ExpiryBanner";
import { DocumentWarnings } from "./PlanPage";
import { VehicleDetailPage } from "./VehicleDetailPage";

afterEach(() => vi.unstubAllGlobals());

// Synthetic data only.
const vtv = (id: number, plate: string, expiresOn: string | null, daysLeft: number | null): ExpiryItem => ({
  id, name: "VTV", expiresOn, daysLeft, owner: { kind: "vehicle", id, label: plate },
});
const carnet: ExpiryItem = {
  id: 9, name: "Carnet de manejo", expiresOn: "2026-11-05", daysLeft: 8, owner: { kind: "driver", id: 4, label: "Chofer Sintético" },
};
const panel: ExpiryPanel = {
  today: "2026-10-28",
  documents: [vtv(1, "AA001BB", "2026-10-27", -1), vtv(2, "AA002BB", "2026-10-28", 0), carnet, vtv(3, "AA003BB", "2026-11-20", 23)],
  undated: [{ id: 5, name: "Service", expiresOn: null, daysLeft: null, owner: { kind: "vehicle", id: 1, label: "AA001BB" } }],
};

describe("Vencimientos in the office app", () => {
  it("lists a document as valid through its date and expired from the next day in Tucumán local time", () => {
    const markup = renderToStaticMarkup(<ExpiriesView panel={panel} />);
    expect(markup).toContain(
      "<h2>Expired or expiring within 30 days</h2><ul>"
      + "<li>Vehículo AA001BB: VTV (2026-10-27) - expired</li>"
      + "<li>Vehículo AA002BB: VTV (2026-10-28) - expires today</li>"
      + "<li>Chofer Chofer Sintético: Carnet de manejo (2026-11-05) - expires in 8 days</li>"
      + "<li>Vehículo AA003BB: VTV (2026-11-20) - expires in 23 days</li></ul>",
    );
  });

  it("shows a document with no date in its own group, not counted as expired and without the banner", () => {
    const markup = renderToStaticMarkup(<ExpiriesView panel={panel} />);
    expect(markup).toContain("<h2>No date</h2><ul><li>Vehículo AA001BB: Service - no date</li></ul>");
    expect(markup.match(/<li>/g)).toHaveLength(5);
    expect(bannerVisible({ today: "2026-10-28", documents: [], undated: panel.undated }, null)).toBe(false);
  });

  it("shows a banner with how many documents are expired or expiring, linking to the panel, dismissed until the next day unless a new document enters", () => {
    expect(renderToStaticMarkup(<ExpiryBannerView count={panel.documents.length} onDismiss={() => undefined} />)).toBe(
      "<p role=\"alert\"><a href=\"/expiries\">4 documents are expired or expiring within 30 days</a> "
      + "<button type=\"button\">Dismiss until tomorrow</button></p>",
    );
    expect(bannerVisible(panel, null)).toBe(true);
    const dismissed = dismissalOf(panel);
    expect(bannerVisible(panel, dismissed)).toBe(false);
    expect(bannerVisible({ ...panel, today: "2026-10-29" }, dismissed)).toBe(true);
    expect(bannerVisible({ ...panel, documents: [...panel.documents, vtv(6, "AA006BB", "2026-11-25", 28)] }, dismissed)).toBe(true);
    expect(bannerVisible({ ...panel, documents: [{ ...carnet, expiresOn: "2026-11-10", daysLeft: 13 }] }, dismissed)).toBe(true);
    expect(bannerVisible({ ...panel, documents: panel.documents.slice(1) }, dismissed)).toBe(false);
  });

  it("warns naming the expired document of a Recorrido's Vehículo or Chofer without blocking it", () => {
    const routes = [{ id: 1, driverName: "Chofer Sintético", startTime: "07:00", endTime: "09:00" }];
    expect(renderToStaticMarkup(<DocumentWarnings routes={routes} warnings={[
      { routeId: 1, message: "Vehículo AA001BB: VTV expired on 2026-11-01" },
    ]} />)).toBe("<ul role=\"alert\"><li>Chofer Sintético 07:00-09:00: Vehículo AA001BB: VTV expired on 2026-11-01. It was not blocked.</li></ul>");
    expect(renderToStaticMarkup(<DocumentWarnings routes={routes} warnings={[]} />)).toBe("");
  });

  it("says when the expired documents could not be checked after a saved change", () => {
    expect(renderToStaticMarkup(<DocumentWarnings routes={[]} warnings={[]} unavailable />))
      .toBe("<p role=\"alert\">Saved, but expired documents could not be checked. Reload the plan to check them.</p>");
  });

  it("shows a Vehículo's plate, model, seats, Adaptaciones and documents in its detail view", () => {
    const markup = renderToStaticMarkup(<VehicleDetailPage
      id={1}
      initialVehicle={{ id: 1, plate: "AA001BB", model: "Furgón Sintético", seats: 8, front: 1, featureIds: [2], features: ["Rampa"], deactivatedAt: null }}
      initialDocuments={[{ id: 1, name: "VTV", expiresOn: "2026-10-27" }, { id: 2, name: "Service", expiresOn: null }]}
    />);
    expect(markup).toContain("<h1>Vehicle AA001BB</h1>");
    expect(markup).toContain(
      "<dl><dt>Plate</dt><dd>AA001BB</dd><dt>Model</dt><dd>Furgón Sintético</dd><dt>Seats</dt><dd>8 (front: 1)</dd>"
      + "<dt>Vehicle features</dt><dd>Rampa</dd></dl>",
    );
    expect(markup).toContain("<h2>Documents</h2>");
    expect(markup).toContain('name="documentName" value="VTV"');
    expect(markup).toContain('type="date" name="expiresOn" value="2026-10-27"');
    expect(markup).toContain('name="documentName" value="Service"');
    expect(markup).toContain("<span> No date</span>");
    for (const button of ["Save document", "Remove document", "Add document"]) expect(markup).toContain(button);
    expect(markup).not.toMatch(/type="file"/);
  });

  it("routes /vehicles/:id to the Vehículo detail view and /expiries to the Vencimientos panel, linked from the office navigation", () => {
    vi.stubGlobal("window", { location: { pathname: "/vehicles/7" } });
    const detail = renderToStaticMarkup(<App />);
    expect(detail).toContain("<h1>Vehicle</h1>");
    expect(detail).toContain('<a href="/expiries">Vencimientos</a>');
    vi.stubGlobal("window", { location: { pathname: "/expiries" } });
    expect(renderToStaticMarkup(<App />)).toContain("<h1>Vencimientos</h1>");
  });
});
