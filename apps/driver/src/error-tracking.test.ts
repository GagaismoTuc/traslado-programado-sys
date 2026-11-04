import { describe, expect, it, vi } from "vitest";
import { createDriverErrorTracker } from "./error-tracking";

describe("driver error tracking SDK", () => {
  it("stays silent without a DSN and scrubs Pasajero, Receptor and GPS location data from outgoing envelopes", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const disabled = createDriverErrorTracker({ dsn: undefined, fetchImpl: fetchSpy });
    disabled.captureError(new Error("offline mark error"));
    await disabled.flush();
    expect(fetchSpy).not.toHaveBeenCalled();

    const envelopes: string[] = [];
    const tracker = createDriverErrorTracker({
      dsn: `https://${"b".repeat(32)}@glitchtip.example/_glitchtip/1`,
      environment: "test",
      fetchImpl: async (_input, init) => {
        const body = init?.body;
        envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const markAndPassengerPayload = {
      passengerName: "Pasajero Sintético Chofer",
      homeAddress: "Avenida Sintética 303",
      accessNotes: "Reja blanca al fondo",
      medicalAlert: "Alerta sintética: sensibilidad auditiva",
      receiverName: "Receptor Sintético Cuatro",
      receiverDni: "39.876.543",
      latitude: -26.8355,
      longitude: -65.2144,
      coords: [-65.2144, -26.8355],
    };

    tracker.addBreadcrumb({ category: "geolocation", message: "watchPosition", data: { lat: -26.8355, lng: -65.2144 } });
    tracker.captureError(
      new Error(`Driver mark sync failed: ${JSON.stringify(markAndPassengerPayload)} at https://chofer.example/driver/marks?token=synthetic-driver-token`),
      {
        mark: markAndPassengerPayload,
        headers: {
          Cookie: "session=synthetic-driver-cookie; remember_device=synthetic-driver-device",
          Authorization: "Bearer synthetic-driver-bearer",
        },
      },
    );

    await tracker.flush();
    expect(envelopes).toHaveLength(1);
    const envelopeText = envelopes[0]!;
    expect(envelopeText).toContain("Driver mark sync failed");
    expect(envelopeText).toContain('"app":"driver"');
    for (const forbidden of [
      "Pasajero Sintético Chofer", "Avenida Sintética 303", "Reja blanca al fondo", "sensibilidad auditiva",
      "Receptor Sintético Cuatro", "39.876.543", "39876543", "-26.8355", "-65.2144",
      "synthetic-driver-token", "synthetic-driver-cookie", "synthetic-driver-device", "synthetic-driver-bearer",
    ]) {
      expect(envelopeText).not.toContain(forbidden);
    }
  });

  it("redacts unstructured free text errors containing passenger names or addresses by default", async () => {
    const envelopes: string[] = [];
    const tracker = createDriverErrorTracker({
      dsn: `https://${"b".repeat(32)}@glitchtip.example/_glitchtip/1`,
      fetchImpl: async (_input, init) => {
        const body = init?.body;
        envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    tracker.captureError(new Error("Failed processing record: Synthetic Person, Example Avenue 19"));
    await tracker.flush();

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).not.toContain("Synthetic Person");
    expect(envelopes[0]).not.toContain("Example Avenue 19");
  });
});
